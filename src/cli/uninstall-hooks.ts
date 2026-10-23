// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { isSiltpokeDaemonStopEntry } from "../installer/settings-mutator";

/**
 * Taking siltpoke's hooks out of a host's file — `[61]` PR 2, plan P3.1 (spec
 * an internal design note §4, AC10).
 *
 * Pure: the file's text goes in, the new text comes out. Only siltpoke's
 * entries are removed, and only from the hook events; every other key is
 * written back as it was read. A file that cannot be parsed is never
 * rewritten — the caller reports it under "could not finish".
 *
 * Which entries are siltpoke's:
 *  - one whose own text names siltpoke (the curl to its daemon, codex's
 *    "Siltpoke …" status message) — with or without a receipt;
 *  - with a receipt: a command that runs a file in `<recorded root>/src/hooks/`.
 *    The whole folder path is matched, not the root alone: `/work/silt` is
 *    also the start of `/work/siltpoke-other` (review round 1);
 *  - a command with the shape of siltpoke's hook scripts, but only in a file
 *    where some entry names siltpoke. This is what takes the hook an EARLIER
 *    checkout left behind: a re-install from another folder replaces the curl
 *    entry and records only the new root. Stated cost: another tool's
 *    `…/src/hooks/on-stop.ts`, in a file that also holds siltpoke's curl
 *    entry, goes with it. The shape alone, with nothing naming siltpoke, is
 *    never enough.
 */

export type HookStrip =
  | { outcome: "removed"; next: string }
  | { outcome: "nothing" }
  /** The file is not a JSON object: never rewritten. */
  | { outcome: "unreadable" }
  /** The receipt's undo is of a type this version does not know. */
  | { outcome: "unknown-undo" };

/** The key siltpoke writes in Antigravity's name-keyed hooks.json (`host-adapter.ts`). */
const AGY_KEY = "siltpoke-review";
const HOOK_EVENTS = ["Stop", "SessionStart"] as const;
/** `<root>/src/hooks/<one of siltpoke's hook scripts>`, as the installs write it. */
const HOOK_SCRIPT = /[/\\]src[/\\]hooks[/\\](?:on-stop|codex-stop|agy-stop|handle-session-start)\.ts$/;

type Json = Record<string, unknown>;

type Rule = { type: "key"; key: string } | { type: "entries"; events: readonly string[]; root: string | null };

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The receipt's undo when there is one; otherwise what the id alone allows. */
function ruleFor(undo: Json | null, id: string): Rule | null {
  if (undo === null) {
    return id === "hook:antigravity" ? { type: "key", key: AGY_KEY } : { type: "entries", events: HOOK_EVENTS, root: null };
  }
  if (undo.type === "remove-json-key") return typeof undo.key === "string" ? { type: "key", key: undo.key } : null;
  if (undo.type !== "remove-hook-entries") return null;
  const events = Array.isArray(undo.events) ? undo.events.filter((e): e is string => typeof e === "string") : [];
  const root = typeof undo.match === "string" && undo.match.length > 0 ? undo.match : null;
  return { type: "entries", events, root };
}

function namesSiltpoke(h: unknown): boolean {
  if (isSiltpokeDaemonStopEntry(h)) return true;
  return isObject(h) && typeof h.statusMessage === "string" && h.statusMessage.startsWith("Siltpoke ");
}

/**
 * For a file that cannot be parsed and has no receipt: does its text carry
 * the one string only siltpoke writes? Enough to LIST the file — the removal
 * then reports it could not finish; nothing is rewritten on this evidence.
 */
export function textNamesSiltpoke(text: string, id: string): boolean {
  return text.includes(id === "hook:antigravity" ? `"${AGY_KEY}"` : "X-Siltpoke-Secret:");
}

