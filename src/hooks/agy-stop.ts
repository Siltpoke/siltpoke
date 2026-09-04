// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Antigravity (agy) Stop hook entry — the process agy's
 * ~/.gemini/config/hooks.json "siltpoke-review".Stop handler invokes.
 *
 * agy's Stop hook is SYNCHRONOUS and BLOCKS the agent loop until this
 * process exits (an internal design note
 * design.md §3/§4) — unlike codex-stop.ts, which safely awaits the full
 * runHook -> handleStopHook pipeline (Brain call, critic tools, etc.) in
 * process because Codex tolerates that latency. agy does not: this file
 * must return control to agy FAST. So agy-stop.ts does NOT call runHook
 * itself. It normalizes the payload, hands it off to a DETACHED background
 * `bun src/hooks/on-stop.ts` process (the same fire-and-forget pattern
 * on-stop.ts already uses for daemon respawn — Bun.spawn(...).unref()), and
 * returns immediately. The detached child runs the real runHook ->
 * handleStopHook pipeline on its own time; agy never waits for it.
 *
 * Output contract: agy's hook protocol treats any stdout OTHER than
 * `{"decision":"continue"}` as "allow the agent to stop" — so the CLI entry
 * below always prints the literal `{}` right before exiting, whether or not
 * the background dispatch succeeded (fail-soft: a dispatch failure must
 * never block the user's agent loop).
 *
 * This file ships two ways (scripts/build-dist.ts's BUNDLES list), and the
 * dispatch target differs per way — see resolveOnStopTarget below.
 */
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { maybeRecordWhy } from "./why-index-wiring";

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve the on-stop dispatch target from the directory THIS module is
 * currently running from. Mirrors src/memory/distil-launcher.ts's
 * `basename(import.meta.dir) === "dist"` check — the exact same
 * ship-two-ways problem:
 *
 *   - BUNDLED (plugin install): scripts/build-dist.ts bundles this file into
 *     dist/agy-stop.js, landing in the SAME dist/ outdir as
 *     dist/siltpoke-stop.js (on-stop.ts's own bundle — see the BUNDLES
 *     list). The two are SIBLINGS in dist/, so the target is a plain
 *     filename join — no repo-root math, no `..` traversal to get wrong. A
 *     plugin cache ships no `src/`, so this MUST be the bundle, never the
 *     TypeScript source (the previous bug: it spawned the source path here,
 *     which doesn't exist in a plugin install, so the detached dispatch
 *     silently failed to spawn and review never fired).
 *   - SOURCE (dev install): bun runs src/hooks/agy-stop.ts directly, and
 *     src/hooks/on-stop.ts is its sibling in that same src/hooks/ directory
 *     — run straight off disk via bun, no build step needed.
 *
 * Exported so the dist/source split is unit-testable without touching a real
 * filesystem or import.meta.url.
 */
export function resolveOnStopTarget(hereDir: string): string {
  if (basename(hereDir) === "dist") {
    return join(hereDir, "siltpoke-stop.js");
  }
  return join(hereDir, "on-stop.ts");
}

/**
 * Map agy's camelCase Stop payload onto the event shape runHook/shouldFire
 * expect (session_id, transcript_path, cwd, hook_event_name, siltpoke_host).
 *
 * stop_event_timestamp_ms is still emitted (set to `executionNum`) for
 * payload back-compat, but it NO LONGER drives dedup: on-stop.ts now keys the
 * marker on session_id + a hash of the transcript CONTENT
 * (deriveStopMarkerKey), not on any timestamp. agy fires more than once per
 * turn (2x observed, same conversationId + transcriptPath, gap-verification
 * run 2026-07-10); both firings point at the same transcript, so both derive
 * the identical content hash → the same marker key → the duplicate is
 * suppressed. This is strictly more robust than the old executionNum proxy
 * (whose per-turn stability was an unresolved OPEN QUESTION): dedup now rides
 * on the transcript, which is provably identical across agy's double-fire.
 */
export function normalizeAgyStop(raw: string): string {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    input = {};
  }

  const transcriptPath =
    typeof input.transcriptPath === "string" ? input.transcriptPath : undefined;
  const sessionId =
    typeof input.conversationId === "string" ? input.conversationId : "antigravity";
  const workspacePaths = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];
  const cwd =
    typeof workspacePaths[0] === "string" ? (workspacePaths[0] as string) : process.cwd();
  const stopEventTimestampMs =
    typeof input.executionNum === "number" ? input.executionNum : undefined;

  return JSON.stringify({
    ...input,
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    siltpoke_host: "antigravity",
    stop_event_timestamp_ms: stopEventTimestampMs,
  });
}

/**
 * Spawn seam — mirrors on-stop.ts's DaemonSpawnFn but exposes a writable
 * stdin (the normalized JSON is piped in, not passed as an argv/env blob)
 * and an env override (forces SILTPOKE_SUPPRESSION_ENABLED=1 on the
 * detached child so the marker dedup above actually engages by default).
 */
