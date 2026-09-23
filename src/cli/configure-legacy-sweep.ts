// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The legacy Stop-hook sweep, split out of src/cli/configure.ts verbatim.
//
// Why it moved: configure.ts sat exactly at its file-length pin, so the ratchet
// (scripts/lint-file-length.ts) had it frozen — and by that script's own rule a
// pin may only move DOWN. Adding the bun-path record (defect [20]/[21])
// therefore meant shrinking the file first, and this block was the cleanest
// cut: three local types plus three pure functions, with no dependency on
// anything else in configure.ts.
//
// Behaviour is unchanged, byte for byte. `removeLegacyStopHook` is re-exported
// from configure.ts so existing importers and tests do not move.

interface HookEntry {
  type?: string;
  command?: string;
  url?: string;
  headers?: Record<string, string>;
}
interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}
export interface Settings {
  statusLine?: { type?: string; command?: unknown };
  hooks?: { Stop?: HookMatcher[] } & Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * True ONLY for Stop-hook entries a pre-plugin siltpoke install actually wrote.
 * The shapes are enumerated by the code that writes them —
 * installer/settings-mutator.ts (registerStopHookPair / buildStopCurlCommand):
 *
 *   1. `type: "http"` + a url ending in `/hooks/stop`  (oldest fast-path)
 *   2. a `curl … -H "X-Siltpoke-Secret: …" … /hooks/stop` command  (current fast-path)
 *   3. a command running `…/src/hooks/on-stop.ts`  (the Brain-call entry)
 *
 * We match on those STRUCTURAL anchors and nothing else.
 *
 * We deliberately do NOT match a bare "siltpoke" substring. It is not an anchor,
 * it is a coincidence: the word shows up in any path under a siltpoke checkout
 * or notes dir, so it silently deleted hooks that were never ours —
 *   `cd ~/dev/siltpoke && make lint-notify`      (the user's own hook)
 *   `otherpet --log ~/siltpoke-notes/x.log`      (another tool entirely)
 * — destroying user config with only the timestamped backup to fall back on.
 * An anchor has to be something ONLY our installer could have written.
 */
function isLegacySiltpokeStopEntry(h: HookEntry): boolean {
  const command = h.command ?? "";
  const url = h.url ?? "";

  // (1) the stale type:"http" entry — no `command` string at all.
  if (h.type === "http" && url.includes("/hooks/stop")) return true;

  // (2) the curl fast-path. Its unforgeable tell is our auth header (which the
  //     http entry also carried, in `headers`); the route is the corroborator.
  const secretInCommand = command.toLowerCase().includes("x-siltpoke-secret");
  const secretInHeaders = Object.keys(h.headers ?? {}).some(
    (k) => k.toLowerCase() === "x-siltpoke-secret",
  );
  if (secretInCommand || secretInHeaders) return true;
  if (command.startsWith("curl ") && command.includes("/hooks/stop")) return true;

  // (3) the Brain-call entry. `hooks/on-stop.ts` is OUR file name — this anchor
  //     is location-independent, so a fork cloned to any directory still matches.
  return command.includes("hooks/on-stop.ts");
}

/** Human-readable one-liner for a removed entry, for the warn log. */
function describeHookEntry(h: HookEntry): string {
  return h.command ?? h.url ?? JSON.stringify(h);
}

/**
 * The plugin's hooks.json now owns the Stop hook. A leftover settings.json entry
 * from a pre-plugin install would fire a SECOND review every turn — two Brain
 * calls, double spend. Strip ours; leave every other tool's Stop hook (and every
 * other hook event) exactly as it was.
 *
 * `onRemove` is called once per stripped entry: deleting lines from a file the
 * user owns must be VISIBLE, not something they reconstruct from a backup after
 * noticing their own hook stopped firing.
 *
 * Pure: the input object is never mutated.
 */
export function removeLegacyStopHook<T extends object>(
  settings: T,
  onRemove: (description: string) => void = () => {},
): T {
  const s = settings as Settings;
  const stop = s.hooks?.Stop;
  if (!Array.isArray(stop)) return settings;
  const kept = stop
    // Filter per HOOK, not per matcher: a matcher can hold our entry next to a
    // foreign one, and dropping the whole matcher would take the user's hook
    // down with it.
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter((h) => {
        if (!isLegacySiltpokeStopEntry(h)) return true;
        onRemove(describeHookEntry(h));
        return false;
      }),
    }))
    .filter((m) => (m.hooks ?? []).length > 0);
  return { ...settings, hooks: { ...s.hooks, Stop: kept } };
}
