// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * /siltpoke-doctor — install-health diagnostic CLI.
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
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgyHooksJsonPath, resolveClaudeHome, siltpokeRoot } from "../installer/paths";
import { resolveDaemonProject } from "../memory/active-project";
import { globalSchema } from "../memory/schema-v3";
import { checkBrainHealth } from "./doctor-brain-check";
import { checkAutostart, checkDaemonAlive, checkDaemonStaleness } from "./doctor-daemon-check";
import { checkIndexStaleness } from "./doctor-index-staleness-check";
import { pluginOwnsStopHook } from "./doctor-plugin-hook-check";
import { checkProjectRoots } from "./doctor-project-roots-check";
import { checkBrainRoles } from "./doctor-reviewer-check";

export function defaultRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/doctor.ts → src/cli → src → repo
  return resolve(here, "..", "..");
}

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
  /** Override repo root (used for slash symlink target verification). */
  repoRoot?: string;
  /**
   * True when running as an installed plugin (`/plugin install`), where the
   * host loads commands from the plugin dir and no symlinks exist. Defaults to
   * "is CLAUDE_PLUGIN_ROOT set". Turns the symlink check into an info row.
   */
  pluginInstall?: boolean;
  /** Deterministic Brain re-verify — defaults to "claude resolvable on PATH". For tests. */
  brainReverifyFn?: () => boolean;
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
  /** Override the eval-provenance sidecar path (written by run-eval.ts's `--provider codex`). Defaults to `<repoRoot>/src/eval/caller-impact/verdict.provenance.json`. */
  evalProvenancePath?: string;
  /** Override the agy hooks.json path for the check below. Defaults to resolveAgyHooksJsonPath(). */
  agyHooksJsonPath?: string;
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
function readJson(path: string): { ok: true; value: unknown } | { ok: false; reason: "missing" | "corrupt" | "unreadable"; detail: string } {
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

function checkSettingsJson(opts: DoctorOptions): CheckResult {
  const path = join(opts.claudeHome ?? resolveClaudeHome(), "settings.json");
  const r = readJson(path);
  const name = "~/.claude/settings.json valid";
  if (!r.ok) {
    // Missing settings.json = Siltpoke not installed yet. Soft fail so doctor
    // surfaces the diagnostic without crashing on a clean machine.
    if (r.reason === "missing") {
      return { name, pass: false, detail: `${path} does not exist — run \`/siltpoke-setup\` to set up Siltpoke` };
    }
    return { name, pass: false, detail: r.detail };
  }
  if (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) {
    return { name, pass: false, detail: `${path} root is not a JSON object` };
  }
  return { name, pass: true, detail: null };
}

interface HookEntryShape {
  type?: unknown;
  url?: unknown;
  command?: unknown;
}
interface HookMatcherShape {
  hooks?: HookEntryShape[];
}

function checkStopHook(opts: DoctorOptions): CheckResult {
  const name = "Stop hook registered (curl fast path + command pair)";

  // Plugin era: hooks/hooks.json (shipped with the plugin, copied to
  // ${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json on install) owns the Stop hook,
  // not settings.json — same "plugin owns this, not settings.json" pattern
  // as checkSlashSymlinks below. A healthy plugin install has an EMPTY
  // settings.json hooks.Stop[]; asserting on it here would fail every
  // correct plugin install. Only fall through to the legacy settings.json
  // check when the plugin manifest itself doesn't declare a Stop hook.
  const isPluginInstall = opts.pluginInstall ?? Boolean(process.env.CLAUDE_PLUGIN_ROOT);
  if (isPluginInstall && pluginOwnsStopHook(opts)) {
    return {
      name,
      pass: true,
      status: "info",
      detail: "plugin-owned — hooks/hooks.json declares the Stop hook (settings.json hooks.Stop[] is expected empty)",
    };
  }

  const path = join(opts.claudeHome ?? resolveClaudeHome(), "settings.json");
  const r = readJson(path);
  if (!r.ok) {
    return { name, pass: false, detail: `${path} not readable — settings.json must exist first` };
  }
  if (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)) {
    return { name, pass: false, detail: `${path} root is not a JSON object — cannot read hooks.Stop` };
  }
  const settings = r.value as { hooks?: { Stop?: unknown } };
  const stopArr = settings.hooks?.Stop;
  if (!Array.isArray(stopArr) || stopArr.length === 0) {
    return { name, pass: false, detail: "hooks.Stop[] is missing or empty in settings.json" };
  }
  const shape = scanStopMatchers(stopArr as HookMatcherShape[]);
  if (shape === "curl") return { name, pass: true, detail: null };
  if (shape === "legacy") {
    // Pre-track-#6 http fast path still works but prints Claude Code's red
    // ECONNREFUSED when the daemon is down — healthy, migration recommended.
    return {
      name,
      pass: true,
      status: "info",
      detail: "legacy http Stop hook shape detected — run `/siltpoke-setup` to migrate to the silent curl fast path",
    };
  }
  return {
    name,
    pass: false,
    detail: "no Stop hook matcher contains both the curl fast path (command ~ curl … /hooks/stop) and a command fallback (~ on-stop.ts). Run `/siltpoke-setup` to re-register.",
  };
}

/**
 * Scan Stop matchers for the canonical curl+on-stop pair (track #6; written by
 * settings-mutator.ts buildStopCurlCommand) or the legacy http+on-stop pair.
 * Shape check, not content check — doctor doesn't know the secret.
 */
