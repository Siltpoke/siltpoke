// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export interface SwapResult {
  next: Record<string, unknown>;
  oldStatusLineCommand: string | null;
}

interface StatusLine {
  type?: string;
  command?: unknown;
}

interface HookEntry {
  type?: string;
  command?: string;
  // http-style hook fields (optional, only present on http entries)
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}

interface Settings {
  statusLine?: StatusLine;
  hooks?: Record<string, HookMatcher[] | undefined>;
  [key: string]: unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asSettings(input: unknown): Settings {
  if (typeof input !== "object" || input === null) return {};
  return input as Settings;
}

export function swapStatusLine(
  input: unknown,
  wrapperCommand: string,
): SwapResult {
  const current = asSettings(input);
  const next = clone(current);
  const old =
    typeof next.statusLine?.command === "string"
      ? (next.statusLine?.command as string)
      : null;
  next.statusLine = { type: "command", command: wrapperCommand };
  return { next, oldStatusLineCommand: old };
}

export function restoreStatusLine(
  input: unknown,
  oldCommand: string | null,
): Record<string, unknown> {
  const next = clone(asSettings(input));
  if (oldCommand === null) {
    delete next.statusLine;
  } else {
    next.statusLine = { type: "command", command: oldCommand };
  }
  return next;
}

function findStopMatcher(
  matchers: HookMatcher[],
  hookCommand: string,
): { matcherIndex: number; hookIndex: number } | null {
  for (let i = 0; i < matchers.length; i++) {
    const hooks = matchers[i]?.hooks ?? [];
    for (let j = 0; j < hooks.length; j++) {
      if (
        hooks[j]?.type === "command" &&
        hooks[j]?.command === hookCommand
      ) {
        return { matcherIndex: i, hookIndex: j };
      }
    }
  }
  return null;
}

export function hasStopHook(
  input: unknown,
  hookCommand: string,
): boolean {
  const settings = asSettings(input);
  const matchers = settings.hooks?.Stop;
  if (!Array.isArray(matchers)) return false;
  return findStopMatcher(matchers, hookCommand) !== null;
}

export function registerStopHook(
  input: unknown,
  hookCommand: string,
): Record<string, unknown> {
  const next = clone(asSettings(input));
  if (hasStopHook(next, hookCommand)) return next;
  if (!next.hooks) next.hooks = {};
  const existing = next.hooks.Stop;
  const entry: HookMatcher = {
    matcher: "",
    hooks: [{ type: "command", command: hookCommand }],
  };
  next.hooks.Stop = Array.isArray(existing) ? [...existing, entry] : [entry];
  return next;
}

export function unregisterStopHook(
  input: unknown,
  hookCommand: string,
): Record<string, unknown> {
  const next = clone(asSettings(input));
  if (!Array.isArray(next.hooks?.Stop)) return next;
  const filtered = next
    .hooks?.Stop?.map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter(
        (h) => !(h.type === "command" && h.command === hookCommand),
      ),
    }))
    .filter((m) => (m.hooks ?? []).length > 0);
  if (filtered.length > 0) {
    next.hooks!.Stop = filtered;
  } else {
    delete next.hooks?.Stop;
    if (next.hooks && Object.keys(next.hooks).length === 0) {
      delete next.hooks;
    }
  }
  return next;
}

export interface StopHookPair {
  httpUrl: string;
  command: string;
  secret: string;
}

// Fast-path Stop hook: a silent curl POST to the daemon instead of a
// type:"http" entry. Claude Code prints its own red ECONNREFUSED for http
// entries when the daemon is down; a command entry with --silent, redirected
// output and `|| true` exits 0 with zero output — nothing to print (AC6).
// `--data-binary @-` forwards the hook's stdin JSON; the X-Siltpoke-Secret
// header preserves auth (AC8) — same daemon contract as the old http entry
// (src/daemon/routes/hooks.ts).
export function buildStopCurlCommand(httpUrl: string, secret: string): string {
  return (
    `curl --silent --max-time 5 -X POST ` +
    `-H "X-Siltpoke-Secret: ${secret}" -H "Content-Type: application/json" ` +
    `--data-binary @- ${httpUrl} >/dev/null 2>&1 || true`
  );
}

