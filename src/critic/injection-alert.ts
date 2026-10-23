// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Prompt-injection alert [B]: turn the model's own `injection_suspected` report
 * and the reviewer's recorded tool calls into one alert. Pure apart from one
 * read-only I/O exception: `classifyPath` resolves symlinks (`realpathSync`) so a
 * link inside the project that points outside is caught. `projectRoot` and
 * `home` are parameters.
 *
 * Loud = a self report, or a read outside the project root that is not an
 * agent-own folder. Agent-own folder read = quiet. Quoted text is untrusted:
 * surfaces must escape it.
 */
import { realpathSync } from "node:fs";
import { posix } from "node:path";
import type { InjectionSuspectedItem } from "../brain/schema.ts";
import type { ToolCallRecord, ToolCallsField } from "../brain/tool-calls.ts";

export interface InjectionSignal {
  kind: "self" | "tool" | "echo" | "scan";
  level: "loud" | "quiet";
  where: string;
  quote: string;
  why: string;
}

export interface InjectionAlert {
  level: "loud" | "quiet";
  signals: InjectionSignal[];
  toolRecord: "recorded" | "not_recorded";
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Every self report is loud; flags a quote the reviewer did not actually read. */
export function selfSignals(items: InjectionSuspectedItem[] | undefined, readText: string): InjectionSignal[] {
  if (!items || items.length === 0) return [];
  const haystack = collapse(readText);
  return items.map((it) => ({
    kind: "self",
    level: "loud",
    where: it.where,
    quote: it.quote,
    why: haystack.includes(collapse(it.quote)) ? it.why : `${it.why} (quote not found in the text siltpoke gave it)`,
  }));
}

const AGENT_OWN_DIRS = [".codex", ".claude", ".gemini"];

function expandHome(p: string, home: string): string {
  if (p === "~" || p.startsWith("~/")) return home + p.slice(1);
  const m = /^\$(?:\{HOME\}|HOME)(?=\/|$)/.exec(p);
  return m ? home + p.slice(m[0].length) : p;
}

const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * `p` (absolute) with symlinks resolved. A path that does not exist (a blocked or
 * failed read) resolves its nearest existing parent and re-appends the rest;
 * when nothing resolves, the lexical path is returned.
 */
function realish(p: string): string {
  const rest: string[] = [];
  for (let head = p; ; head = posix.dirname(head)) {
    try {
      return posix.join(realpathSync(head), ...rest);
    } catch {
      if (posix.dirname(head) === head) return p;
      rest.unshift(posix.basename(head));
    }
  }
}

/**
 * Where `path` lands. A relative `path` resolves against `reviewerCwd` — the cwd the
 * reviewer's tools really ran in, which is not always the project root (default: the root).
 */
export function classifyPath(
  path: string,
  projectRoot: string,
  home: string,
  reviewerCwd: string = projectRoot,
): "inside" | "agent-own" | "outside" {
  const abs = realish(posix.resolve(reviewerCwd, expandHome(path, home)));
  if (within(abs, realish(posix.resolve(projectRoot)))) return "inside";
  const h = posix.resolve(home);
  if (AGENT_OWN_DIRS.some((d) => within(abs, realish(posix.join(h, d))))) return "agent-own";
  return "outside";
}

const isPathLike = (w: string): boolean => /^(\/|~|\$HOME|\$\{HOME\}|\.\.)/.test(w) || w.includes("/../");

interface ShellWord {
  text: string;
  /** True for the program word of a simple command (first word, or first after `;` `&` `|` `(` `)` newline). */
  start: boolean;
  /** True for the target of an output redirect (`>` `>>` `>|` `2>` `2>>` `&>` `>&`): written, not read. */
  write: boolean;
}

const escapable = (ch: string): boolean => ch === '"' || ch === "\\";

/** The text of the quoted run opening at `open`, and the index of its closing quote (or the end). */
function readQuoted(cmd: string, open: number): { text: string; end: number } {
  const quote = cmd.charAt(open);
  let text = "";
  let i = open + 1;
  for (; i < cmd.length && cmd.charAt(i) !== quote; i++) {
    if (quote === '"' && cmd.charAt(i) === "\\" && escapable(cmd.charAt(i + 1))) i++;
    text += cmd.charAt(i);
  }
  return { text, end: i };
}

/** Index of the last character of an output-redirect operator starting at `i` (`>` `>>` `>|` `>&` `&>` `&>>`), or -1. */
function outRedirectEnd(cmd: string, i: number): number {
  const ch = cmd.charAt(i);
  if (ch !== ">" && !(ch === "&" && cmd.charAt(i + 1) === ">")) return -1;
  let j = ch === "&" ? i + 1 : i;
  while (j + 1 < cmd.length && ">|&".includes(cmd.charAt(j + 1))) j++;
  return j;
}

/**
 * Split a shell command into words: quotes stripped, operators end words, redirects split without
 * starting a command. An fd number before a redirect (`2>`) is dropped; the word after an output
 * redirect is marked `write`. The word after `<` is an ordinary word (a read).
 */
function shellWords(cmd: string): ShellWord[] {
  const words: ShellWord[] = [];
  let cur = "";
  let has = false;
  let start = true;
  let write = false;
  const flush = (): void => {
    if (has) {
      words.push({ text: cur, start: start && !write, write });
      if (!write) start = false;
      write = false;
    }
    cur = "";
    has = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd.charAt(i);
    if (ch === '"' || ch === "'") {
      const q = readQuoted(cmd, i);
      cur += q.text;
      i = q.end;
      has = true;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd.charAt(++i);
      has = true;
    } else if (ch === "<" || outRedirectEnd(cmd, i) >= 0) {
      if (/^\d+$/.test(cur)) has = false; // `2>`: the fd number is not a word
      flush();
      if (ch !== "<") {
        i = outRedirectEnd(cmd, i);
        write = true;
      }
    } else if (/\s/.test(ch)) {
      flush();
      if (ch === "\n") start = true;
    } else if (";&|()".includes(ch)) {
      flush();
      write = false;
      start = true;
    } else {
      cur += ch;
      has = true;
    }
  }
  flush();
  return words;
}

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** Commands whose arguments are printed, never opened. */
const PURE_OUTPUT: ReadonlySet<string> = new Set(["echo", "printf"]);
const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const MAX_WRAP_DEPTH = 3;

/**
 * Path-like words from a shell command; quotes stripped. The program word of each
 * simple command is never a target; `sh|bash|zsh -c '<inner>'` is scanned recursively.
 * Output-redirect targets and the arguments of `echo`/`printf` are not reads.
 */
export function pathsInCommand(command: string, depth = 0): string[] {
  if (depth > MAX_WRAP_DEPTH) return [];
  const groups: { prog: string; args: ShellWord[] }[] = [];
  for (const w of shellWords(command)) {
    if (w.start) groups.push({ prog: posix.basename(w.text), args: [] });
    else if (groups.length === 0) groups.push({ prog: "", args: [w] });
    else groups[groups.length - 1]?.args.push(w);
  }
  const direct = groups.flatMap((g) => argPaths(g.prog, g.args, depth));
  if (!groups.some((g) => PURE_OUTPUT.has(g.prog))) return direct;
  // echo/printf print their arguments, but a substitution inside them still runs.
  const seen = new Set(direct);
  const hidden = substitutionBodies(command)
    .flatMap((body) => pathsInCommand(body, depth + 1))
    .filter((p) => !seen.has(p));
  return [...new Set([...direct, ...hidden])];
}

/**
 * Bodies of every backtick and `$(…)` substitution outside single quotes. An unterminated one
 * runs to the end of the command. Nested substitutions come out when the body is scanned again.
 */
function substitutionBodies(cmd: string): string[] {
  const bodies: string[] = [];
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd.charAt(i);
    if (ch === "\\") i += 2;
    else if (ch === "'") i = skipSingleQuoted(cmd, i);
    else if (ch === "`" || (ch === "$" && cmd.charAt(i + 1) === "(")) {
      const sub = readSubstitution(cmd, i);
      bodies.push(sub.body);
      i = sub.next;
    } else i++;
  }
  return bodies;
}

