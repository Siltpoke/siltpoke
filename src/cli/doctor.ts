// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * /siltpoke:siltpoke-doctor — install-health diagnostic CLI.
 *
 * Runs 15 sync install-health checks, plus 1 async project-resolution check
 * that CAN fail the exit code, plus 4 warn-only async rows (daemon alive +
 * daemon staleness + index staleness + knowledge tracks) that never do — 20
 * rows total — and prints a ✓/✗ checklist.
 * Exits 0 if all checks pass, 1 if any fail. Read-only diagnostic with ONE
 * deliberate exception: check 8 clears a binary-missing permanent Brain
 * breaker when the deterministic re-verify (claude back on PATH) passes.
 *
 * Flags:
 *   --json    Emit { all_pass, fail_count, checks: [{name, pass, detail}] }
 *   --quiet   Suppress per-check output; print 1-line summary
 */

import type { Stats } from "node:fs";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withAgyPluginFallback } from "./doctor-agy-plugin";
import { loadUpdateCheckConfigSync } from "../config/update-check-config";
import {
  resolveAgyHooksJsonPath,
  resolveClaudeHome,
  siltpokeRoot,
} from "../installer/paths";
import { globalSchema } from "../memory/schema-v3";
import { cachePath, parseCache } from "../update/check";
import { aHost, type DoctorHost, hostOfRunningCopy, hostOnThisMachine, setupAdviceFor, wiringPathFor } from "./doctor-agy-plugin-host";
import { checkBrainHealth } from "./doctor-brain-check";
import { checkAutostart, checkDaemonAlive, checkDaemonStaleness } from "./doctor-daemon-check";
import { checkIndexStaleness } from "./doctor-index-staleness-check";
import { pluginOwnsStopHook } from "./doctor-plugin-hook-check";
import { isPluginInstall } from "./doctor-plugin-install";
import { checkProjectResolutionUnderRoot } from "./doctor-project-resolution-check";
import { checkProjectRoots } from "./doctor-project-roots-check";
import { checkBrainRoles } from "./doctor-reviewer-check";
import { checkStatuslineInterpreter } from "./doctor-statusline-check";
import { checkStatuslineRenders } from "./doctor-statusline-run-check";
import { checkCodexHooksHaveRun } from "./doctor-codex-hook-check";
import { checkRipgrep } from "./doctor-ripgrep-check";
import { checkStopHook } from "./doctor-stop-hook-check";

export function defaultRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source: src/cli/ is two below the root. Bundled: dist/ is ONE below — two
  // lands above the plugin, and [24]'s pointer check never matched (defect [32]).
  if (basename(here) === "dist") return resolve(here, "..");
  return resolve(here, "..", "..");
}

import { checkReviewHookCanStart } from "./doctor-hook-start-check";

export interface CheckResult {
  /** Short human-readable check name (used as checklist row label). */
  name: string;
  /** True iff the check passed. */
  pass: boolean;
  /** Failure detail (path, schema mismatch, etc.) shown under the ✗ row in verbose mode. null when pass = true. */
  detail: string | null;
  /**
   * Optional visual override for warn-only / informational rows that pass=true
   * but want a non-✓ symbol (⚠ warn, ◦ info). Absent → derive from `pass`
   * (✓/✗). Used by the warn-only daemon rows (alive / staleness / autostart).
   */
  status?: "pass" | "warn" | "info";
}

