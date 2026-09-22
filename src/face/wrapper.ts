// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { siltpokeRoot } from "../installer/paths";
import { readRestartOutcome } from "../cli/restart-outcome";
import { resolveArt } from "../state/pose";
import { pickAuraGlyph, readProgression } from "../state/progression";
import { isStale, readState } from "../state/state";
import { composeOutput } from "./composer";
import { renderMenubar } from "./menubar";
import { collectPendingReviews } from "./menubar-aggregate";
import { DEFAULT_SPECIES, getSpecies } from "./species";
import { formatTasklistSegment, parseTasklist, readTasklist } from "./tasklist";
import { truncateToVisualWidth, visualWidth } from "./width";

export interface WrapperOptions {
  basePath: string;
  termWidth?: number;
  projectBase?: string;
  innerStdin?: string;
  /** Session cwd (from the statusline stdin JSON). Used to locate
   *  cwd/.claude/tasklist.md for the tasklist-progress segment. */
  cwd?: string;
  /**
   * When set, this render is for a specific non-Claude host (e.g.
   * "antigravity") whose statusLine has no relationship to the shared
   * ~/.siltpoke/inner.txt chain — that file records CLAUDE's prior
   * statusLine.command specifically (install.ts, Claude settings.json
   * only); running it under a different host would execute the wrong
   * command in the wrong context. Skips the inner-chaining step entirely;
   * renders Siltpoke's face standalone (the same code path an absent
   * inner.txt already takes).
   */
  agent?: string;
}

