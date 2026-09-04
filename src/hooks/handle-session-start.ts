// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * SessionStart hook handler.
 *
 * Captures the git HEAD SHA at the moment a Claude Code session begins and
 * writes it to {cwd}/.siltpoke/baseline.json. The Stop hook reads this file
 * first so it always diffs against the commit that was current at session
 * start, not the potentially-advanced HEAD after commits.
 *
 * Flow:
 *   SessionStart event → handleSessionStart({ cwd, session_id })
 *     → git rev-parse HEAD in cwd
 *     → writes {cwd}/.siltpoke/baseline.json { head_sha, session_id, captured_at }
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { removeAgyLegacyHooks } from "../installer/agy-migration";
import { removeCcForkLegacyHooks } from "../installer/ccfork-migration";
import { removeCodexLegacyHooks } from "../installer/codex-integration";
import {
  codexHooksJsonPath,
  hostSettingsJsonPath,
  resolveAgyHooksJsonPath,
  resolveCodebuddyHome,
  resolveQoderHome,
  siltpokeRoot,
} from "../installer/paths";
import { maybeLaunchDistilWorker } from "../memory/distil-launcher";
import { isSiltpokeInternal } from "../router/router";
import { stateDirFor, writeSessionBaseline } from "./session-baseline";

// Uses the shared lightweight resolver from ../installer/paths — that module
// imports only `node:path`, so pulling in siltpokeRoot here does not drag in
// handle-stop.ts's full brain/critic dependency graph. `../router/router` is
// likewise safe to import: it has ZERO imports of its own (pure predicates over
// a plain event/env), so taking `isSiltpokeInternal` from it adds no transitive
// weight to this hot hook — it is the router MODULE, not the router's graph.