export interface DoctorOptions {
  /** Override claude home (defaults to env). For tests. */
  claudeHome?: string;
  /** Override siltpoke home (defaults to env). For tests. */
  siltpokeHome?: string;
  /** Override the user's HOME (the pointer files live under it). For tests. */
  home?: string;
  /** Override the env read for XDG_CONFIG_HOME in the autostart check (defect [72]). For tests. */
  env?: NodeJS.ProcessEnv;
  /** Override repo root (used for slash symlink target verification). */
  repoRoot?: string;
  /**
   * True when running as an installed plugin (`/plugin install`), where the
   * host loads commands from the plugin dir and no symlinks exist. Defaults to
   * `isPluginInstall` below. Turns the symlink check into an info row.
   */
  pluginInstall?: boolean;
  /** Deterministic Brain re-verify — defaults to "claude resolvable on PATH". For tests. */
  brainReverifyFn?: () => boolean;
  /**
   * Injectable project resolver, used by `checkProjectResolutionUnderRoot`.
   * On `DoctorOptions` rather than that function's own parameter type because
   * the async checks are now all invoked through one `DoctorOptions` signature
   * (`DoctorAsyncCheck`), which a seam declared only on the callee cannot
   * reach. For tests.
   */
  resolve?: (input: { home: string }) => Promise<{ source: string; project_root: string | null }>;
  /** Override the /api/daemon-health URL for the staleness check. Defaults to the local daemon. */
  daemonHealthUrl?: string;
  /** Injectable fetch for the daemon-staleness/alive checks (tests stub without a live server). Defaults to `fetch`. */
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Override the /api/ping URL for the daemon-alive check. Defaults to the local daemon. */
  daemonPingUrl?: string;
  /**
   * Injectable `daemon.enabled` loader for the daemon-alive check (opt-in vs
   * genuinely-down distinction). Defaults to `loadDaemonConfig` reading
   * `<siltpokeHome>/config.json`. For tests.
   */
  loadDaemonConfigFn?: (home: string) => Promise<{ enabled: boolean }>;
  /** Override platform for the autostart check (darwin → plist, linux → unit, other → skip). */
  platform?: NodeJS.Platform;
  /** Override the autostart artifact path (plist/unit). Defaults to the canonical location. */
  autostartPath?: string;
  /** Binary-lookup seam for the reviewer-provider check. Defaults to `Bun.which`; tests return null for a missing `codex` binary. */
  reviewerWhichFn?: (cmd: string) => string | null;
  /** Binary-lookup seam for the statusline-interpreter check. Defaults to `Bun.which`. */
  statuslineWhichFn?: (cmd: string) => string | null;
  /** On-disk seam for the statusline-interpreter check (absolute interpreters). Defaults to `existsSync`. */
  statuslineExistsFn?: (path: string) => boolean;
  /** Override the eval-provenance sidecar path (written by run-eval.ts's `--provider codex`). Defaults to `<repoRoot>/src/eval/caller-impact/verdict.provenance.json`. */
  evalProvenancePath?: string;
  /** Override the agy hooks.json path for the check below. Defaults to resolveAgyHooksJsonPath(). */
  agyHooksJsonPath?: string;
  /**
   * Override the codex config.toml path used by host detection. Without this
   * seam the probe reads the real `~/.codex`, so a developer who happens to
   * have codex installed gets a different answer from one who does not — the
   * result would depend on the machine running the test, not on the fixture.
   */
  codexConfigPath?: string;
  /** Override qoder's / codebuddy's home for host detection (`[89]`). For tests. */
  qoderHome?: string;
  codebuddyHome?: string;
  /**
   * Override the plugin's own hooks.json path for the Stop-hook check.
   * Defaults to `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json`. For tests.
   */
  pluginHooksJsonPath?: string;
}

// ---------------------------------------------------------------------------
// Individual checks.
// ---------------------------------------------------------------------------

/** Parse a JSON file, returning either a parsed value or a structured error. */
export function readJson(path: string): { ok: true; value: unknown } | { ok: false; reason: "missing" | "corrupt" | "unreadable"; detail: string } {
  if (!existsSync(path)) return { ok: false, reason: "missing", detail: `${path} does not exist` };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, reason: "unreadable", detail: `${path} not readable (${(e as Error).message})` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, reason: "corrupt", detail: `${path} is not valid JSON (${(e as Error).message})` };
  }
}

export type { DoctorHost };
export { setupAdviceFor };

/**
 * Which host is this user actually running Siltpoke under?
 *
 * WHY — audit defect `[16]`: under an agy HOME, `doctor` printed two red rows
 * about `~/.claude/settings.json` and Claude Code's Stop-hook registration, and
 * told the user to run `/siltpoke:siltpoke-setup`. agy has neither of those files nor
 * that command; it is wired through `~/.gemini/config/hooks.json`. So the rows
 * were both false and unactionable, and `skills/siltpoke/SKILL.md` lists
 * `doctor` as available, so agy users really do reach them.
 *
 * CONSERVATIVE ON PURPOSE: this only ever reports a NON-Claude host on positive
 * evidence that one is wired. A machine with nothing detected stays
 * `claude-code`, because "Claude Code user who has not run setup yet" is a real
 * state that must keep its red row and its `/siltpoke:siltpoke-setup` advice — that row
 * is what defect `[2]` fixed, and downgrading it here would quietly undo it.
 */