// Pre-track-#6 fast-path shape: type:"http" pointed at the daemon's
// /hooks/stop route. registerStopHookPair removes these on sight (migration,
// AC7) and hasStopHookPair treats their presence as "not installed" so a
// setup re-run takes the migration branch.
function isStaleHttpStopEntry(h: HookEntry): boolean {
  return (
    h.type === "http" &&
    typeof h.url === "string" &&
    h.url.includes("/hooks/stop")
  );
}

function isOurCurlEntry(h: HookEntry): boolean {
  return (
    h.type === "command" &&
    typeof h.command === "string" &&
    h.command.startsWith("curl ") &&
    h.command.includes("/hooks/stop")
  );
}

function isOurPairEntry(h: HookEntry, pair: StopHookPair): boolean {
  return (
    isStaleHttpStopEntry(h) ||
    isOurCurlEntry(h) ||
    (h.type === "command" && h.command === pair.command)
  );
}

export function registerStopHookPair(
  input: unknown,
  pair: StopHookPair,
): Record<string, unknown> {
  const next = clone(asSettings(input));
  if (!next.hooks) next.hooks = {};
  const existing = next.hooks.Stop;
  const matchers: HookMatcher[] = Array.isArray(existing) ? [...existing] : [];

  const curlEntry: HookEntry = {
    type: "command",
    command: buildStopCurlCommand(pair.httpUrl, pair.secret),
  };
  const cmdEntry: HookEntry = { type: "command", command: pair.command };

  // A matcher is "ours" if it contains any of our entries (old http shape,
  // curl fast-path, or the on-stop command).
  const ourIdx = matchers.findIndex((m) =>
    (m?.hooks ?? []).some((h) => isOurPairEntry(h, pair)),
  );
  // Migration sweep across ALL matchers: remove every stale http stop entry
  // (including historical duplicates) and any previous versions of our own
  // entries, so we re-insert exactly one fresh pair (AC7).
  const stripped = matchers.map((m) => ({
    ...m,
    hooks: (m?.hooks ?? []).filter((h) => !isOurPairEntry(h, pair)),
  }));
  if (ourIdx === -1) {
    stripped.push({ matcher: "", hooks: [curlEntry, cmdEntry] });
  } else {
    stripped[ourIdx] = {
      ...stripped[ourIdx],
      hooks: [...(stripped[ourIdx]?.hooks ?? []), curlEntry, cmdEntry],
    };
  }
  // Drop matchers left empty by the sweep (e.g. one that held only a stale
  // http duplicate).
  next.hooks.Stop = stripped.filter((m) => (m.hooks ?? []).length > 0);
  return next;
}

export function hasStopHookPair(
  input: unknown,
  pair: StopHookPair,
): boolean {
  const settings = asSettings(input);
  const matchers = settings.hooks?.Stop;
  if (!Array.isArray(matchers)) return false;
  // Any lingering old http entry ⇒ NOT installed, so install.ts's
  // already-installed early-return does not fire before migration (AC7).
  for (const m of matchers) {
    if ((m?.hooks ?? []).some(isStaleHttpStopEntry)) return false;
  }
  const curlCommand = buildStopCurlCommand(pair.httpUrl, pair.secret);
  for (const m of matchers) {
    const hooks = m?.hooks ?? [];
    const curlOk = hooks.some(
      (h) => h.type === "command" && h.command === curlCommand,
    );
    const cmdOk = hooks.some(
      (h) => h.type === "command" && h.command === pair.command,
    );
    if (curlOk && cmdOk) return true;
  }
  return false;
}

export function unregisterStopHookPair(
  input: unknown,
  pair: StopHookPair,
): Record<string, unknown> {
  const next = clone(asSettings(input));
  if (!Array.isArray(next.hooks?.Stop)) return next;
  const cleaned = next
    .hooks?.Stop?.map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter((h) => !isOurPairEntry(h, pair)),
    }))
    .filter((m) => (m.hooks ?? []).length > 0);
  if (cleaned.length > 0) {
    next.hooks!.Stop = cleaned;
  } else {
    delete next.hooks?.Stop;
    if (next.hooks && Object.keys(next.hooks).length === 0) {
      delete next.hooks;
    }
  }
  return next;
}