function scanStopMatchers(matchers: HookMatcherShape[]): "curl" | "legacy" | "none" {
  let sawLegacyPair = false;
  for (const m of matchers) {
    const hooks = Array.isArray(m?.hooks) ? m.hooks : [];
    const cmds = hooks
      .filter((h) => h.type === "command" && typeof h.command === "string")
      .map((h) => h.command as string);
    const hasCurl = cmds.some((c) => c.includes("curl") && c.includes("/hooks/stop"));
    const hasCmd = cmds.some((c) => c.includes("on-stop.ts"));
    const hasHttp = hooks.some(
      (h) => h.type === "http" && typeof h.url === "string" && h.url.includes("/hooks/stop"),
    );
    if (hasCurl && hasCmd) return "curl";
    if (hasHttp && hasCmd) sawLegacyPair = true;
  }
  return sawLegacyPair ? "legacy" : "none";
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

function checkGlobalSchema(opts: DoctorOptions): CheckResult {
  const name = "~/.siltpoke/global.json schema v3 current";
  const path = join(opts.siltpokeHome ?? siltpokeRoot(), "global.json");
  const r = readJson(path);
  if (!r.ok) {
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
  if (opts.pluginInstall ?? Boolean(process.env.CLAUDE_PLUGIN_ROOT)) {
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
    let stat;
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
    let target;
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

function checkAgyHooksJson(opts: DoctorOptions): CheckResult {
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
      detail: `${path} absent — Antigravity not wired (optional; agy wiring isn't part of /siltpoke-setup yet — wire it from a source checkout if you want it)`,
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
      detail: `${path} is missing the "siltpoke-review" key (agy wiring isn't part of /siltpoke-setup yet — edit ${path} manually, or re-run the installer from a source checkout).`,
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
      detail: `${path} "siltpoke-review".Stop has no command entry pointing at agy-stop.ts (agy wiring isn't part of /siltpoke-setup yet — edit ${path} manually, or re-run the installer from a source checkout).`,
    };
  }
  return { name, pass: true, detail: null };
}

/**
 * Standing guard for the whole cwd=/ project-resolution bug class (daemon
 * per-request project-resolution track, T13). Runs the same resolver the
 * daemon uses for every request (`resolveDaemonProject`, src/memory/active-
 * project.ts) and asserts a live project resolves, so a silent re-regression
 * becomes a visible doctor row instead of a symptom discovered days later.
 *
 * `resolveDaemonProject` is already cwd-independent (it resolves from
 * ?repo=/pin/recency against the projects store, never `process.cwd()`), so
 * this check does NOT force `process.chdir("/")` — that would mutate the
 * live CLI process's cwd for every check that runs after it (a much bigger
 * side effect than a diagnostic warrants) without adding coverage the
 * resolver's own cwd-independence doesn't already give us. The value here is
 * a STANDING assertion that a live project resolves, not a cwd probe.
 *
 * Async (queries the projects store), so it is NOT folded into the sync
 * `runAllChecks()` array — it runs alongside the other async daemon checks
 * in `runDoctorCli` below, following that same async-check pattern, and
 * (unlike the warn-only daemon rows) DOES affect the exit code: a resolved
 * source with no `project_root` is a genuine fault, not a healthy-empty state.
 */
export async function checkProjectResolutionUnderRoot(
  opts: DoctorOptions & {
    /** Injectable resolver seam. Defaults to the real `resolveDaemonProject`. For tests. */
    resolve?: (input: { home: string }) => Promise<{ source: string; project_root: string | null }>;
  },
): Promise<CheckResult> {
  const name = "project resolution survives cwd=/";
  const home = opts.siltpokeHome ?? siltpokeRoot();
  const resolveFn = opts.resolve ?? ((i: { home: string }) => resolveDaemonProject({ home: i.home }));
  const r = await resolveFn({ home });
  if (r.source === "none") {
    // Empty install (no projects registered yet) is not an error — warn only.
    return { name, pass: true, status: "warn", detail: "no active project yet — run a review or open a repo" };
  }
  if (!r.project_root) {
    return { name, pass: false, detail: `resolver returned source=${r.source} but no project_root` };
  }
  return { name, pass: true, detail: null };
}

// ---------------------------------------------------------------------------
// Orchestration + output.
// ---------------------------------------------------------------------------

export function runAllChecks(opts: DoctorOptions = {}): CheckResult[] {
  return [
    checkSettingsJson(opts),
    checkStopHook(opts),
    checkInnerTxt(opts),
    checkWakeJson(opts),
    checkGlobalSchema(opts),
    checkSlashSymlinks(opts),
    checkConfigJson(opts),
    checkBrainHealth(opts),
    checkAutostart(opts),
    ...checkBrainRoles(opts),
    checkAgyHooksJson(opts),
    checkProjectRoots(opts),
  ];
}

export function formatChecklist(
  results: readonly CheckResult[],
  opts: { quiet?: boolean } = {},
): string {
  const fails = results.filter((r) => !r.pass);
  if (opts.quiet) {
    if (fails.length === 0) {
      return `siltpoke-doctor: all ${results.length} checks passed.\n`;
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
    lines.push(`All ${results.length} checks passed. Install healthy.`);
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
 * The whole `/siltpoke-doctor` CLI as one callable: parse flags, run every
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
  // 15 sync install-health checks, then the async project-resolution check
  // (CAN fail the exit code — see checkProjectResolutionUnderRoot doc), then
  // 4 async warn-only rows (daemon alive/staleness, index staleness, tracks.yaml)
  // that never affect it.
  const results = [
    ...runAllChecks(opts),
    await checkProjectResolutionUnderRoot(opts),
    await checkDaemonAlive(opts),
    await checkDaemonStaleness(opts),
    await checkIndexStaleness(opts), // ← slice ②, warn-only
  ];
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