export function detectDoctorHost(opts: DoctorOptions = {}): DoctorHost {
  // [81]: the copy that is running says whose it is; only otherwise is the machine read.
  return hostOfRunningCopy(opts, opts.repoRoot ?? defaultRepoRoot()) ?? hostOnThisMachine(opts);
}

/** Where this host keeps the wiring doctor should be looking at. */
export function hostWiringPath(host: DoctorHost, opts: DoctorOptions): string {
  return wiringPathFor(host, opts, opts.repoRoot ?? defaultRepoRoot());
}

function checkSettingsJson(opts: DoctorOptions): CheckResult {
  const path = join(opts.claudeHome ?? resolveClaudeHome(), "settings.json");
  const r = readJson(path);
  const name = "~/.claude/settings.json valid";
  const host = detectDoctorHost(opts);
  if (host !== "claude-code") {
    // Defect [16]: this file is Claude Code's. Asserting on it under another
    // host is not a softer check, it is a check about the wrong machine.
    return {
      name,
      pass: true,
      status: "info",
      detail: `skipped — this is ${aHost(host)} install, wired through ${hostWiringPath(host, opts)}, not ${path}`,
    };
  }
  if (!r.ok) {
    // Missing settings.json = Siltpoke not installed yet. Soft fail so doctor
    // surfaces the diagnostic without crashing on a clean machine.
    if (r.reason === "missing") {
      return { name, pass: false, detail: `${path} does not exist — ${setupAdviceFor(host)} to set Siltpoke up` };
    }
    return { name, pass: false, detail: r.detail };
  }
  if (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) {
    return { name, pass: false, detail: `${path} root is not a JSON object` };
  }
  return { name, pass: true, detail: null };
}


function checkInnerTxt(opts: DoctorOptions): CheckResult {
  const name = "~/.siltpoke/inner.txt readable";
  const path = join(opts.siltpokeHome ?? siltpokeRoot(), "inner.txt");
  if (!existsSync(path)) {
    // Absent is healthy: a fresh install with no prior statusLine to chain
    // (install.ts:295 "installing fresh") never writes inner.txt, and the
    // wrapper renders Siltpoke's face standalone in that case. Only a present-
    // but-unreadable file is a real fault.
    return { name, pass: true, detail: null };
  }
  try {
    readFileSync(path, "utf8");
    return { name, pass: true, detail: null };
  } catch (e) {
    return { name, pass: false, detail: `${path} not readable (${(e as Error).message})` };
  }
}

function checkWakeJson(opts: DoctorOptions): CheckResult {
  const name = "~/.siltpoke/wake.json healthy (absent OK)";
  const path = join(opts.siltpokeHome ?? siltpokeRoot(), "wake.json");
  if (!existsSync(path)) {
    // wake.json is 5-min TTL by design (src/cli/wake.ts:DEFAULT_TTL_MS).
    // Absent = expired-and-cleaned. Healthy state.
    return { name, pass: true, detail: null };
  }
  const r = readJson(path);
  if (!r.ok) {
    return { name, pass: false, detail: r.detail };
  }
  if (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) {
    return { name, pass: false, detail: `${path} root is not a JSON object` };
  }
  const wake = r.value as { schemaVersion?: unknown; expires_at_ms?: unknown };
  if (wake.schemaVersion !== 1) {
    return { name, pass: false, detail: `${path} schemaVersion is ${JSON.stringify(wake.schemaVersion)}, expected 1` };
  }
  if (typeof wake.expires_at_ms !== "number" || !Number.isFinite(wake.expires_at_ms)) {
    return { name, pass: false, detail: `${path} missing or non-numeric expires_at_ms field` };
  }
  return { name, pass: true, detail: null };
}

/**
 * Shows whether the once-a-day update check is on, and what it last found.
 *
 * Always passes. It is a disclosure row, not a health row: the only thing that
 * could "fail" is the user having turned it off, which is their decision. The
 * row exists so the one request siltpoke makes on its own is visible from
 * inside the product rather than only in the README — a switch nobody can find
 * is not really a switch.
 */