export interface SessionStartInput {
  cwd: string;
  session_id: string;
  /** Optional for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Re-exported so existing importers keep their path. The shape and the
 * per-session storage layout live in `session-baseline.ts`, which both this
 * writer and the Stop-side readers share so they cannot drift apart again.
 */
export type { SessionBaseline } from "./session-baseline";

/**
 * One-time migration (track #9, Codex T3): once this SessionStart hook is
 * confirmed to be firing from the Codex plugin's OWN hooks.json — not the
 * legacy source-path install a pre-plugin `bun run setup --agent codex`
 * wrote — strip any stale `~/.codex/hooks.json` entry pointing at the
 * pre-plugin source paths (`removeCodexLegacyHooks`).
 *
 * This is TIDINESS, not a double-review correctness fix: the marker-based
 * dedupe gate (`src/daemon/marker.ts`, wired in `on-stop.ts`'s
 * `claimStopMarker`) already collapses two hook processes firing for the
 * same Stop event to one Brain call — it keys on session_id + a hash of the
 * transcript content, identical regardless of which hooks.json entry
 * invoked the process. Removing the legacy entry just keeps
 * `~/.codex/hooks.json` / `codex plugin list` free of a dead duplicate.
 *
 * Plugin-context detection: `SILTPOKE_HOST=codex` env var, set ONLY by
 * `hooks/codex-session-start.sh` — the one wrapper script the plugin's own
 * `hooks.json` declares — right before it invokes this file's bundled form.
 * Deliberately NOT a cwd-based check: an earlier version keyed off
 * `.codex-plugin/plugin.json` existing relative to `process.cwd()`, which
 * seemed to match Codex's plugin-root cwd convention (noted since Task 2)
 * but false-positived for the mundane case of a Claude Code session (or a
 * `bun test` run) working inside siltpoke's OWN repo checkout — that marker
 * file is a sibling of every file in this repo regardless of which host or
 * hook path is running, so it fired on ordinary dev sessions and stripped a
 * real, working `~/.codex/hooks.json` entry outside of any actual Codex
 * plugin context. The env var is scoped to the exact wrapper script
 * invocation and cannot collide with an unrelated session's cwd. The legacy
 * install invokes this same file directly via an absolute
 * `bun <repo>/src/hooks/handle-session-start.ts` command with no wrapper
 * script in between, so it never sets this var and safely no-ops, never
 * stripping the only entry actually wiring Siltpoke into Codex.
 *
 * Guarded by a once-ever `~/.siltpoke/.codex-migrated` marker (same pattern
 * as the plugin's `hooks/stop.sh` `.nudged` once-nudge) so the migration
 * runs at most once per machine. Fail-soft: every failure mode (missing
 * marker dir, unwritable home, malformed hooks.json) silently no-ops —
 * this must NEVER throw into or otherwise disrupt a Codex session.
 *
 * Remaining-hosts track (Task 2, twice-corrected): this function also sweeps
 * `~/.qoder/settings.json` / `~/.codebuddy/settings.json` for the same
 * pre-plugin siltpoke Stop/SessionStart entries a `ccForkHostAdapter` source
 * install wrote (`removeCcForkLegacyHooks`, `src/installer/ccfork-migration.ts`).
 * Same tidiness rationale as the Codex sweep above.
 *
 * The CC-fork sweep is NOT gated on `SILTPOKE_HOST === "codex"` — it runs on
 * ANY SessionStart (codex, CC, qoder, codebuddy alike), because the shared
 * `hooks/session-start.sh` wrapper qoder/codebuddy actually use never sets
 * that env var; nesting it inside the codex-only gate made the sweep
 * permanently inert for its real target hosts (caught in review #1).
 * `removeCcForkLegacyHooks` is safe to call unconditionally: fail-soft
 * (missing/malformed settings.json = silent no-op) and idempotent (only ever
 * strips siltpoke's own source-path-marked entries) — a no-op on a machine
 * without `~/.qoder`/`~/.codebuddy`.
 *
 * Task 7 adds a THIRD, equally independent sweep: `removeAgyLegacyHooks`
 * (`src/installer/agy-migration.ts`) strips the pre-plugin `siltpoke-review`
 * top-level key a `agyHostAdapter` source install (`writeAgyHooksJson`,
 * `src/installer/host-adapter.ts`) wrote into agy's
 * `~/.gemini/config/hooks.json`. Same tidiness rationale, same fail-soft
 * contract, and — like the CC-fork sweep — NOT gated on
 * `SILTPOKE_HOST === "codex"`: agy's own plugin-native Stop hook
 * (`hooks/agy-stop.sh` / the `.antigravity-plugin` manifest) does not set
 * that env var either, so gating this sweep on it would make it permanently
 * inert, same bug class as the CC-fork sweep's original mis-gate (review #1
 * on Task 2).
 *
 * CRITICAL: the codex sweep, the CC-fork sweep, and the agy sweep use THREE
 * INDEPENDENT once-markers (`.codex-migrated` / `.ccfork-migrated` /
 * `.agy-migrated`), NOT one shared marker (caught in review #2, Task 2 —
 * extended to the agy sweep here). A shared marker written unconditionally
 * after every sweep ran would let the FIRST SessionStart ever on a machine —
 * almost always non-codex, since `hooks/session-start.sh` covers CC/qoder/
 * codebuddy — write the marker without the codex branch (gated on
 * `SILTPOKE_HOST === "codex"`) ever running. A LATER genuine Codex session
 * would then see the marker already present and skip `removeCodexLegacyHooks`
 * forever on that machine — exactly the multi-host scenario this arc exists
 * for. Each sweep now gates on, and writes, only its OWN marker: the codex
 * marker is written if-and-only-if the codex branch actually ran (or the
 * host genuinely isn't codex, in which case it is correctly never written —
 * "not applicable" rather than "already done"); the CC-fork marker and the
 * agy marker are each written whenever their own sweep ran, independent of
 * host and independent of each other. No marker's presence can defeat any
 * other sweep.
 */
async function maybeMigrateLegacyCodexHooks(env: NodeJS.ProcessEnv): Promise<void> {
  const home = siltpokeRoot(env);

  if (env.SILTPOKE_HOST === "codex") {
    try {
      const codexMarker = join(home, ".codex-migrated");
      if (!existsSync(codexMarker)) {
        await removeCodexLegacyHooks(codexHooksJsonPath(env));
        await mkdir(home, { recursive: true });
        await writeFile(codexMarker, "");
      }
    } catch {
      // fail-soft — this migration must never break a Codex SessionStart,
      // and must not prevent the independent CC-fork sweep below from
      // running.
    }
  }

  try {
    const ccForkMarker = join(home, ".ccfork-migrated");
    if (!existsSync(ccForkMarker)) {
      await removeCcForkLegacyHooks(hostSettingsJsonPath(resolveQoderHome(env)));
      await removeCcForkLegacyHooks(hostSettingsJsonPath(resolveCodebuddyHome(env)));
      await mkdir(home, { recursive: true });
      await writeFile(ccForkMarker, "");
    }
  } catch {
    // fail-soft — this migration must never break SessionStart, and must
    // not prevent the independent agy sweep below from running.
  }

  try {
    const agyMarker = join(home, ".agy-migrated");
    if (!existsSync(agyMarker)) {
      await removeAgyLegacyHooks(resolveAgyHooksJsonPath(env));
      await mkdir(home, { recursive: true });
      await writeFile(agyMarker, "");
    }
  } catch {
    // fail-soft — this migration must never break SessionStart
  }
}

/**
 * First-run nudge for Codex plugin-native users. Emits a hook `systemMessage`
 * JSON field — the DOCUMENTED user-visible channel (unlike `additionalContext`,
 * which is model-context-only). Best-effort: the isolated T4 smoke on codex-cli
 * 0.143.0 could NOT confirm the message actually renders in the TUI, so treat
 * this as advisory — if it doesn't surface, the user still reaches setup via the
 * `siltpoke` skill (skill-discovery), which is the load-bearing path. The nudge
 * is a silent no-op when it doesn't display; it never blocks or errors.
 *
 * We point the user at the skill; we NEVER create the pet here (opt-in gate).
 * Returns the JSON string to print on stdout, or null to stay silent.
 * Marker-gated to fire once — mirrors hooks/stop.sh.
 */
export function codexFirstRunNudge(env: NodeJS.ProcessEnv): string | null {
  try {
    // Same recursion guard as handleSessionStart, for the same reason in a
    // different currency: this marker fires ONCE EVER, so burning it inside a
    // nested Brain-call session means the user's REAL session never sees the
    // nudge. A nested review turn has no user to nudge.
    if (isSiltpokeInternal(env)) return null;
    if (env.SILTPOKE_HOST !== "codex") return null;
    const root = siltpokeRoot(env);
    if (existsSync(join(root, "config.json"))) return null;
    const marker = join(root, ".codex-nudged");
    if (existsSync(marker)) return null;
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, "");
    if (!existsSync(marker)) return null; // unwritable home → stay silent, never nag
    return JSON.stringify({
      systemMessage:
        'Siltpoke is installed but has no pet yet — say "set up my Siltpoke pet" to create one and start reviews.',
    });
  } catch {
    return null; // never break SessionStart
  }
}

