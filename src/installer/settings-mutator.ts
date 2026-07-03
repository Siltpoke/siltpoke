// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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

function findOurPairMatcher(
  matchers: HookMatcher[],
  pair: StopHookPair,
): number {
  // A matcher is "ours" if it contains either our http url OR our command.
  for (let i = 0; i < matchers.length; i++) {
    const hooks = matchers[i]?.hooks ?? [];
    const matchesHttp = hooks.some(
      (h) => h.type === "http" && h.url === pair.httpUrl,
    );
    const matchesCmd = hooks.some(
      (h) => h.type === "command" && h.command === pair.command,
    );
    if (matchesHttp || matchesCmd) return i;
  }
  return -1;
}

export function registerStopHookPair(
  input: unknown,
  pair: StopHookPair,
): Record<string, unknown> {
  const next = clone(asSettings(input));
  if (!next.hooks) next.hooks = {};
  const existing = next.hooks.Stop;
  const matchers: HookMatcher[] = Array.isArray(existing) ? [...existing] : [];

  const httpEntry: HookEntry = {
    type: "http",
    url: pair.httpUrl,
    headers: { "X-Siltpoke-Secret": pair.secret },
    timeout: 5,
  };
  const cmdEntry: HookEntry = { type: "command", command: pair.command };

  const ourIdx = findOurPairMatcher(matchers, pair);
  if (ourIdx === -1) {
    matchers.push({ matcher: "", hooks: [httpEntry, cmdEntry] });
  } else {
    const current = matchers[ourIdx]?.hooks ?? [];
    // Remove any of our previous entries (so we can re-append fresh / update secret).
    const filtered = current.filter(
      (h) =>
        !(h.type === "http" && h.url === pair.httpUrl) &&
        !(h.type === "command" && h.command === pair.command),
    );
    matchers[ourIdx] = {
      ...matchers[ourIdx],
      hooks: [...filtered, httpEntry, cmdEntry],
    };
  }
  next.hooks.Stop = matchers;
  return next;
}

export function hasStopHookPair(
  input: unknown,
  pair: StopHookPair,
): boolean {
  const settings = asSettings(input);
  const matchers = settings.hooks?.Stop;
  if (!Array.isArray(matchers)) return false;
  for (const m of matchers) {
    const hooks = m?.hooks ?? [];
    const httpOk = hooks.some(
      (h) =>
        h.type === "http" &&
        h.url === pair.httpUrl &&
        h.headers?.["X-Siltpoke-Secret"] === pair.secret,
    );
    const cmdOk = hooks.some(
      (h) => h.type === "command" && h.command === pair.command,
    );
    if (httpOk && cmdOk) return true;
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
      hooks: (m.hooks ?? []).filter(
        (h) =>
          !(h.type === "http" && h.url === pair.httpUrl) &&
          !(h.type === "command" && h.command === pair.command),
      ),
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