function checkUpdateCheck(opts: DoctorOptions): CheckResult {
  const home = opts.siltpokeHome ?? siltpokeRoot();
  const enabled = loadUpdateCheckConfigSync(home, (p, e) => readFileSync(p, e)).enabled;
  if (!enabled) {
    return {
      name: "update check",
      pass: true,
      detail: 'off (updateCheck.enabled=false in config.json) — no request is made',
    };
  }
  const path = cachePath(home);
  const cache = existsSync(path) ? parseCache(readFileSync(path, "utf8")) : null;
  const last = cache
    ? cache.latestVersion
      ? `last saw ${cache.latestVersion}`
      : "last check found nothing (offline or rate-limited)"
    : "not run yet";
  return {
    name: "update check",
    pass: true,
    detail: `on — once a day, asks GitHub for the latest version only; ${last}`,
  };
}

function checkGlobalSchema(opts: DoctorOptions): CheckResult {
  const name = "~/.siltpoke/global.json schema v3 current";
  const path = join(opts.siltpokeHome ?? siltpokeRoot(), "global.json");
  const r = readJson(path);
  if (!r.ok) {
    if (r.reason === "missing") {
      // Absent is the correct state on a fresh install, and this branch is
      // audit defect [2]. `/siltpoke:siltpoke-setup` never writes this file —
      // src/cli/install.ts has zero references to it — and src/memory/global.ts
      // creates it the first time a review awards XP. `readGlobal()` returns
      // null when it is absent and every caller falls back to defaultGlobal(),
      // so nothing is broken. Treating absent as a hard failure meant a new
      // user's very first `/siltpoke:siltpoke-doctor` reported "1 of 18 checks failed"
      // on a perfectly healthy install. The sibling wake.json and inner.txt
      // checks have carried this branch all along; this one was missing it.
      return {
        name,
        pass: true,
        status: "info",
        detail: `${path} absent — written the first time a review awards XP; nothing has reviewed yet`,
      };
    }
    return { name, pass: false, detail: r.detail };
  }
  const parsed = globalSchema.safeParse(r.value);
  if (!parsed.success) {
    // Surface the first issue (Zod gives multiple; first one is most actionable).
    const first = parsed.error.issues[0];
    const where = first?.path?.join(".") || "(root)";
    const msg = first?.message ?? "schema validation failed";
    return { name, pass: false, detail: `${path} failed schema check at \`${where}\`: ${msg}` };
  }
  return { name, pass: true, detail: null };
}

function checkSlashSymlinks(opts: DoctorOptions): CheckResult {
  // Defect [16]: slash-command symlinks live under Claude Code's commands dir
  // and the repair line names a Claude Code command (`/plugin install`).
  // Neither exists for codex (skills) or agy (its own skill surface), so under
  // a positively-detected other host this row is a question about the wrong
  // machine — and its "Reinstall:" advice is unfollowable.
  const host = detectDoctorHost(opts);
  if (host !== "claude-code") {
    return {
      name: "slash command symlinks intact",
      pass: true,
      status: "info",
      detail: `skipped — ${aHost(host)} install has no Claude Code slash-command symlinks. ${setupAdviceFor(host)} if Siltpoke is not wired.`,
    };
  }
  const platform = opts.platform ?? process.platform;
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const claudeCommandsDir = join(opts.claudeHome ?? resolveClaudeHome(), "commands");
  const pluginCommandsDir = join(repoRoot, ".claude-plugin", "commands");

  // A `/plugin install` never symlinks anything: the host loads the commands
  // straight out of the plugin's own directory. Only a from-source install
  // (`bun src/cli/install.ts`) links them into ~/.claude/commands/. So when we
  // are running AS the plugin, this check has nothing to verify — and asserting
  // on it would fail every healthy plugin install (0/8 "broken" links that were
  // never supposed to exist).
  if (isPluginInstall(opts)) {
    return {
      name: "slash commands",
      pass: true,
      status: "info",
      detail: "shipped with the plugin — no symlinks to verify",
    };
  }

  if (!existsSync(pluginCommandsDir)) {
    return {
      name: "slash command symlinks intact",
      pass: false,
      detail: `${pluginCommandsDir} does not exist — repo layout is broken`,
    };
  }
  const sourceFiles = readdirSync(pluginCommandsDir).filter((f) => f.endsWith(".md"));
  const total = sourceFiles.length;
  const broken: string[] = [];

  for (const f of sourceFiles) {
    const linkPath = join(claudeCommandsDir, f);
    const expectedTarget = join(pluginCommandsDir, f);
    if (!existsSync(linkPath)) {
      broken.push(`${f} (missing)`);
      continue;
    }
    let stat: Stats;
    try {
      stat = lstatSync(linkPath);
    } catch {
      broken.push(`${f} (lstat failed)`);
      continue;
    }

    // Windows installs COPY command files (symlink() needs elevation → EPERM).
    // A healthy command is a regular file that exists; there is no link target to verify.
    if (platform === "win32") {
      if (!stat.isFile()) {
        broken.push(`${f} (not a regular file)`);
      }
      continue;
    }

    // Unix/Darwin: expect symlinks
    if (!stat.isSymbolicLink()) {
      broken.push(`${f} (regular file, not a symlink)`);
      continue;
    }
    let target: string;
    try {
      target = readlinkSync(linkPath);
    } catch {
      broken.push(`${f} (readlink failed)`);
      continue;
    }
    if (target !== expectedTarget) {
      broken.push(`${f} (points to ${target}, expected ${expectedTarget})`);
    }
  }

  const kind = platform === "win32" ? "files" : "symlinks";
  const name = `slash command ${kind} intact (${total - broken.length}/${total})`;
  if (broken.length === 0) {
    return { name, pass: true, detail: null };
  }
  // Show first 3 broken; truncate the rest.
  const shown = broken.slice(0, 3).join("; ");
  const rest = broken.length > 3 ? ` (+${broken.length - 3} more)` : "";
  return { name, pass: false, detail: `${shown}${rest}. Reinstall: /plugin install siltpoke.` };
}

