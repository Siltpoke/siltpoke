// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * /siltpoke-doctor — install-health diagnostic CLI.
 *
 * Runs 8 checks and prints a ✓/✗ checklist. Exits 0 if all checks pass,
 * 1 if any fail. Read-only diagnostic with ONE deliberate exception:
 * check 8 clears a binary-missing permanent Brain breaker when the
 * deterministic re-verify (claude back on PATH) passes.
 *
 * Flags:
 *   --json    Emit { all_pass, fail_count, checks: [{name, pass, detail}] }
 *   --quiet   Suppress per-check output; print 1-line summary
 */
import { readFileSync, existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveClaudeHome, siltpokeRoot } from "../installer/paths";
import { globalSchema } from "../memory/schema-v3";
import { checkBrainHealth } from "./doctor-brain-check";
import { checkDaemonStaleness } from "./doctor-daemon-check";

function defaultRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/cli/doctor.ts → src/cli → src → repo
  return resolve(here, "..", "..");
}

export interface CheckResult {
  /** Short human-readable check name (used as checklist row label). */
  name: string;
  /** True iff the check passed. */
  pass: boolean;
  /**
   * Failure detail (path, schema mismatch, etc.) shown under the ✗ row in
   * verbose mode. null when pass = true.
   */
  detail: string | null;
  /**
   * Optional visual status override for warn-only / informational rows that
   * pass=true but want a non-✓ symbol (⚠ warn, ◦ info). Absent → derive the
   * symbol from `pass` (✓/✗) — the default for all install-health checks.
   * Used by the daemon-staleness check: staleness is warn-only, so it
   * passes but renders ⚠/◦ rather than ✓ to flag a stale daemon.
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
   * Deterministic Brain re-verify — defaults to
   * "claude binary resolvable on PATH". Injectable for tests.
   */
  brainReverifyFn?: () => boolean;
  /**
   * Override the /api/daemon-health URL for the daemon-staleness check.
   * Defaults to the local daemon. Injectable for tests.
   */
  daemonHealthUrl?: string;
  /**
   * Injectable fetch for the daemon-staleness check — lets tests stub the
   * daemon response without a live server. Defaults to global `fetch`.
   */
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
      return { name, pass: false, detail: `${path} does not exist — run \`bun src/cli/install.ts\` to set up Siltpoke` };
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
  const name = "Stop hook registered (http + command pair)";
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
  // Look for any matcher that has BOTH an http entry pointing at /hooks/stop AND
  // a command entry running on-stop.ts. Doctor doesn't know the exact secret, so
  // this is a shape check, not a content check (see hasStopHookPair for the
  // strict equality version used by the installer).
  for (const m of stopArr as HookMatcherShape[]) {
    const hooks = Array.isArray(m?.hooks) ? m.hooks : [];
    const hasHttp = hooks.some(
      (h) => h.type === "http" && typeof h.url === "string" && h.url.includes("/hooks/stop"),
    );
    const hasCmd = hooks.some(
      (h) => h.type === "command" && typeof h.command === "string" && h.command.includes("on-stop.ts"),
    );
    if (hasHttp && hasCmd) return { name, pass: true, detail: null };
  }
  return {
    name,
    pass: false,
    detail: "no Stop hook matcher contains both an http entry (url ~ /hooks/stop) and a command fallback (~ on-stop.ts). Run `bun src/cli/install.ts` to re-register.",
  };
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
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  const claudeCommandsDir = join(opts.claudeHome ?? resolveClaudeHome(), "commands");
  const pluginCommandsDir = join(repoRoot, ".claude-plugin", "commands");

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

  const name = `slash command symlinks intact (${total - broken.length}/${total})`;
  if (broken.length === 0) {
    return { name, pass: true, detail: null };
  }
  // Show first 3 broken; truncate the rest.
  const shown = broken.slice(0, 3).join("; ");
  const rest = broken.length > 3 ? ` (+${broken.length - 3} more)` : "";
  return { name, pass: false, detail: `${shown}${rest}. Run \`bun src/cli/install.ts\` to re-link.` };
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

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  const opts: DoctorOptions = {
    claudeHome: resolveClaudeHome(),
    siltpokeHome: siltpokeRoot(),
  };
  // 8 sync install-health checks + 1 async daemon-staleness check (fetches
  // /api/daemon-health). The daemon check is warn-only (pass=true in
  // every reachable state) so it never affects the exit code.
  const results = [...runAllChecks(opts), await checkDaemonStaleness(opts)];
  const failCount = results.filter((r) => !r.pass).length;

  if (args.has("--json")) {
    process.stdout.write(formatJson(results));
  } else {
    process.stdout.write(formatChecklist(results, { quiet: args.has("--quiet") }));
  }
  process.exit(failCount > 0 ? 1 : 0);
}