/** Every hook entry under the rule's events, whatever matcher holds it. */
function entriesIn(hooks: Json, events: readonly string[]): unknown[] {
  return events.flatMap((event) => {
    const matchers = hooks[event];
    if (!Array.isArray(matchers)) return [];
    return matchers.flatMap((m) => (isObject(m) && Array.isArray(m.hooks) ? m.hooks : []));
  });
}

/** The test for one entry, fixed for one file. */
function oursIn(hooks: Json, rule: Extract<Rule, { type: "entries" }>): (h: unknown) => boolean {
  const named = entriesIn(hooks, rule.events).some(namesSiltpoke);
  // `<root>/src/hooks/`, in both separators; a trailing separator on the root is not doubled.
  const root = rule.root?.replace(/[/\\]+$/, "");
  // A root of "/" is no root at all: `/src/hooks/` is in every such path.
  const folders = root ? [`${root}/src/hooks/`, `${root}\\src\\hooks\\`] : [];
  return (h) => {
    if (namesSiltpoke(h)) return true;
    const command = isObject(h) && typeof h.command === "string" ? h.command : null;
    if (command === null) return false;
    return folders.some((f) => command.includes(f)) || (named && HOOK_SCRIPT.test(command));
  };
}

function parse(text: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One event's matchers without siltpoke's entries; null when nothing in it was siltpoke's. */
function stripEvent(matchers: unknown[], ours: (h: unknown) => boolean): unknown[] | null {
  let changed = false;
  const next: unknown[] = [];
  for (const m of matchers) {
    if (!isObject(m) || !Array.isArray(m.hooks)) {
      next.push(m);
      continue;
    }
    const kept = m.hooks.filter((h) => !ours(h));
    if (kept.length === m.hooks.length) next.push(m);
    else {
      changed = true;
      // A matcher that held only siltpoke's entries goes with them.
      if (kept.length > 0) next.push({ ...m, hooks: kept });
    }
  }
  return changed ? next : null;
}

function stripEntries(file: Json, rule: Extract<Rule, { type: "entries" }>): Json | null {
  if (!isObject(file.hooks)) return null;
  const ours = oursIn(file.hooks, rule);
  const hooks: Json = { ...file.hooks };
  let changed = false;
  for (const event of rule.events) {
    const matchers = hooks[event];
    if (!Array.isArray(matchers)) continue;
    const next = stripEvent(matchers, ours);
    if (next === null) continue;
    changed = true;
    if (next.length > 0) hooks[event] = next;
    else delete hooks[event];
  }
  if (!changed) return null;
  if (Object.keys(hooks).length > 0) return { ...file, hooks };
  const { hooks: _emptied, ...rest } = file;
  return rest;
}

/**
 * `text` without siltpoke's hooks. `undo` is the receipt entry's undo, or null
 * for a file found on disk with no receipt; `id` is the plan item's id.
 */
export function stripSiltpokeHooks(text: string, undo: Json | null, id: string): HookStrip {
  const file = parse(text);
  const rule = ruleFor(undo, id);
  if (rule === null) return { outcome: "unknown-undo" };
  if (file === null) return { outcome: "unreadable" };
  let next: Json | null;
  if (rule.type === "key") {
    if (!Object.hasOwn(file, rule.key)) return { outcome: "nothing" };
    const { [rule.key]: _ours, ...rest } = file;
    next = rest;
  } else next = stripEntries(file, rule);
  return next === null ? { outcome: "nothing" } : { outcome: "removed", next: `${JSON.stringify(next, null, 2)}\n` };
}

/** Does the file still hold a hook of siltpoke's? null when the file cannot be parsed. */
export function holdsSiltpokeHooks(text: string, undo: Json | null, id: string): boolean | null {
  const file = parse(text);
  const rule = ruleFor(undo, id);
  if (file === null || rule === null) return null;
  if (rule.type === "key") return Object.hasOwn(file, rule.key);
  if (!isObject(file.hooks)) return false;
  return entriesIn(file.hooks, rule.events).some(oursIn(file.hooks, rule));
}