function checkConfigJson(opts: DoctorOptions): CheckResult {
  const name = "~/.siltpoke/config.json valid";
  const path = join(opts.siltpokeHome ?? siltpokeRoot(), "config.json");
  const r = readJson(path);
  if (!r.ok) {
    return { name, pass: false, detail: r.detail };
  }
  if (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) {
    return { name, pass: false, detail: `${path} root is not a JSON object` };
  }
  const cfg = r.value as Record<string, unknown>;
  const required = ["name", "species", "language"] as const;
  for (const field of required) {
    if (typeof cfg[field] !== "string" || (cfg[field] as string).length === 0) {
      return { name, pass: false, detail: `${path} missing or non-string \`${field}\` field` };
    }
  }
  return { name, pass: true, detail: null };
}

interface AgyHookEntryShape {
  type?: unknown;
  command?: unknown;
}

function checkAgyGlobalHooksJson(opts: DoctorOptions): CheckResult {
  const name = "~/.gemini/config/hooks.json siltpoke-review Stop registered (agy)";
  const path = opts.agyHooksJsonPath ?? resolveAgyHooksJsonPath();
  if (!existsSync(path)) {
    // Absent is healthy: agy is wired only if the user selected it AND it
    // was present at install time (same "wire-only-if-present" discipline
    // as codebuddy/qoder) — same discipline as checkInnerTxt's "absent OK".
    return {
      name,
      pass: true,
      status: "info",
      detail: `${path} absent — Antigravity not wired (no global hooks.json, and no agy plugin hooks.json with an agy-stop Stop entry; optional: it is wired during setup only when agy is present on the machine, same wire-only-if-present rule as codebuddy/qoder)`,
    };
  }
  const r = readJson(path);
  if (!r.ok) {
    return { name, pass: false, detail: r.detail };
  }
  if (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) {
    return { name, pass: false, detail: `${path} root is not a JSON object` };
  }
  const config = r.value as Record<string, unknown>;
  const entry = config["siltpoke-review"] as { Stop?: AgyHookEntryShape[] } | undefined;
  if (!entry) {
    return {
      name,
      pass: false,
      detail: `${path} is missing the "siltpoke-review" key. ${setupAdviceFor("antigravity")}, or edit ${path} by hand.`,
    };
  }
  const stop = Array.isArray(entry.Stop) ? entry.Stop : [];
  const hasAgyStop = stop.some(
    (h) => h.type === "command" && typeof h.command === "string" && h.command.includes("agy-stop.ts"),
  );
  if (!hasAgyStop) {
    return {
      name,
      pass: false,
      detail: `${path} "siltpoke-review".Stop has no command entry pointing at agy-stop.ts. ${setupAdviceFor("antigravity")}, or edit ${path} by hand.`,
    };
  }
  return { name, pass: true, detail: null };
}

