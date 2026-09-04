// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Remaining-hosts track, Task 2: strips the pre-plugin siltpoke Stop/
// SessionStart entries a ccForkHostAdapter (src/installer/host-adapter.ts)
// wrote into a CC-fork host's (qoder/codebuddy) ~/.<host>/settings.json —
// same shape as removeCodexLegacyHooks (src/installer/codex-integration.ts)
// but for the Claude settings.json layout the CC-fork hosts share.
//
// TIDINESS not correctness: the marker-based dedupe gate
// (src/daemon/marker.ts, wired in src/hooks/on-stop.ts's claimStopMarker)
// already collapses two hook processes firing for the same Stop event to one
// Brain call, keyed on session_id + a hash of the transcript content —
// identical regardless of which settings.json entry invoked the process.
// This removal just keeps `~/.<host>/settings.json` free of a dead
// duplicate entry pointing at the source-install path.
import { readFile } from "node:fs/promises";
// ~/.<host>/settings.json holds the user's ENTIRE hook config, not just
// siltpoke's — a crash mid-write must never leave it half-written and
// corrupt. atomicWrite (tmp file + rename) matches how the codex sibling
// (codex-integration.ts's atomicWriteJson) and host-adapter.ts's own
// settings.json writers already persist these files.
import { atomicWrite } from "../utils/atomic-write";

const LEGACY_MARKERS = ["src/hooks/on-stop.ts", "src/hooks/handle-session-start.ts"] as const;

// registerStopHookPair (settings-mutator.ts) writes a PAIR per Stop hook: a
// curl fast-path entry (X-Siltpoke-Secret header, hits the daemon's
// /hooks/stop) alongside the `bun …/on-stop.ts` command entry above. The
// header string is unique to siltpoke's daemon curl hook — no foreign hook
// would carry it — so it's a safe, unambiguous marker for the other half of
// the pair that LEGACY_MARKERS alone misses.
const LEGACY_CURL_MARKER = "X-Siltpoke-Secret";

function keeps(command: string | undefined): boolean {
  if (!command) return true;
  if (command.includes(LEGACY_CURL_MARKER)) return false;
  return !LEGACY_MARKERS.some((m) => command.includes(m));
}

/**
 * Strip the pre-plugin siltpoke Stop/SessionStart entries a ccForkHostAdapter
 * wrote into a CC-fork's settings.json (source-path commands). Every foreign
 * hook is preserved. Fail-soft: missing/malformed file = silent no-op.
 */
export async function removeCcForkLegacyHooks(settingsPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  // JSON.parse("null") and JSON.parse('"a string"') both succeed (they are
  // valid JSON) but return a non-object — `!config.hooks` would then throw
  // "null is not an object" / read off a string, violating this function's
  // own fail-soft docstring. Same object-shape guard as the codex sibling
  // (agy-migration.ts's `typeof config !== "object" || config === null ||
  // Array.isArray(config)`).
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const config = parsed as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  if (!config.hooks) return;
  let changed = false;
  for (const event of ["Stop", "SessionStart"] as const) {
    const matchers = config.hooks[event];
    if (!Array.isArray(matchers)) continue;
    const next = matchers
      .map((m) => {
        const hooks = Array.isArray(m.hooks) ? m.hooks : [];
        const kept = hooks.filter((h) => keeps(h.command));
        if (kept.length !== hooks.length) changed = true;
        return { ...m, hooks: kept };
      })
      .filter((m) => (m.hooks ?? []).length > 0);
    if (next.length > 0) config.hooks[event] = next;
    else delete config.hooks[event];
  }
  if (!changed) return;
  try {
    atomicWrite(settingsPath, `${JSON.stringify(config, null, 2)}\n`);
  } catch {
    // best-effort — must never throw into a session (matches
    // removeCodexLegacyHooks's atomicWriteJson call site)
  }
}
