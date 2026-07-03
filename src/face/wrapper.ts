// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getSpecies, DEFAULT_SPECIES } from "./species";
import { composeOutput } from "./composer";
import { visualWidth, truncateToVisualWidth } from "./width";
import { readState, isStale } from "../state/state";
import { resolveArt } from "../state/pose";
import { readProgression, pickAuraGlyph } from "../state/progression";

export interface WrapperOptions {
  basePath: string;
  termWidth?: number;
  projectBase?: string;
  innerStdin?: string;
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
}

async function readConfig(basePath: string): Promise<WrapperConfig> {
  const fallback: WrapperConfig = {
    species: DEFAULT_SPECIES,
    name: "",
    bubble: "",
    bubbleColor: "cyan",
    terminalWidth: 0,
    minimalMode: false,
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

function buildBubbleBlock(
  bubble: string,
  colorName: string,
  faceWidth: number,
  termWidth: number,
): string {
  const quoted = `"${bubble}"`;
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

  // Claude Code's statusline renderer strips ASCII leading whitespace
  // per line, so left padding uses U+2800 (Braille Pattern Blank) — a
  // real character that survives the strip. Right padding stays as
  // regular spaces (trailing whitespace is not trimmed).
  const NBSP_LIKE = "⠀";

  const center = (line: string): string => {
    const total = blockWidth - line.length;
    if (total <= 0) return line;
    const left = Math.floor(total / 2);
    const right = total - left;
    return NBSP_LIKE.repeat(left) + line + " ".repeat(right);
  };

  const centeredArt = artLines.map(center).join("\n");
  if (labelLines.length === 0) return centeredArt;
  return [centeredArt, ...labelLines.map(center)].join("\n");
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
  let stdout = "";
  if (existsSync(innerPath)) {
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

    if (cfg.minimalMode) {
      if (!bubbleText) return stdout;
      const bubbleBlock = buildBubbleBlock(bubbleText, bubbleColor, 0, termWidth);
      return `${stdout.replace(/\n+$/, "")}\n\n${bubbleBlock}\n`;
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
      ? `${stdout.replace(/\n+$/, "")}\n\n${buildBubbleBlock(bubbleText, bubbleColor, faceWidth, termWidth)}`
      : stdout;
    return composeOutput({ face, inner, termWidth });
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

if (import.meta.main) {
  const basePath = join(process.env.HOME ?? "", ".siltpoke");

  try {
    const innerStdin = await readStdinAll();
    const cwd = parseCwd(innerStdin);
    const projectBase = cwd ? join(cwd, ".siltpoke") : undefined;
    const output = await runWrapper({
      basePath,
      projectBase,
      innerStdin,
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