// ---------------------------------------------------------------------------
// Orchestration + output.
// ---------------------------------------------------------------------------

/**
 * One row-producer, plus the label its row carries if it throws. `label` is
 * used ONLY on the crash path, where there is no returned row to take a name
 * from — it is not a second source of truth for the row name (audit §42.1
 * says why no equality invariant is asserted on it). Most `run`s produce one
 * row; `checkBrainRoles` produces several.
 */
export interface DoctorCheck {
  readonly label: string;
  readonly run: (opts: DoctorOptions) => CheckResult | CheckResult[];
}

export const DOCTOR_CHECKS: readonly DoctorCheck[] = [
  { label: "settings.json", run: checkSettingsJson },
  { label: "Stop hook registered", run: checkStopHook },
  { label: "codex hooks have run", run: checkCodexHooksHaveRun },
  { label: "inner.txt", run: checkInnerTxt },
  { label: "wake.json", run: checkWakeJson },
  { label: "global schema", run: checkGlobalSchema },
  { label: "slash command symlinks intact", run: checkSlashSymlinks },
  { label: "config.json", run: checkConfigJson },
  { label: "Brain health", run: checkBrainHealth },
  { label: "daemon autostart configured", run: checkAutostart },
  { label: "Brain roles", run: checkBrainRoles },
  { label: "agy hooks.json", run: (o) => withAgyPluginFallback(checkAgyGlobalHooksJson(o), o.agyHooksJsonPath) },
  { label: "project roots", run: checkProjectRoots },
  { label: "statusline interpreter runnable", run: checkStatuslineInterpreter },
  { label: "statusline renders (real run)", run: checkStatuslineRenders },
  { label: "update check", run: checkUpdateCheck },
  { label: "ripgrep available", run: (o) => checkRipgrep(o) },
  // Last: the row that explains the silence every row above can report healthy
  // through — wired, registered, rendering, and no review ever. See
  // doctor-hook-start-check.ts.
  { label: "review hook can start", run: checkReviewHookCanStart },
];

/** The row a check gets when it threw: "unknown", not "broken" — calling a
 * crash a failed check claims more than the evidence supports. */
function crashRow(label: string, err: unknown): CheckResult {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return {
    name: label,
    pass: false,
    detail: `this check crashed, so its answer is unknown — every other row below still ran. ${msg}`,
  };
}

/**
 * Run every check, and let none of them take the checklist down with it.
 *
 * Defect `[29]` (audit §36.5 / §42.1): this was an array literal, so the first
 * check to throw aborted the whole thing and `/siltpoke:siltpoke-doctor` printed nothing
 * at all — on Windows, every time. Doctor exists to speak when other things are
 * broken, so dying of the fault it reports is the one failure it cannot have.
 * `checks` is injected only by the crash-path tests.
 */
export function runAllChecks(
  opts: DoctorOptions = {},
  checks: readonly DoctorCheck[] = DOCTOR_CHECKS,
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      const produced = check.run(opts);
      results.push(...(Array.isArray(produced) ? produced : [produced]));
    } catch (err) {
      results.push(crashRow(check.label, err));
    }
  }
  return results;
}

/** The async sibling of `DoctorCheck`. Same contract, awaited. */
export interface DoctorAsyncCheck {
  readonly label: string;
  readonly run: (opts: DoctorOptions) => Promise<CheckResult | CheckResult[]>;
}

/** The rows that need I/O, in the order they are printed. */
export const DOCTOR_ASYNC_CHECKS: readonly DoctorAsyncCheck[] = [
  // The only async row that can fail the exit code — see its doc comment.
  { label: "project resolution survives cwd=/", run: checkProjectResolutionUnderRoot },
  { label: "daemon alive (/api/ping)", run: checkDaemonAlive },
  { label: "daemon running latest code", run: checkDaemonStaleness },
  { label: "index staleness", run: checkIndexStaleness },
];

/**
 * Same guard as `runAllChecks`, for the rows that need I/O. The first cut of
 * the `[29]` fix guarded the sync array and left these five inline in
 * `runDoctorCli`, three with no try/catch anywhere — the same defect, just
 * relocated.
 */