async function logError(basePath: string, message: string): Promise<void> {
  try {
    const logsDir = join(basePath, "logs");
    await mkdir(logsDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ERROR ${message}\n`;
    await appendFile(join(logsDir, "errors.log"), line);
  } catch {
    // Logger failures must never crash the wrapper.
  }
}

interface WrapperConfig {
  species: string;
  name: string;
  bubble: string;
  bubbleColor: string;
  terminalWidth: number;
  minimalMode: boolean;
  /**
   * Show the `.claude/tasklist.md` progress segment under the pet.
   *
   * OFF by default and opt-in, reversing the original behaviour: the segment
   * used to render unconditionally whenever `<cwd>/.claude/tasklist.md`
   * parsed, with no way to turn it off. It pinned one stale line
   * (`0/14 ▶ <some old step>`) under every turn, which reads as current work
   * and is not. Requested three times before this existed.
   */
  showTasklist: boolean;
}

export async function readConfig(basePath: string): Promise<WrapperConfig> {
  const fallback: WrapperConfig = {
    species: DEFAULT_SPECIES,
    name: "",
    bubble: "",
    bubbleColor: "cyan",
    terminalWidth: 0,
    minimalMode: false,
    showTasklist: false,
  };
  try {
    const configPath = join(basePath, "config.json");
    if (!existsSync(configPath)) return fallback;
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      species: typeof parsed?.species === "string" ? parsed.species : DEFAULT_SPECIES,
      name: typeof parsed?.name === "string" ? parsed.name : "",
      bubble: typeof parsed?.bubble === "string" ? parsed.bubble : "",
      bubbleColor: typeof parsed?.bubbleColor === "string" ? parsed.bubbleColor : "cyan",
      terminalWidth:
        typeof parsed?.terminalWidth === "number" && parsed.terminalWidth > 0
          ? Math.floor(parsed.terminalWidth)
          : 0,
      minimalMode: parsed?.minimalMode === true,
      // Opt-in: anything other than an explicit `true` means off, so an old
      // config.json written before this key existed turns the segment OFF
      // rather than grandfathering the old unconditional behaviour.
      showTasklist: parsed?.showTasklist === true,
    };
  } catch {
    return fallback;
  }
}

// Aligned with /history SpeechKindBadge + classifySpeechKind:
//   high          → critical (red)
//   medium / med  → warning  (yellow)
//   low / info    → comment  (gray)   — `low` is Brain's default for benign
//                                       critiques. Painting it cyan in the
//                                       terminal bubble contradicts the
//                                       dashboard's comment badge.
const SEVERITY_TO_COLOR: Record<string, string> = {
  high: "red",
  medium: "yellow",
  med: "yellow",
  low: "gray",
  info: "gray",
};

function severityToColor(severity: string, fallback: string): string {
  return SEVERITY_TO_COLOR[severity] ?? fallback;
}

const ANSI_COLOR_CODES: Record<string, string> = {
  cyan: "36",
  green: "32",
  yellow: "33",
  magenta: "35",
  red: "31",
  blue: "34",
  white: "37",
  gray: "90",
  pink: "38;5;213",
  hotpink: "38;5;205",
  coral: "38;5;210",
  mint: "38;5;121",
};

function colorize(text: string, colorName: string): string {
  const code = ANSI_COLOR_CODES[colorName] ?? ANSI_COLOR_CODES.cyan!;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function _renderBubbleLine(bubble: string, colorName: string): string {
  return colorize(`"${bubble}"`, colorName);
}

function tokenize(text: string): string[] {
  // Split on whitespace OR just after CJK fullwidth punctuation.
  // Excludes ASCII . , ! ? on purpose so file paths (queries.py),
  // version strings, and numbers stay intact.
  return text.split(/(?:\s+|(?<=[，。！？]))/).filter((t) => t !== "");
}

function wrapBubble(text: string, maxWidth: number, maxLines: number): string[] {
  if (maxWidth <= 0 || visualWidth(text) <= maxWidth) return [text];

  const words = tokenize(text);
  const lines: string[] = [];
  let cur = "";
  const endsWithCjkPunct = (s: string): boolean => /[，。！？]$/.test(s);
  for (const w of words) {
    const sep = !cur || endsWithCjkPunct(cur) ? "" : " ";
    const tryNext = `${cur}${sep}${w}`;
    if (visualWidth(tryNext) <= maxWidth) {
      cur = tryNext;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);

  // Words can themselves exceed maxWidth (long CJK token, URL, etc.).
  // Split any oversized line by visual width.
  const flat: string[] = [];
  for (const line of lines) {
    if (visualWidth(line) <= maxWidth) {
      flat.push(line);
      continue;
    }
    let rest = line;
    while (visualWidth(rest) > maxWidth) {
      const chunk = truncateToVisualWidth(rest, maxWidth);
      flat.push(chunk);
      rest = rest.slice(chunk.length);
    }
    if (rest) flat.push(rest);
  }

  if (flat.length > maxLines) {
    const kept = flat.slice(0, maxLines);
    const idx = maxLines - 1;
    const last = kept[idx]!;
    const trimmed = truncateToVisualWidth(last, Math.max(0, maxWidth - 3));
    kept[idx] = `${trimmed}...`;
    return kept;
  }
  return flat;
}

/**
 * `[10:44 AM]: ` from an epoch-ms stamp, or "" when there is nothing to stamp.
 *
 * The trailing colon makes the line read as speech — `[10:44 AM]: "…"` is
 * someone saying something at a time, which is what a pet bubble is. Without
 * it the stamp sits next to the quote like a label on a log row.
 *
 * 12-hour with the meridiem, not 24-hour: this line is matched against the
 * reader's own memory of the session, and that memory is "before lunch", not
 * "before 12:00". A bare `[01:15]` is also genuinely ambiguous on a machine
 * that has been awake across both — the hour is the half of the stamp that
 * does the work, so it must not be the half that can be read two ways.
 *
 * Hours are NOT zero-padded (`9:05 AM`, not `09:05 AM`) — that is the
 * conventional 12-hour form, and the leading zero reads as a 24-hour clock,
 * which is the exact confusion the meridiem is here to remove. Minutes stay
 * padded, because `9:5` is not a time.
 */
export function bubbleTimeStamp(atMs: number | undefined): string {
  if (atMs === undefined || !Number.isFinite(atMs) || atMs <= 0) return "";
  const d = new Date(atMs);
  const h24 = d.getHours();
  const meridiem = h24 < 12 ? "AM" : "PM";
  // Midnight and noon are the two the modulo gets wrong: 0 % 12 and 12 % 12
  // are both 0, and "0:15 AM" is not a time anyone writes.
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${h12}:${mm} ${meridiem}]: `;
}

/**
 * The bubble carries WHEN it was said.
 *
 * Without it the pet's line looks the same at one minute old and at
 * twenty-nine — the bubble only clears at 30 minutes (`DEFAULT_STALE_MS`) —
 * so a review of earlier work reads as a review of the turn you just
 * finished, and a reader assumes it is about the turn they just made.
 *
 * A clock time, not an age: it costs the same width every render (no reflow
 * as "2m" becomes "12m"), and it is what a reader matches against their own
 * memory of the session. Everything else about a review — which files, what
 * evidence, which branch — stays in the dashboard timeline; this line is the
 * one fact that has to travel with the sentence.
 */
function buildBubbleBlock(
  bubble: string,
  colorName: string,
  faceWidth: number,
  termWidth: number,
  atMs?: number,
): string {
  const quoted = `${bubbleTimeStamp(atMs)}"${bubble}"`;
  const effective = termWidth > 0 ? termWidth : 160;
  const available = Math.max(20, effective - faceWidth - 2);
  const wrapped = wrapBubble(quoted, available, 3);
  return wrapped.map((l) => colorize(l, colorName)).join("\n");
}

function detectTermWidth(): number {
  if (process.stderr.columns && process.stderr.columns > 0) {
    return process.stderr.columns;
  }
  const envCols = parseInt(process.env.COLUMNS ?? "", 10);
  if (Number.isFinite(envCols) && envCols > 0) return envCols;
  return 160;
}

function widestLine(text: string): number {
  return text.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
}

/**
 * Columns of left margin on the pet block in the statusline. Padding uses the
 * same U+2800 as the centering below — a plain space here would be stripped by
 * the renderer and the margin would silently be zero.
 */
const FACE_LEFT_MARGIN = 4;

function buildFaceBlock(
  art: string,
  name: string,
  progressionLine?: string,
  titleLine?: string,
): string {
  const artLines = art.split("\n");
  const artWidth = artLines.reduce((m, l) => Math.max(m, l.length), 0);
  const labelLines = [name, titleLine, progressionLine].filter(
    (l): l is string => typeof l === "string" && l.length > 0,
  );
  const widestLabel = labelLines.reduce((m, l) => Math.max(m, l.length), 0);
  const blockWidth = widestLabel
    ? Math.max(artWidth, widestLabel + 2)
    : artWidth;

  // Claude Code's statusline renderer strips LEADING WHITESPACE per line, so
  // left padding uses U+2800 (Braille Pattern Blank) — a real character that
  // is not whitespace per Unicode, and so survives the strip. Right padding
  // stays as regular spaces (trailing whitespace is not trimmed).
  //
  // MEASURED 2026-09-20 (install-audit defect [5a]): the strip is by the
  // Unicode White_Space property, not by ASCII. NBSP (U+00A0) and FIGURE
  // SPACE (U+2007) were probed through the real statusline alongside ASCII
  // spaces and all three were stripped; only U+2800 came through. There is no
  // better-covered character to switch to — see src/face/composer.ts for the
  // full probe, and tests/face/indent-char.test.ts for the guard.
  const NBSP_LIKE = "⠀";

  const center = (line: string): string => {
    const total = blockWidth - line.length;
    if (total <= 0) return line;
    const left = Math.floor(total / 2);
    const right = total - left;
    return NBSP_LIKE.repeat(left) + line + " ".repeat(right);
  };

  // Left margin for the whole block. Every row gets it, so `faceWidth` in
  // composeOutput widens with it and the bubble's continuation rows stay
  // aligned — one knob, not two.
  const margin = NBSP_LIKE.repeat(FACE_LEFT_MARGIN);
  const place = (line: string): string => margin + center(line);

  const centeredArt = artLines.map(place).join("\n");
  if (labelLines.length === 0) return centeredArt;
  return [centeredArt, ...labelLines.map(place)].join("\n");
}

function formatProgressionLine(p: {
  level: number;
  xp: number;
  xp_to_next_level: number;
}): string {
  return `L${p.level} ${p.xp}/${p.xp_to_next_level}`;
}

// Title-tier order, highest → lowest. We surface the highest-tier title
// the user has unlocked on a separate line under the pet's name.
// "Hatchling" is the lv1 default and is intentionally not surfaced — it
// would be noise on every face.
const TITLE_ORDER = [
  "Legend",
  "Ancient",
  "Oracle",
  "Sage",
  "Veteran",
  "Sentinel",
  "Apprentice",
  "Watcher",
];

function pickHighestTitle(
  unlockedTitles: readonly string[],
): string | undefined {
  for (const tier of TITLE_ORDER) {
    if (unlockedTitles.includes(tier)) return tier;
  }
  return undefined;
}

/**
 * Wraps a face block in an aura — a single decorative glyph rendered in
 * each of the four corners. Glyph is picked by level via pickAuraGlyph;
 * lv<15 returns the block unchanged.
 */
function applyAura(faceBlock: string, glyph: string | undefined): string {
  if (!glyph) return faceBlock;
  const lines = faceBlock.split("\n");
  if (lines.length === 0) return faceBlock;
  const width = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const pad = (line: string): string => {
    const deficit = width - line.length;
    return deficit > 0 ? line + " ".repeat(deficit) : line;
  };
  const top = `${glyph}${" ".repeat(Math.max(0, width))}${glyph}`;
  const bottom = `${glyph}${" ".repeat(Math.max(0, width))}${glyph}`;
  const middle = lines.map((l) => ` ${pad(l)} `);
  return [top, ...middle, bottom].join("\n");
}

export async function runWrapper(options: WrapperOptions): Promise<string> {
  const innerPath = join(options.basePath, "inner.txt");

  // Resolve the inner statusline output. A fresh install with no prior
  // statusLine to chain (a supported path — install.ts:295 "installing
  // fresh") legitimately has no inner.txt; there is simply no inner line, and
  // we still render Siltpoke's own face standalone rather than a
  // "not configured" cliff that leaves the first-touch user staring at text.
  // options.agent set -> this render belongs to a non-Claude host; inner.txt
  // is Claude-specific bookkeeping and must never be executed here.
  let stdout = "";
  if (!options.agent && existsSync(innerPath)) {
    let innerCommand: string;
    try {
      innerCommand = (await readFile(innerPath, "utf8")).trim();
    } catch (err) {
      await logError(options.basePath, `Failed to read inner.txt: ${err}`);
      return "";
    }

    if (!innerCommand) {
      await logError(options.basePath, "inner.txt is empty");
      return "";
    }

    try {
      const useReplay = typeof options.innerStdin === "string";
      const proc = Bun.spawn(["bash", "-c", innerCommand], {
        stdin: useReplay ? "pipe" : "inherit",
        stderr: "inherit",
        stdout: "pipe",
      });
      if (useReplay && proc.stdin) {
        proc.stdin.write(options.innerStdin!);
        proc.stdin.end();
      }

      stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        await logError(
          options.basePath,
          `Inner command exited with code ${exitCode}`
        );
        return "";
      }
    } catch (err) {
      await logError(options.basePath, `Failed to spawn inner command: ${err}`);
      return "";
    }
  }

  return spliceFace(options, stdout);
}

// Compose Siltpoke's face beside the inner statusline output. `stdout` is the
// inner command's output, or "" when there is no inner statusline to chain.
async function spliceFace(
  options: WrapperOptions,
  stdout: string,
): Promise<string> {
  try {
    const cfg = await readConfig(options.basePath);
    const species = getSpecies(cfg.species);

    const projectState = options.projectBase
      ? await readState(options.projectBase)
      : null;
    const globalState =
      projectState === null ? await readState(options.basePath) : null;
    const state = projectState ?? globalState;
    const stateFresh = state !== null && !isStale(state);

    const mood = stateFresh ? state?.mood : "happy";
    const bubbleText = stateFresh ? state?.bubble_short : cfg.bubble;
    const bubbleColor = stateFresh
      ? severityToColor(state?.severity, cfg.bubbleColor)
      : cfg.bubbleColor;
    const termWidth =
      options.termWidth ??
      (cfg.terminalWidth > 0 ? cfg.terminalWidth : detectTermWidth());

    // Gate the READ, not just the render — an off segment should not touch
    // the filesystem on every statusline paint.
    const tasklistRaw = cfg.showTasklist ? await readTasklist(options.cwd) : null;
    const tasklistParsed = tasklistRaw ? parseTasklist(tasklistRaw) : null;
    const tasklistSeg = tasklistParsed
      ? colorize(formatTasklistSegment(tasklistParsed), "gray")
      : "";
    // Append the segment as the bottom line of the inner column. Strips any
    // trailing newlines first so the segment sits directly under the last line.
    const appendSeg = (s: string): string =>
      tasklistSeg ? `${s.replace(/\n+$/, "")}\n${tasklistSeg}` : s;

    if (cfg.minimalMode) {
      if (!bubbleText) return appendSeg(stdout);
      const bubbleBlock = buildBubbleBlock(
        bubbleText,
        bubbleColor,
        0,
        termWidth,
        stateFresh ? state?.last_updated_ms : undefined,
      );
      return appendSeg(`${stdout.replace(/\n+$/, "")}\n\n${bubbleBlock}`);
    }

    const progression = await readProgression(options.basePath);
    const pose = stateFresh ? state?.pose : undefined;
    const art = resolveArt(
      species,
      mood,
      pose,
      progression.unlocked_poses ?? [],
    );
    const titleLine = pickHighestTitle(progression.unlocked_titles ?? []);
    const rawFace = buildFaceBlock(
      art,
      cfg.name,
      formatProgressionLine(progression),
      titleLine,
    );
    const auraGlyph = pickAuraGlyph(progression.level ?? 1);
    const face = applyAura(rawFace, auraGlyph);
    const faceWidth = widestLine(face);
    const inner = bubbleText
      ? `${stdout.replace(/\n+$/, "")}\n\n${buildBubbleBlock(bubbleText, bubbleColor, faceWidth, termWidth, stateFresh ? state?.last_updated_ms : undefined)}`
      : stdout;
    return composeOutput({ face, inner: appendSeg(inner), termWidth });
  } catch (err) {
    await logError(options.basePath, `Face splice failed, falling through: ${err}`);
    return stdout;
  }
}

async function readStdinAll(): Promise<string> {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
}

/** Resolve the bun binary for the menu-bar Restart row. Prefers the running
 *  interpreter (process.execPath) — PATH-independent, correct under SwiftBar's
 *  minimal GUI-launchd PATH — and falls back to `which bun`. */
export function resolveBunBinary(
  execPath: string | undefined,
  which: (cmd: string) => string | null,
): string | null {
  if (execPath && execPath.length > 0) return execPath;
  return which("bun");
}

/**
 * Resolve the daemon-restart script path from the directory THIS module is
 * currently running from. wrapper.ts ships two ways
 * (scripts/build-dist.ts's BUNDLES list):
 *   - BUNDLED (plugin install): esbuild inlines this file into
 *     dist/siltpoke-card.js, landing in the SAME dist/ outdir as
 *     dist/siltpoke-daemon.js (src/cli/daemon.ts's own bundle). A plugin
 *     cache ships no `src/`, so `import.meta.url`'s `../cli/daemon.ts`
 *     resolution used to overshoot to a TypeScript source file that doesn't
 *     exist there — `bun <root>/cli/daemon.ts restart` threw "Module not
 *     found", and `terminal=false` on the SwiftBar line hid the failure,
 *     making the menu-bar "Restart daemon" item a silent no-op. Mirrors
 *     src/memory/distil-launcher.ts's `basename(...) === "dist"` precedent
 *     (also used by resolveOnStopTarget in src/hooks/agy-stop.ts) for the
 *     same ship-two-ways problem: the bundle target is a plain sibling join,
 *     no `..` traversal to get wrong.
 *   - SOURCE (dev install): bun runs src/face/wrapper.ts directly, and
 *     src/cli/daemon.ts is reachable via its sibling directory `cli/`.
 *
 * Exported so the dist/source split is unit-testable without touching a
 * real filesystem or import.meta.url.
 */
export function resolveDaemonScript(hereDir: string): string {
  if (basename(hereDir) === "dist") {
    return join(hereDir, "siltpoke-daemon.js");
  }
  return join(hereDir, "..", "cli", "daemon.ts");
}

/**
 * Resolve the command-surface CLI (`siltpoke-cli.js` = src/cli/plugin-cli.ts)
 * that carries the `dashboard` verb, using the same dist/source split as
 * resolveDaemonScript. BUNDLED: dist/siltpoke-cli.js is a sibling of the
 * inlined wrapper in dist/. SOURCE: src/cli/plugin-cli.ts via the sibling
 * `cli/` dir. Exported for the same unit-testability reason.
 */
export function resolveDashboardCli(hereDir: string): string {
  if (basename(hereDir) === "dist") {
    return join(hereDir, "siltpoke-cli.js");
  }
  return join(hereDir, "..", "cli", "plugin-cli.ts");
}

/**
 * Resolve the `restart` field for the menu-bar dropdown. Returns undefined when
 * bun can't be located, so renderMenubar simply omits the Restart row rather
 * than emitting a broken `bash=` with no interpreter.
 */
export function resolveRestartField(
  which: (cmd: string) => string | null,
  scriptPath: string,
): { bun: string; script: string } | undefined {
  const bun = which("bun");
  if (!bun) return undefined;
  return { bun, script: scriptPath };
}

function parseCwd(rawJson: string): string | undefined {
  if (!rawJson) return undefined;
  try {
    const parsed = JSON.parse(rawJson);
    const cwd = parsed?.cwd ?? parsed?.workspace?.current_dir;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** CLI-entry helper — extracts the value following `--agent` from argv. */
export function parseAgentFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf("--agent");
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Last-resort net beyond the try/catch blocks below. Those only cover
 * synchronous throws and *awaited* rejections inside this file's own call
 * stack — a dependency that fires an unhandled rejection or throws from a
 * detached callback (timer, event emitter) on some other tick bypasses them
 * entirely and hits Bun's default reporter, which prints a stack trace to
 * stderr and can leave the process exiting non-zero. The shim
 * (src/installer/shim.ts) already suppresses stderr and passes exit code /
 * stdout straight through via `exec` — it cannot buffer the bundle's output
 * to inspect it first without breaking streaming, so this file must
 * guarantee "exit 0, print nothing" against ANY fault, not just the ones
 * reachable through its own try/catch. Mirrors the exit-0-on-any-fault
 * contract src/hooks/on-stop.ts already applies to its own top-level catch.
 */
function installFaultNet(basePath: string): void {
  let caught = false;
  const net = (label: string, err: unknown): void => {
    if (caught) return; // process.exit is requested once; ignore re-entrant faults
    caught = true;
    void logError(basePath, `FATAL ${label}: ${err}`).finally(() => process.exit(0));
  };
  process.on("uncaughtException", (err) => net("uncaughtException", err));
  process.on("unhandledRejection", (reason) => net("unhandledRejection", reason));
}

if (import.meta.main) {
  const basePath = siltpokeRoot();
  installFaultNet(basePath);

  // Test-only fault-injection seam (mirrors SILTPOKE_TEST_MOCK_STREAM in
  // src/daemon/server.ts) — lets tests/face/wrapper-entry-crash.test.ts
  // prove the net above against a fault that arrives from OUTSIDE this
  // file's own try/catch, the exact class installFaultNet exists to catch.
  // Never set in real installs.
  if (process.env.SILTPOKE_TEST_FAULT === "unhandled-rejection") {
    void Promise.reject(new Error("test-injected unhandled rejection"));
  } else if (process.env.SILTPOKE_TEST_FAULT === "uncaught-exception") {
    setTimeout(() => {
      throw new Error("test-injected uncaught exception");
    }, 0);
  }
  if (process.env.SILTPOKE_TEST_FAULT) {
    // Give the injected fault above a chance to win the race against the
    // real render below, so the test actually exercises a fault arriving
    // mid-flight rather than one that loses to this process's own exit.
    await new Promise((r) => setTimeout(r, 20));
  }

  if (process.argv.includes("--menubar")) {
    try {
      const cfg = await readConfig(basePath);
      const reviews = await collectPendingReviews(basePath);
      const hereDir = dirname(fileURLToPath(import.meta.url));
      const daemonScript = resolveDaemonScript(hereDir);
      const dashboardCli = resolveDashboardCli(hereDir);
      const whichBun = (cmd: string): string | null => {
        const r = spawnSync("which", [cmd], { encoding: "utf8" });
        const p = (r.stdout ?? "").trim();
        return p.length > 0 ? p : null;
      };
      const bunBinary = resolveBunBinary(process.execPath, whichBun);
      process.stdout.write(
        renderMenubar({
          name: cfg.name || "Siltpoke",
          emoji: getSpecies(cfg.species).menubarEmoji,
          reviews,
          dashboardUrl: "http://127.0.0.1:9876",
          nowMs: Date.now(),
          restart: resolveRestartField(() => bunBinary, daemonScript),
          // Closes the loop the `terminal=false` restart row opens: SwiftBar
          // discards the CLI's output, so the outcome comes back through disk.
          restartOutcome: readRestartOutcome(basePath) ?? undefined,
          dashboard: bunBinary ? { bun: bunBinary, cli: dashboardCli } : undefined,
        }),
      );
    } catch (err) {
      await logError(basePath, `menubar mode failed: ${err}`);
      process.stdout.write(
        "🟢 Siltpoke\n---\nOpen dashboard | href=http://127.0.0.1:9876\n",
      );
    }
    process.exit(0);
  }

  try {
    const agent = parseAgentFlag(process.argv);
    const innerStdin = await readStdinAll();
    const cwd = parseCwd(innerStdin);
    const projectBase = cwd ? join(cwd, ".siltpoke") : undefined;
    const output = await runWrapper({
      basePath,
      projectBase,
      innerStdin,
      agent,
      cwd,
    });
    process.stdout.write(output);
    process.exit(0);
  } catch (err) {
    // Last-resort guard: a crash here must NOT disrupt Claude Code.
    // Log what we can and exit 0 regardless.
    await logError(basePath, `FATAL wrapper crashed: ${err}`);
    process.exit(0);
  }
}
