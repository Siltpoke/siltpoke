// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Remaining-hosts track, Task 7: strips the pre-plugin `siltpoke-review`
// top-level key a `agyHostAdapter` source install (writeAgyHooksJson,
// src/installer/host-adapter.ts) wrote into agy's
// ~/.gemini/config/hooks.json — same shape as removeCodexLegacyHooks
// (src/installer/codex-integration.ts) and removeCcForkLegacyHooks
// (src/installer/ccfork-migration.ts), but agy's hooks.json is a FLAT
// name-keyed map (`{ "<name>": { Stop: [...] }, ... }`), not a
// matcher-array — so the sweep is a single top-level key delete rather than
// a per-entry command-match filter.
//
// TIDINESS not correctness: the marker-based dedupe gate
// (src/daemon/marker.ts, wired in src/hooks/on-stop.ts's claimStopMarker)
// already collapses two hook processes firing for the same Stop event to
// one Brain call, keyed on session_id + a hash of the transcript content —
// identical regardless of which hooks.json entry invoked the process. This
// removal just keeps `~/.gemini/config/hooks.json` free of a dead duplicate
// entry pointing at the source-install path.
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../utils/atomic-write";

const AGY_HOOK_NAME = "siltpoke-review";

/**
 * Delete the pre-plugin `siltpoke-review` key from agy's
 * ~/.gemini/config/hooks.json. Every other named hook (foreign tools, or
 * anything else the user registered) is preserved untouched. Fail-soft:
 * missing/malformed hooks.json = silent no-op, never a throw.
 */
export async function removeAgyLegacyHooks(hooksPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(hooksPath, "utf8");
  } catch {
    return;
  }
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return;
  if (!(AGY_HOOK_NAME in config)) return;
  const { [AGY_HOOK_NAME]: _dropped, ...next } = config;
  try {
    atomicWrite(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort — must never throw into a session (matches
    // removeCodexLegacyHooks / removeCcForkLegacyHooks call sites)
  }
}