/** Index after the single-quoted region opening at `at` (end of string if unterminated). */
function skipSingleQuoted(cmd: string, at: number): number {
  const close = cmd.indexOf("'", at + 1);
  return close < 0 ? cmd.length : close + 1;
}

/** The substitution starting at `at` (a backtick or `$(`): its body and the index after it. */
function readSubstitution(cmd: string, at: number): { body: string; next: number } {
  let j: number;
  if (cmd.charAt(at) === "`") {
    j = at + 1;
    while (j < cmd.length && cmd.charAt(j) !== "`") j += cmd.charAt(j) === "\\" ? 2 : 1;
    return { body: cmd.slice(at + 1, j), next: j + 1 };
  }
  j = at + 2;
  for (let depth = 1; j < cmd.length; j++) {
    const c = cmd.charAt(j);
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    if (depth === 0) break;
  }
  return { body: cmd.slice(at + 2, j), next: j + 1 };
}

/** Path-like arguments of one simple command (program word already removed). */
function argPaths(prog: string, args: ShellWord[], depth: number): string[] {
  if (PURE_OUTPUT.has(prog)) return [];
  const wrapper = SHELLS.has(prog);
  const out: string[] = [];
  let innerNext = false;
  for (const w of args) {
    if (w.write) continue;
    if (innerNext) {
      out.push(...pathsInCommand(w.text, depth + 1));
      innerNext = false;
    } else if (wrapper && SHELL_C_FLAG.test(w.text)) {
      innerNext = true;
    } else {
      const t = w.text.replace(/^--?[\w-]+=/, "");
      if (t !== "" && isPathLike(t)) out.push(t);
    }
  }
  return out;
}