export async function runAllAsyncChecks(
  opts: DoctorOptions = {},
  checks: readonly DoctorAsyncCheck[] = DOCTOR_ASYNC_CHECKS,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      const produced = await check.run(opts);
      results.push(...(Array.isArray(produced) ? produced : [produced]));
    } catch (err) {
      results.push(crashRow(check.label, err));
    }
  }
  return results;
}

export function formatChecklist(
  results: readonly CheckResult[],
  opts: { quiet?: boolean } = {},
): string {
  const fails = results.filter((r) => !r.pass);
  const warns = results.filter((r) => r.status === "warn").length;
  if (opts.quiet) {
    if (fails.length === 0) {
      const tail = warns === 0 ? "" : `, with ${warns} warning${warns === 1 ? "" : "s"} (run without --quiet)`;
      return `siltpoke-doctor: all ${results.length} checks passed${tail}.\n`;
    }
    const names = fails.map((r) => r.name).join(" · ");
    return `siltpoke-doctor: ${fails.length} of ${results.length} checks failed (${names}). Run without --quiet for details.\n`;
  }
  const lines: string[] = ["siltpoke-doctor — checking install health", ""];
  for (const r of results) {
    // `status` (warn/info) overrides the ✓/✗ derived from `pass` for
    // warn-only / informational rows like daemon-staleness.
    const mark = r.status === "warn" ? "⚠" : r.status === "info" ? "◦" : r.pass ? "✓" : "✗";
    lines.push(`  ${mark}  ${r.name}`);
    // Show the detail for failures AND for non-✓ informational rows (the
    // staleness detail IS the message — "N commits behind", "skipped", etc.).
    if (r.detail && (!r.pass || r.status === "warn" || r.status === "info")) {
      lines.push(`       ${r.detail}`);
    }
  }
  lines.push("");
  if (fails.length === 0) {
    // A ⚠ row above "Install healthy" contradicts it (§110 W2): say so instead.
    lines.push(
      warns === 0
        ? `All ${results.length} checks passed. Install healthy.`
        : `All ${results.length} checks passed, with ${warns} warning${warns === 1 ? "" : "s"} above — read ${warns === 1 ? "it" : "them"}.`,
    );
  } else {
    lines.push(`${fails.length} of ${results.length} checks failed.`);
  }
  lines.push("");
  return lines.join("\n");
}

export function formatJson(results: readonly CheckResult[]): string {
  const failCount = results.filter((r) => !r.pass).length;
  return `${JSON.stringify(
    {
      all_pass: failCount === 0,
      fail_count: failCount,
      warn_count: results.filter((r) => r.status === "warn").length,
      checks: results,
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// CLI entry point.
// ---------------------------------------------------------------------------

/**
 * The whole `/siltpoke:siltpoke-doctor` CLI as one callable: parse flags, run every
 * check, render, hand back the text + exit code.
 *
 * Exported (rather than living inline under `import.meta.main`) so the plugin
 * multiplexer — `src/cli/plugin-cli.ts`, the single bundle a `/plugin install`
 * ships — can run doctor without duplicating this wiring. `overrides` lets the
 * multiplexer pin `repoRoot` to `$CLAUDE_PLUGIN_ROOT`, which `defaultRepoRoot()`
 * cannot derive once this module is bundled into `dist/` (the bundle sits one
 * directory below the root, not two).
 */
export async function runDoctorCli(
  argv: readonly string[],
  overrides: DoctorOptions = {},
): Promise<{ exitCode: number; output: string }> {
  const args = new Set(argv);
  const opts: DoctorOptions = {
    claudeHome: resolveClaudeHome(),
    siltpokeHome: siltpokeRoot(),
    repoRoot: defaultRepoRoot(),
    ...overrides,
  };
  // The sync install-health rows, then the I/O ones: project resolution (the
  // one async row that CAN fail the exit code — see its doc), then the four
  // warn-only rows. BOTH halves are crash-guarded; the async half used to be
  // an inline list of awaits and was the surviving half of defect `[29]`.
  const results = [...runAllChecks(opts), ...(await runAllAsyncChecks(opts))];
  const failCount = results.filter((r) => !r.pass).length;

  const output = args.has("--json")
    ? formatJson(results)
    : formatChecklist(results, { quiet: args.has("--quiet") });
  return { exitCode: failCount > 0 ? 1 : 0, output };
}

if (import.meta.main) {
  const { exitCode, output } = await runDoctorCli(process.argv.slice(2));
  process.stdout.write(output);
  process.exit(exitCode);
}