export async function handleSessionStart(input: SessionStartInput): Promise<void> {
  const env = input.env ?? process.env;

  // Recursion guard — the sibling of `shouldFire`'s, which the Stop hook has
  // had all along and this hook did not.
  //
  // Every Brain provider spawns its reviewer subprocess with
  // `SILTPOKE_INTERNAL: "1"`, and that nested host session fires its OWN
  // SessionStart in the SAME cwd.
  //
  // Which host paths this actually rescues (measured, not assumed): the
  // native-Claude-Code wrapper `hooks/session-start.sh` has NO guard, and the
  // qoder/codebuddy CC-fork source install wires this file directly with no
  // wrapper at all (`host-adapter.ts:105`) — those are the paths that were
  // broken, and the observed evidence (siltpoke + project-life-cycle, both
  // reviewed by `brain.ts`'s `claude -p`) comes from the first one.
  // `hooks/codex-session-start.sh:6` ALREADY short-circuits on the same env var
  // at the shell level, so a nested Codex review never reached this function —
  // for that host this guard is correct defense-in-depth, not the fix. agy
  // wires no SessionStart hook at all.
  //
  // Without this early-out the affected paths rewrote
  // `{cwd}/.siltpoke/baseline.json` with the nested session's throwaway
  // `session_id`; `resolveSessionHeadSha` matches on an EXACT `session_id`, so
  // from the first review onward the real session could no longer resolve its
  // own baseline, every `PendingCritique` enqueued with `created_sha: null`,
  // and the acted-on oracle abstained `no_baseline_sha` on all of them — no
  // learned rule was ever written, and forward-capture Phase 2 could never
  // finalize a candidate.
  //
  // Everything below is either per-real-session state (the baseline) or
  // once-per-real-session housekeeping (orphan flush, host migrations); none of
  // it is meaningful for a nested review turn, so the guard covers the whole
  // body rather than just the write.
  if (isSiltpokeInternal(env)) return;

  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: input.cwd, encoding: "utf8" });
  const head_sha = r.status === 0 ? r.stdout.trim() : null;

  // Keyed by session id, so a second real session in this same cwd cannot
  // blind the first one — see session-baseline.ts. The legacy single slot is
  // still written there for its direct readers.
  await writeSessionBaseline(input.cwd, {
    head_sha,
    session_id: input.session_id,
    captured_at: new Date().toISOString(),
  });

  const dir = stateDirFor(input.cwd);

  // Build-2 orphan flush: a prior session that ended without a subsequent
  // Stop-hook (e.g. crashed / force-quit) can leave pending critiques that
  // never got a chance to be swept. Launch the detached distil worker here
  // so they aren't stranded until this cwd's next Stop-hook — this hook
  // never sweeps inline, it only spawns (or no-ops if the queue is empty or
  // a worker already holds the lock). Guarded — must never break
  // SessionStart.
  const homeBase = siltpokeRoot(env);
  const stateBase = dir;
  await maybeLaunchDistilWorker(homeBase, stateBase, input.cwd).catch(() => {});

  // Codex T3 (track #9): once-ever tidiness migration off the legacy
  // ~/.codex/hooks.json entry — see maybeMigrateLegacyCodexHooks's docstring.
  // Fire-and-forget-safe: the function is already internally fail-soft, but
  // the outer .catch is defense in depth so SessionStart can never be broken
  // by this.
  await maybeMigrateLegacyCodexHooks(env).catch(() => {});
}

// ---------------------------------------------------------------------------
// Entry point for use as a Claude Code hook (stdin JSON event)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    const stdin = await Bun.stdin.text();
    let event: Record<string, unknown> = {};
    try {
      event = JSON.parse(stdin || "{}");
    } catch {
      // malformed stdin — proceed with empty event
    }
    await handleSessionStart({
      cwd: typeof event.cwd === "string" ? event.cwd : process.cwd(),
      session_id: typeof event.session_id === "string" ? event.session_id : "unknown",
    });

    const nudge = codexFirstRunNudge(process.env);
    if (nudge) process.stdout.write(`${nudge}\n`);
  } catch {
    // fail-soft — must never throw into or disrupt a SessionStart (e.g.
    // siltpokeRoot() throws PathError when HOME is unset/empty).
  }
}