export type AgyReviewSpawnFn = (
  cmd: string[],
  opts: {
    stdio: ["pipe", "ignore", "ignore"];
    env?: Record<string, string | undefined>;
  },
) => {
  stdin: { write(chunk: string): void; end(): void } | null;
  unref(): void;
};

function dispatchAgyReview(
  normalizedJson: string,
  onStopTarget: string,
  env: NodeJS.ProcessEnv,
  spawnFn?: AgyReviewSpawnFn,
): void {
  try {
    const spawn: AgyReviewSpawnFn = spawnFn ?? ((cmd, opts) => Bun.spawn(cmd, opts));
    const proc = spawn(["bun", onStopTarget], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...env, SILTPOKE_SUPPRESSION_ENABLED: env.SILTPOKE_SUPPRESSION_ENABLED ?? "1" },
    });
    if (proc.stdin) {
      proc.stdin.write(normalizedJson);
      proc.stdin.end();
    }
    proc.unref();
  } catch {
    // best-effort — the fire-and-forget dispatch must never block or crash
    // the fast-return hook (agy is waiting on this process to exit).
  }
}

export interface RunAgyStopHookOptions {
  rawJson: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Test seam: overrides the detected "directory this module is running
   * from" (normally `dirname(fileURLToPath(import.meta.url))`) that
   * resolveOnStopTarget uses to pick the source-vs-bundle dispatch target.
   */
  hereDir?: string;
  spawnFn?: AgyReviewSpawnFn;
}

/**
 * Testable entry point. Resolves as soon as the background dispatch is
 * requested — it does NOT wait for the spawned child to finish (that is the
 * whole point: agy is blocked on THIS process, not the review).
 */
export async function runAgyStopHook(
  opts: RunAgyStopHookOptions,
): Promise<{ normalized: string }> {
  const env = opts.env ?? process.env;
  const normalized = normalizeAgyStop(opts.rawJson);

  // Recursion guard (mirrors the AC4 guard codex-stop.ts inherits from
  // shouldFire/handleStopHook) — checked HERE, before spawning, so a
  // recursive invocation (e.g. a future AgyBrainProvider shelling out to
  // `agy -p`, which could itself trigger agy's own Stop hook) never spawns
  // a wasted child process in the first place.
  if (env.SILTPOKE_INTERNAL === "1") {
    return { normalized };
  }

  // Slice ④ task 3 — best-effort, NON-blocking WHY-index recording. This
  // file's whole reason to exist is returning control to agy FAST (see file
  // header: agy's Stop hook is SYNCHRONOUS and blocks the agent loop), so
  // maybeRecordWhy (fs + a git shell-out) must never be awaited here. The
  // detached child dispatched below (dispatchAgyReview → on-stop.ts →
  // handleStopHook) reliably records the same entry via its own host-aware
  // maybeRecordWhy call once it runs, so this is purely an opportunistic
  // duplicate — a `.catch` swallow, not a source of truth this file depends
  // on completing.
  try {
    const parsed = JSON.parse(normalized) as {
      cwd?: string;
      session_id?: string;
      transcript_path?: string;
    };
    if (parsed.cwd && parsed.session_id && parsed.transcript_path) {
      void maybeRecordWhy({
        cwd: parsed.cwd,
        sessionId: parsed.session_id,
        transcriptPath: parsed.transcript_path,
        host: "antigravity",
        stopTime: new Date().toISOString(),
      }).catch(() => {});
    }
  } catch {
    // best-effort — never block or crash the fast-return hook
  }

  const hereDir = opts.hereDir ?? dirname(fileURLToPath(import.meta.url));
  const onStopTarget = resolveOnStopTarget(hereDir);
  dispatchAgyReview(normalized, onStopTarget, env, opts.spawnFn);
  return { normalized };
}

/**
 * Emit agy's Stop-hook allow response. agy's hook protocol treats any stdout
 * OTHER than `{"decision":"continue"}` as "allow the agent to stop", so the
 * literal `{}` is the ONLY thing this ever writes — that empty object is what
 * ends the user's turn cleanly. This is the single highest-stakes byte
 * sequence in the file; extracted as a pure, testable function so a unit test
 * can pin the exact output and a future edit can't silently regress it into
 * (or toward) the turn-blocking `{"decision":"continue"}` string.
 */
export function writeStopResponse(out: { write(chunk: string): void } = process.stdout): void {
  out.write("{}");
}

if (import.meta.main) {
  try {
    const raw = await readStdinAll();
    await runAgyStopHook({ rawJson: raw });
  } catch {
    // fail-soft — never let a crash here block agy's loop
  } finally {
    writeStopResponse();
    process.exit(0);
  }
}
