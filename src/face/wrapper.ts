// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drainProcess, stopProcess } from "../brain/drain-process";
import { siltpokeRoot } from "../installer/paths";
import { readRestartOutcome } from "../cli/restart-outcome";
import { readBrainHealthAsync } from "../state/brain-health";
import { latchedSinceMs } from "../state/brain-signal";
import { resolveArt } from "../state/pose";
import { pickAuraGlyph, readProgression } from "../state/progression";
import { isStale, readState, type FaceAlert } from "../state/state";
import { composeOutput } from "./composer";
import { renderMenubar } from "./menubar";
import { collectPendingReviews } from "./menubar-aggregate";
import { DEFAULT_SPECIES, getSpecies } from "./species";
import { formatTasklistSegment, parseTasklist, readTasklist } from "./tasklist";
import { buildBubbleBlock, colorize, severityToColor } from "./bubble";

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
  /** The clock the bubble's date is judged against. Tests only; defaults to now. */
  nowMs?: number;
  /** Limit on the user's own statusline command. Tests only; defaults to INNER_TIMEOUT_MS. */
  innerTimeoutMs?: number;
}

/**
 * The user's statusline command gets this long. Measured 2026-10-18: claude-hud
 * takes 0.14–0.33 s, so 2 s is six times the slowest run.
 */
const INNER_TIMEOUT_MS = 2_000;
/** After the limit: SIGKILL grace, and how long a child may hold stdout once bash exits. */
const INNER_GRACE_MS = 500;

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

/**
 * Run the user's own statusline command (inner.txt).
 *
 * It had no time limit: one that hung held the whole statusline. Past the
 * limit it is stopped (SIGTERM, then SIGKILL) and the caller renders the face
 * alone; a child of it still holding stdout after it exits is cut the same way.
 */
async function runInner(
  innerCommand: string,
  options: WrapperOptions,
): Promise<{ stdout: string; exitCode: number; timedOut: boolean; limitMs: number }> {
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
  const limitMs = options.innerTimeoutMs ?? INNER_TIMEOUT_MS;
  let timedOut = false;
  // A command that already exited is not over the limit, even while a child of
  // it still holds stdout through the drain grace.
  let exited = false;
  proc.exited.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  const timer = setTimeout(() => {
    if (exited) return;
    timedOut = true;
    try {
      stopProcess(proc, INNER_GRACE_MS);
    } catch {
      // already gone
    }
  }, limitMs);
  try {
    const { stdout, exitCode } = await drainProcess({ stdout: proc.stdout, exited: proc.exited }, INNER_GRACE_MS);
    return { stdout, exitCode, timedOut, limitMs };
  } finally {
    clearTimeout(timer);
  }
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
      const inner = await runInner(innerCommand, options);
      if (inner.timedOut) {
        await logError(options.basePath, `Inner command took over ${inner.limitMs} ms; stopped`);
        return spliceFace(options, "");
      }
      stdout = inner.stdout;
      const exitCode = inner.exitCode;
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

interface Said {
  text: string | undefined;
  color: string;
  /** When it was said; undefined for the config default, which nobody said. */
  atMs: number | undefined;
}

/**
 * What the bubble says. A latched reviewer comes first: it stops every later
 * review until someone clears it, and nothing else on the statusline says so
 * (audit [48]). Then a fresh review, then the config default.
 *
 * Only the latch — a breaker on a timer reopens by itself within the hour.
 */
function pickBubble(
  cfg: WrapperConfig,
  fresh: { bubble_short?: string; severity: string; last_updated_ms?: number } | null,
  stoppedAtMs: number | null,
  agent: string | undefined,
  alert?: FaceAlert,
): Said {
  if (stoppedAtMs !== null) {
    // A non-Claude host has no slash commands (same invariant as the setup
    // nudges, tests/plugin/host-aware-nudge.test.ts).
    const how = agent ? "ask your agent to wake Siltpoke" : "run /siltpoke:siltpoke-wake";
    return { text: `I stopped reviewing — ${how}`, color: "red", atMs: stoppedAtMs };
  }
  // A prompt-injection alert stays until a clean review in that project clears
  // it, so it is read whether or not the state is stale, and it outranks a fresh review.
  if (alert !== undefined) return { text: alert.text, color: "red", atMs: alert.at };
  if (fresh !== null) {
    return {
      text: fresh.bubble_short,
      color: severityToColor(fresh.severity, cfg.bubbleColor),
      atMs: fresh.last_updated_ms,
    };
  }
  return { text: cfg.bubble, color: cfg.bubbleColor, atMs: undefined };
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
    const stoppedAtMs = latchedSinceMs(await readBrainHealthAsync(options.basePath));
    const said = pickBubble(cfg, stateFresh ? state : null, stoppedAtMs, options.agent, state?.alert);
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

    // The inner column with the bubble under it, or untouched when nothing is said.
    const withBubble = (faceWidth: number): string =>
      said.text
        ? `${stdout.replace(/\n+$/, "")}\n\n${buildBubbleBlock(said.text, said.color, faceWidth, termWidth, said.atMs, options.nowMs)}`
        : stdout;

    if (cfg.minimalMode) return appendSeg(withBubble(0));

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
    const inner = withBubble(widestLine(face));
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