const COMMAND_TOOLS: ReadonlySet<string> = new Set(["shell", "Bash", "command_execution"]);

const looksLikePath = (c: string): boolean => c !== "" && !c.includes("://") && (isPathLike(c) || c.includes("/"));

/** Every string value in a parsed JSON value. */
function jsonStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(jsonStrings);
  if (v !== null && typeof v === "object") return Object.values(v).flatMap(jsonStrings);
  return [];
}

/**
 * Paths a non-command tool call points at. claude Grep/Glob targets are
 * `${pattern} in ${path}` — ambiguous when either side holds " in ", so every
 * suffix after an " in " is a candidate. A `{`-target is claude's JSON fallback
 * (no file_path/path/pattern): every string value is tested. Non-paths give none.
 */
function pathsInTarget(tool: string, target: string): string[] {
  if (target.startsWith("{")) {
    try {
      return jsonStrings(JSON.parse(target) as unknown).flatMap((v) => pathsInTarget(tool, v));
    } catch {
      return [];
    }
  }
  if (tool === "file_change") {
    return target
      .split(", ")
      .map((p) => p.trim())
      .filter((p) => p !== "");
  }
  const cands = [target.trim()];
  for (let at = target.indexOf(" in "); at >= 0; at = target.indexOf(" in ", at + 1)) cands.push(target.slice(at + 4).trim());
  return [...new Set(cands)].filter(looksLikePath);
}

const DEVICES: ReadonlySet<string> = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const isDevice = (p: string): boolean => DEVICES.has(p) || p.startsWith("/dev/fd/");

function signalsForCall(c: ToolCallRecord, projectRoot: string, home: string, reviewerCwd: string): InjectionSignal[] {
  const paths = COMMAND_TOOLS.has(c.tool) ? pathsInCommand(c.target) : pathsInTarget(c.tool, c.target);
  const out: InjectionSignal[] = [];
  for (const p of new Set(paths)) {
    if (isDevice(p)) continue;
    const where = classifyPath(p, projectRoot, home, reviewerCwd);
    if (where === "inside") continue;
    const why = where === "outside" ? "read outside the project" : "read the agent's own folder";
    out.push({
      kind: "tool",
      level: where === "outside" ? "loud" : "quiet",
      where: p,
      quote: c.target,
      why: c.failed ? `${why} (blocked)` : why,
    });
  }
  return out;
}

export function toolSignals(
  field: ToolCallsField | undefined,
  projectRoot: string,
  home: string,
  reviewerCwd: string = projectRoot,
): InjectionSignal[] {
  if (field === undefined || field === "not_recorded") return [];
  return field.flatMap((c) => signalsForCall(c, projectRoot, home, reviewerCwd));
}

export function buildAlert(signals: InjectionSignal[], toolRecord: InjectionAlert["toolRecord"]): InjectionAlert | null {
  if (signals.length === 0) return null;
  return { level: signals.some((s) => s.level === "loud") ? "loud" : "quiet", signals, toolRecord };
}

const BUBBLE_CAP = 200;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const isControl = (code: number): boolean => code < 32 || (code >= 127 && code <= 159);

/** Control characters and ANSI become spaces; runs of spaces collapse. Untrusted text -> one safe line. */
function oneLine(s: string): string {
  return [...s.replace(ANSI, "")]
    .map((ch) => (isControl(ch.charCodeAt(0)) ? " " : ch))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
}

const capped = (s: string, cap: number): string => (s.length > cap ? `${s.slice(0, cap - 1)}…` : s);

/**
 * One-line pet-bubble text, worded by the first loud signal's kind (a tool signal is an
 * outside read; anything else is project text steering the review). `where` comes from
 * untrusted input, so the whole line goes through `oneLine`.
 */
export function alertBubbleText(alert: InjectionAlert, project: string): string {
  const first = alert.signals.find((s) => s.level === "loud") ?? alert.signals[0];
  const lead = first?.kind === "tool" ? "Reviewer read outside the project" : "Project text tried to steer the review";
  return capped(oneLine(`⚠ ${lead}: ${first?.where ?? ""} (${project})`), BUBBLE_CAP);
}

/**
 * The alert for one review: the model's own report plus its recorded tool calls.
 * `readText` is what the model was given (system prompt + user message). `projectRoot` is the
 * git top-level; `reviewerCwd` is the cwd the reviewer's tools ran in (relative targets resolve
 * against it). `null` when nothing fired.
 */
export function alertForReview(
  items: InjectionSuspectedItem[] | undefined,
  readText: string,
  toolCalls: ToolCallsField | undefined,
  projectRoot: string,
  home: string,
  reviewerCwd: string,
  scanSignals: InjectionSignal[] = [],
): InjectionAlert | null {
  const signals = [...selfSignals(items, readText), ...toolSignals(toolCalls, projectRoot, home, reviewerCwd), ...scanSignals];
  return buildAlert(signals, toolCalls === undefined || toolCalls === "not_recorded" ? "not_recorded" : "recorded");
}

const CLI_QUOTE_CAP = 120;

/** One `siltpoke review` line per signal; every untrusted part is flattened to one line. */
export function alertCliLines(alert: InjectionAlert): string[] {
  return alert.signals.map((s) => {
    const where = oneLine(s.where);
    const quote = capped(oneLine(s.quote), CLI_QUOTE_CAP);
    if (s.level === "quiet") {
      if (s.kind === "tool") return `· outside read (agent's own folder) — ${where}: "${quote}"`;
      if (s.kind === "scan") return `· possible instruction in project text — ${where}: "${quote}"`;
      return `· worth a look — ${where}: "${quote}"`;
    }
    return `⚠ injection attempt — ${where}: "${quote}" (${oneLine(s.why)})`;
  });
}
