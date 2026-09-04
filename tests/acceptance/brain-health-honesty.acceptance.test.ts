/**
 * ACCEPTANCE tests for Brain-health honesty & observability.
 *
 * REGISTER: outside-observable behavior ONLY.
 *   - The Stop hook is exercised as a REAL subprocess (`bun src/hooks/on-stop.ts`
 *     with a stdin event), with a fake `claude` executable placed first on PATH —
 *     no internal function is stubbed.
 *   - Observations: CLI stdout (doctor --json, card), HTTP responses
 *     (/history, /api/brain-health, /), and files written as side effects
 *     (~/.siltpoke/brain-calls.jsonl, ~/.siltpoke/brain-health.json) plus a
 *     fake-claude invocation counter (proves spawn count from outside).
 *
 * Anti-vacuous: every absence assertion is paired with a presence control in
 * the same test (suppressed row absent WHILE control row present; ⚠ absent at
 * ×1 WHILE present at ×2; no-spawn under open breaker WHILE the same setup
 * spawns with a closed breaker).
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import { mountCriticRoutes } from "../../src/web/routes/critic";
import { mountTimelineRoutes } from "../../src/web/routes/timeline";
import { mountHomeRoutes } from "../../src/web/routes/home";
import { mountBrainHealthRoute } from "../../src/daemon/routes/brain-health";
import { makeGitRepo } from "../_shared/git-fixture";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HOOK_ENTRY = join(REPO_ROOT, "src", "hooks", "on-stop.ts");
const DOCTOR_ENTRY = join(REPO_ROOT, "src", "cli", "doctor.ts");
const CARD_ENTRY = join(REPO_ROOT, "src", "cli", "card.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeHome(tag: string): { tmpHome: string; homeBase: string; binDir: string; counter: string } {
  const tmpHome = mkdtempSync(join(tmpdir(), `sp-acc-${tag}-`));
  tempDirs.push(tmpHome);
  const binDir = join(tmpHome, "bin");
  mkdirSync(binDir, { recursive: true });
  return {
    tmpHome,
    homeBase: join(tmpHome, ".siltpoke"),
    binDir,
    counter: join(tmpHome, "claude-invocations.log"),
  };
}

interface BrainOutputFixture {
  bubble: string;
  confidence: "low" | "medium" | "high";
}

/** Build the stdout payload a real `claude -p --output-format json` would emit. */
function successPayload(opts: BrainOutputFixture): string {
  const brainOutput = {
    mood: "happy",
    pose: "base",
    bubble_short: opts.bubble,
    bubble_long: "",
    critique_for_claude: "",
    severity: "info",
    confidence: opts.confidence,
    xp_earned_events: [],
    evidence: [],
  };
  return `${JSON.stringify([
    {
      type: "result",
      result: JSON.stringify(brainOutput),
      total_cost_usd: 0.0012,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  ])}\n`;
}

/** Install a fake `claude` that succeeds with the given Brain output. */
function installSucceedingClaude(
  h: ReturnType<typeof makeHome>,
  opts: BrainOutputFixture,
): void {
  const payloadPath = join(h.tmpHome, "claude-success-payload.json");
  writeFileSync(payloadPath, successPayload(opts));
  const script = `#!/bin/sh
cat > /dev/null
printf 'x\\n' >> "${h.counter}"
cat "${payloadPath}"
exit 0
`;
  writeFileSync(join(h.binDir, "claude"), script);
  chmodSync(join(h.binDir, "claude"), 0o755);
}

/** Install a fake `claude` that fails with the given stderr + exit code. */
function installFailingClaude(
  h: ReturnType<typeof makeHome>,
  opts: { stderr: string; exitCode: number },
): void {
  const stderrLine =
    opts.stderr.length > 0
      ? `printf '%s\\n' ${JSON.stringify(opts.stderr)} >&2\n`
      : "";
  const script = `#!/bin/sh
cat > /dev/null
printf 'x\\n' >> "${h.counter}"
${stderrLine}exit ${opts.exitCode}
`;
  writeFileSync(join(h.binDir, "claude"), script);
  chmodSync(join(h.binDir, "claude"), 0o755);
}

function invocationCount(counterPath: string): number {
  if (!existsSync(counterPath)) return 0;
  return readFileSync(counterPath, "utf8").split("\n").filter((l) => l.length > 0).length;
}

/**
 * Build a Stop event + transcript with one real Edit'd file so the hook's
 * code-change gate passes. Mirrors what Claude Code feeds the hook on stdin.
 */
function buildStopEvent(tmpHome: string, name: string, sessionId: string): object {
  const transcriptPath = join(tmpHome, `${name}.jsonl`);
  const cwd = join(tmpHome, name);
  // A real repo: the ⏱ review-unit gate answers a cwd git knows nothing about
  // with `not_a_git_repo` and skips before any of this test's subject matter.
  makeGitRepo(cwd);
  const editedPath = join(cwd, "src", "dummy.ts");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(editedPath, "export const dummy = 1;\n");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: "user", message: { role: "user", content: `msg ${name}` } })}\n${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `reply ${name}` },
          { type: "tool_use", name: "Edit", input: { file_path: editedPath } },
        ],
      },
    })}\n`,
  );
  return {
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
  };
}

function subprocessEnv(h: { tmpHome: string; binDir: string }, extraPath?: string): Record<string, string> {
  // Fake-claude bin dir FIRST so it shadows any real `claude`. Real PATH kept
  // behind it so `bun` itself resolves.
  const path = extraPath ?? `${h.binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  return {
    HOME: h.tmpHome,
    PATH: path,
    // Legacy (non-tool-augmented) path = the guarded callBrain choke point under test.
    // The tool-augmented critic path wraps the SAME makeGuardedCallBrain (run-critic.ts).
    SILTPOKE_TOOL_AUGMENTED: "0",
  };
}

/** Run the REAL Stop-hook entry as a subprocess with the event on stdin. */
async function runStopHook(
  h: { tmpHome: string; binDir: string },
  event: object,
  envOverride?: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(["bun", HOOK_ENTRY], {
    cwd: REPO_ROOT,
    env: envOverride ?? subprocessEnv(h),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(event));
  proc.stdin.end();
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr };
}

async function runCli(
  entry: string,
  args: string[],
  h: { tmpHome: string; binDir: string },
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", entry, ...args], {
    cwd: REPO_ROOT,
    env: subprocessEnv(h),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  return { exitCode, stdout };
}

function readBrainCallsJsonl(homeBase: string): string {
  const p = join(homeBase, "brain-calls.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

interface HealthFile {
  consecutive_failures: number;
  last_success_ts: string | null;
  last_failure: {
    class: string;
    exit_code: number | null;
    stderr_excerpt: string;
    ts: string;
    attempts?: number;
  } | null;
  breaker: { class: string; opened_at: string; next_eligible_at: string } | null;
}

function readHealthFile(homeBase: string): HealthFile {
  return JSON.parse(readFileSync(join(homeBase, "brain-health.json"), "utf8")) as HealthFile;
}

function historyApp(homeBase: string): Hono {
  const app = new Hono();
  mountCriticRoutes(app, { homeBase });
  // /history is a 302 to /timeline now — mount the timeline route too so
  // requestHistoryView can follow the redirect and keep asserting the
  // RENDERED page (row filtering is the behavior under test, not the
  // redirect).
  mountTimelineRoutes(app, { homeBase });
  return app;
}

/**
 * GET /history…, assert the redirect to /timeline (query preserved),
 * then return the rendered /timeline response the redirect points at.
 */
async function requestHistoryView(homeBase: string, path: string): Promise<Response> {
  const app = historyApp(homeBase);
  const redirect = await app.request(path);
  expect(redirect.status).toBe(302);
  const location = redirect.headers.get("location") ?? "";
  expect(location).toStartWith("/timeline");
  return app.request(location);
}

function brainHealthApp(homeBase: string): Hono {
  const app = new Hono();
  mountBrainHealthRoute(app, { homeBase });
  return app;
}

function homeApp(homeBase: string): Hono {
  const app = new Hono();
  mountHomeRoutes(app, { homeBase });
  return app;
}

interface BrainHealthApi {
  success: boolean;
  data: {
    show: boolean;
    line: string;
    consecutive_failures: number;
    last_success_ts: string | null;
  };
}

interface DoctorJson {
  checks: { name: string; pass: boolean; detail: string | null }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty effective bubble → no activity row; jsonl telemetry kept
// ─────────────────────────────────────────────────────────────────────────────

test(
  "empty-bubble critic turn produces NO dashboard history row (jsonl line still written); control non-empty turn DOES produce a row",
  async () => {
    const h = makeHome("empty-bubble");

    // Turn 1: Brain succeeds but with confidence=low → effective bubble blank
    // (the "low-confidence blank" writer).
    installSucceedingClaude(h, { bubble: "SUPPRESSED-BUBBLE", confidence: "low" });
    const r1 = await runStopHook(h, buildStopEvent(h.tmpHome, "turn-supp", "sess-supp"));
    expect(r1.exitCode).toBe(0);

    // Turn 2 (control): non-empty bubble at high confidence → row must render.
    installSucceedingClaude(h, { bubble: "CONTROL-BUBBLE", confidence: "high" });
    const r2 = await runStopHook(h, buildStopEvent(h.tmpHome, "turn-ctrl", "sess-ctrl"));
    expect(r2.exitCode).toBe(0);

    // Both Brain calls actually ran (door opened before contents).
    expect(invocationCount(h.counter)).toBe(2);

    // jsonl telemetry: suppressed turn's line IS written, flagged.
    const jsonl = readBrainCallsJsonl(h.homeBase);
    const suppLine = jsonl
      .split("\n")
      .find((l) => l.includes("sess-supp"));
    expect(suppLine).toBeDefined();
    expect(suppLine!).toContain('"bubble_suppressed":true');
    // The original bubble text is retained in the telemetry line for audit…
    expect(suppLine!).toContain("SUPPRESSED-BUBBLE");

    // …but the rendered history view (now /timeline) filters the row out entirely.
    const res = await requestHistoryView(h.homeBase, "/history?status=all");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("CONTROL-BUBBLE"); // control row present (non-vacuous)
    expect(html).not.toContain("SUPPRESSED-BUBBLE"); // suppressed row absent
    expect(html).not.toContain("(no bubble)");
  },
  120_000,
);

// ─────────────────────────────────────────────────────────────────────────────
// Legacy fired rows with empty/missing bubble_short filtered at render
// ─────────────────────────────────────────────────────────────────────────────

test(
  "legacy fired rows with empty-string AND missing bubble_short are filtered from rendered history; non-empty legacy row stays",
  async () => {
    const h = makeHome("legacy-rows");
    mkdirSync(h.homeBase, { recursive: true });

    const ts = new Date().toISOString();
    const legacyRow = (sessionId: string, brainOutput: Record<string, unknown>) =>
      JSON.stringify({
        timestamp: ts,
        session_id: sessionId,
        cwd: "/tmp/legacy-proj",
        duration_ms: 1000,
        brain_output: {
          mood: "happy",
          pose: "base",
          bubble_long: "",
          critique_for_claude: "",
          severity: "low",
          confidence: "high",
          ...brainOutput,
        },
        usage: { input_tokens: 1, output_tokens: 1, total_cost_usd: 0.001 },
        gating_decision: "high",
      });

    // Pre-fix legacy data written straight to the persisted log (the seam the
    // dashboard reads). Covers BOTH the ""-string and the missing-field case.
    writeFileSync(
      join(h.homeBase, "brain-calls.jsonl"),
      [
        legacyRow("sess-legacy-empty", {
          bubble_short: "",
          bubble_long: "LEGACY-EMPTY-STRING-MARKER",
        }),
        legacyRow("sess-legacy-missing", {
          // bubble_short field entirely absent
          bubble_long: "LEGACY-MISSING-FIELD-MARKER",
        }),
        legacyRow("sess-legacy-visible", { bubble_short: "LEGACY-VISIBLE" }),
      ].join("\n") + "\n",
    );

    const res = await requestHistoryView(h.homeBase, "/history");
    expect(res.status).toBe(200);
    const html = await res.text();

    // Control row renders (proves the page actually showed fired rows).
    expect(html).toContain("LEGACY-VISIBLE");
    // Empty-string and missing-field rows are gone — including their expand
    // panels (bubble_long markers) — and no "(no bubble)" placeholder remains.
    expect(html).not.toContain("LEGACY-EMPTY-STRING-MARKER");
    expect(html).not.toContain("LEGACY-MISSING-FIELD-MARKER");
    expect(html).not.toContain("(no bubble)");
  },
  30_000,
);

// ─────────────────────────────────────────────────────────────────────────────
// Doctor "last Brain call" check: result, class, reason excerpt, timestamp
// ─────────────────────────────────────────────────────────────────────────────

test(
  "after a Brain failure, /siltpoke-doctor shows a last-Brain-call check with result + failure class + reason excerpt + timestamp; the check renders even on a fresh install",
  async () => {
    // Control first: fresh home — the check ALWAYS renders ("regardless of
    // current health"), here as the none-recorded state.
    const fresh = makeHome("doctor-fresh");
    const freshDoctor = await runCli(DOCTOR_ENTRY, ["--json"], fresh);
    const freshJson = JSON.parse(freshDoctor.stdout) as DoctorJson;
    const freshCheck = freshJson.checks.find((c) => c.name.startsWith("last Brain call"));
    expect(freshCheck).toBeDefined();
    expect(freshCheck!.name).toContain("none recorded yet");

    // Real failure handled end-to-end: auth-flavored permanent failure.
    const h = makeHome("doctor-failure");
    installFailingClaude(h, { stderr: "Invalid API key. Please run /login", exitCode: 1 });
    const r = await runStopHook(h, buildStopEvent(h.tmpHome, "turn-doctor-fail", "sess-doctor-fail"));
    expect(r.exitCode).toBe(0);
    expect(invocationCount(h.counter)).toBe(1); // failure really happened

    const health = readHealthFile(h.homeBase);
    expect(health.last_failure).not.toBeNull();
    const failTs = health.last_failure!.ts;

    const doctor = await runCli(DOCTOR_ENTRY, ["--json"], h);
    const json = JSON.parse(doctor.stdout) as DoctorJson;
    const check = json.checks.find((c) => c.name.startsWith("last Brain call"));
    expect(check).toBeDefined();
    // Result…
    expect(check!.name).toContain("failing");
    expect(check!.pass).toBe(false);
    // …failure class, reason excerpt, timestamp.
    expect(check!.detail ?? "").toContain("permanent");
    expect(check!.detail ?? "").toContain("Invalid API key");
    expect(check!.detail ?? "").toContain(failTs);
  },
  120_000,
);

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ surfacing: ≥2 consecutive transient; permanent at FIRST failure
// ─────────────────────────────────────────────────────────────────────────────

test(
  "1 transient failure does NOT surface; 2 consecutive transient failures surface a classified ⚠ on the card AND the dashboard health strip; auth-permanent surfaces at the FIRST failure",
  async () => {
    const h = makeHome("surface-warn");
    // Ambiguous = transient class (exit 1, no markers) — the dominant real case.
    installFailingClaude(h, { stderr: "", exitCode: 1 });

    // Failure ×1 → must NOT surface (control proving the test can fail).
    await runStopHook(h, buildStopEvent(h.tmpHome, "turn-1", "sess-warn-1"));
    expect(invocationCount(h.counter)).toBe(1);
    const cardAfter1 = await runCli(CARD_ENTRY, [], h);
    expect(cardAfter1.stdout).not.toContain("⚠ brain");
    const api1 = (await (await brainHealthApp(h.homeBase).request("/api/brain-health")).json()) as BrainHealthApi;
    expect(api1.data.show).toBe(false);
    expect(api1.data.consecutive_failures).toBe(1);

    // Failure ×2 → surfaces with the classified reason.
    await runStopHook(h, buildStopEvent(h.tmpHome, "turn-2", "sess-warn-2"));
    expect(invocationCount(h.counter)).toBe(2);
    const cardAfter2 = await runCli(CARD_ENTRY, [], h);
    expect(cardAfter2.stdout).toContain("2 ambiguous failures");
    const api2 = (await (await brainHealthApp(h.homeBase).request("/api/brain-health")).json()) as BrainHealthApi;
    expect(api2.data.show).toBe(true);
    expect(api2.data.line).toContain("2 ambiguous failures");

    // Dashboard strip (SSR'd home) carries the same line.
    const homeRes = await homeApp(h.homeBase).request("/");
    expect(homeRes.status).toBe(200);
    const homeHtml = await homeRes.text();
    expect(homeHtml).toContain("brain-health-strip");
    expect(homeHtml).toContain("2 ambiguous failures");

    // Permanent class (auth) surfaces at the FIRST failure.
    const hp = makeHome("surface-warn-perm");
    installFailingClaude(hp, { stderr: "Invalid API key. Please run /login", exitCode: 1 });
    await runStopHook(hp, buildStopEvent(hp.tmpHome, "turn-perm", "sess-warn-perm"));
    expect(invocationCount(hp.counter)).toBe(1);
    const cardPerm = await runCli(CARD_ENTRY, [], hp);
    expect(cardPerm.stdout).toContain("1 permanent failure");
    // The permanent branch keeps the reason IN the line — the statusline has
    // no tooltip, and for this class the reason is the action.
    expect(cardPerm.stdout).toContain("Invalid API key");
    expect(cardPerm.stdout).toContain("/siltpoke-wake");
  },
  120_000,
);

test(
  "binary-missing (claude not on PATH) is permanent-class and surfaces at the FIRST failure",
  async () => {
    const h = makeHome("surface-warn-enoent");
    // PATH contains bun but NO claude anywhere — the real binary-missing case.
    const bunDir = dirname(process.execPath);
    const env = {
      HOME: h.tmpHome,
      PATH: `${bunDir}:/usr/bin:/bin`,
      SILTPOKE_TOOL_AUGMENTED: "0",
    };
    const r = await runStopHook(h, buildStopEvent(h.tmpHome, "turn-noent", "sess-warn-enoent"), env);
    expect(r.exitCode).toBe(0);

    // Permanent-class (auth / binary missing) surfaces at the FIRST failure.
    const health = readHealthFile(h.homeBase);
    expect(health.last_failure).not.toBeNull();
    expect(health.last_failure!.class).toBe("permanent");
    const card = await runCli(CARD_ENTRY, [], h);
    expect(card.stdout).toContain("1 permanent failure");
    expect(card.stdout).toContain("/siltpoke-wake");
  },
  120_000,
);

// ─────────────────────────────────────────────────────────────────────────────
// Next success auto-clears card line + strip; doctor retains last failure
// ─────────────────────────────────────────────────────────────────────────────

test(
  "a surfaced ⚠ clears automatically on the next Brain success (card + strip), and doctor retains the last-failure record with timestamp",
  async () => {
    const h = makeHome("auto-clear");

    // Surface the signal: 2 consecutive ambiguous failures.
    installFailingClaude(h, { stderr: "", exitCode: 1 });
    await runStopHook(h, buildStopEvent(h.tmpHome, "fail-1", "sess-clear-1"));
    await runStopHook(h, buildStopEvent(h.tmpHome, "fail-2", "sess-clear-2"));
    const failTs = readHealthFile(h.homeBase).last_failure!.ts;

    // Verify surfaced BEFORE recovery (the assertion below can fail).
    const cardBefore = await runCli(CARD_ENTRY, [], h);
    expect(cardBefore.stdout).toContain("2 ambiguous failures");
    const apiBefore = (await (await brainHealthApp(h.homeBase).request("/api/brain-health")).json()) as BrainHealthApi;
    expect(apiBefore.data.show).toBe(true);

    // Next Brain call succeeds — no user ack involved.
    installSucceedingClaude(h, { bubble: "RECOVERED", confidence: "high" });
    await runStopHook(h, buildStopEvent(h.tmpHome, "recover", "sess-clear-3"));
    expect(invocationCount(h.counter)).toBe(3);

    // Card line gone…
    const cardAfter = await runCli(CARD_ENTRY, [], h);
    expect(cardAfter.stdout).not.toContain("⚠ brain");
    // …strip/API gone…
    const apiAfter = (await (await brainHealthApp(h.homeBase).request("/api/brain-health")).json()) as BrainHealthApi;
    expect(apiAfter.data.show).toBe(false);
    expect(apiAfter.data.last_success_ts).not.toBeNull();
    const homeHtml = await (await homeApp(h.homeBase).request("/")).text();
    expect(homeHtml).not.toContain("brain-health-strip");
    // …doctor retains the last-failure record WITH its timestamp.
    const doctor = await runCli(DOCTOR_ENTRY, ["--json"], h);
    const json = JSON.parse(doctor.stdout) as DoctorJson;
    const check = json.checks.find((c) => c.name.startsWith("last Brain call"));
    expect(check).toBeDefined();
    expect(check!.name).toContain("ok @");
    expect(check!.name).toContain(`last failure: ambiguous @ ${failTs}`);
  },
  120_000,
);

// ─────────────────────────────────────────────────────────────────────────────
// Throttle gets EXACTLY one in-process retry; other classes get ZERO
// ─────────────────────────────────────────────────────────────────────────────

test(
  "throttle failure → exactly ONE in-process retry (2 spawns) with attempt count in telemetry; resource / ambiguous / permanent → ZERO retries (1 spawn)",
  async () => {
    // Throttle: rate-limit marker + retry-after: 0 (honored → fast test).
    const ht = makeHome("retry-throttle");
    installFailingClaude(ht, { stderr: "rate limit exceeded. retry-after: 0", exitCode: 1 });
    await runStopHook(ht, buildStopEvent(ht.tmpHome, "turn-throttle", "sess-retry-throttle"));
    expect(invocationCount(ht.counter)).toBe(2); // exactly one retry, no more
    const healthT = readHealthFile(ht.homeBase);
    expect(healthT.last_failure!.class).toBe("throttle");
    expect(healthT.last_failure!.attempts).toBe(2); // attempt count in health record
    const jsonlT = readBrainCallsJsonl(ht.homeBase);
    expect(jsonlT).toContain("class=throttle attempts=2"); // …and in brain-calls.jsonl

    // Ambiguous (exit 1, empty tails): zero retries.
    const ha = makeHome("retry-ambiguous");
    installFailingClaude(ha, { stderr: "", exitCode: 1 });
    await runStopHook(ha, buildStopEvent(ha.tmpHome, "turn-ambig", "sess-retry-ambiguous"));
    expect(invocationCount(ha.counter)).toBe(1);
    expect(readHealthFile(ha.homeBase).last_failure!.class).toBe("ambiguous");
    expect(readHealthFile(ha.homeBase).last_failure!.attempts).toBe(1);

    // Resource (EAGAIN marker): zero retries.
    const hr = makeHome("retry-resource");
    installFailingClaude(hr, { stderr: "EAGAIN: resource temporarily unavailable, posix_spawn", exitCode: 1 });
    await runStopHook(hr, buildStopEvent(hr.tmpHome, "turn-res", "sess-retry-resource"));
    expect(invocationCount(hr.counter)).toBe(1);
    expect(readHealthFile(hr.homeBase).last_failure!.class).toBe("resource");

    // Permanent (auth marker): zero retries.
    const hpm = makeHome("retry-perm");
    installFailingClaude(hpm, { stderr: "Invalid API key. Please run /login", exitCode: 1 });
    await runStopHook(hpm, buildStopEvent(hpm.tmpHome, "turn-perm", "sess-retry-perm"));
    expect(invocationCount(hpm.counter)).toBe(1);
    expect(readHealthFile(hpm.homeBase).last_failure!.class).toBe("permanent");
  },
  240_000,
);

// ─────────────────────────────────────────────────────────────────────────────
// Open breaker: no spawn + skip record; permanent clears via doctor re-verify
// ─────────────────────────────────────────────────────────────────────────────

test(
  "open resource breaker → Stop hook spawns NO claude and writes a skip record with the breaker reason (first failing tick DID spawn = control)",
  async () => {
    const h = makeHome("breaker-open");
    // Tick 1: resource failure (exit 137-style EAGAIN marker) opens the 15min breaker.
    installFailingClaude(h, { stderr: "EAGAIN: resource temporarily unavailable", exitCode: 1 });
    await runStopHook(h, buildStopEvent(h.tmpHome, "turn-open", "sess-breaker-open-1"));
    expect(invocationCount(h.counter)).toBe(1); // control: closed breaker spawned
    const health = readHealthFile(h.homeBase);
    expect(health.breaker).not.toBeNull();
    expect(health.breaker!.class).toBe("resource");

    // Tick 2 inside the window: no spawn, skip record with the reason.
    installSucceedingClaude(h, { bubble: "MUST-NOT-RUN", confidence: "high" });
    await runStopHook(h, buildStopEvent(h.tmpHome, "turn-skip", "sess-breaker-open-2"));
    expect(invocationCount(h.counter)).toBe(1); // STILL 1 → claude never spawned

    const jsonl = readBrainCallsJsonl(h.homeBase);
    const skipLine = jsonl.split("\n").find((l) => l.includes("sess-breaker-open-2"));
    expect(skipLine).toBeDefined();
    expect(skipLine!).toContain('"skipped":"brain_breaker_open"');
    expect(skipLine!).toContain('"breaker_class":"resource"');
    expect(skipLine!).toContain("resource breaker open until"); // breaker reason
  },
  120_000,
);

test(
  "permanent breaker stays latched past any time window; a passing doctor re-verify (claude back on PATH) clears it and the next tick spawns again",
  async () => {
    const h = makeHome("breaker-perm");
    mkdirSync(h.homeBase, { recursive: true });

    // Seed the persisted health file (the documented state seam) with a
    // binary-missing permanent failure latched 2 HOURS ago — long past every
    // transient window, so only the latch can explain a skip.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(h.homeBase, "brain-health.json"),
      JSON.stringify({
        schema_version: 1,
        last_attempt_ts: twoHoursAgo,
        last_success_ts: null,
        consecutive_failures: 1,
        last_failure: {
          class: "permanent",
          exit_code: null,
          stderr_excerpt: "spawn claude ENOENT",
          ts: twoHoursAgo,
          attempts: 1,
        },
        breaker: {
          class: "permanent",
          opened_at: twoHoursAgo,
          next_eligible_at: twoHoursAgo,
        },
        retry_budget: { date: "", outer_retries_used: 0 },
      }),
    );

    // Tick inside the latch (claude IS available again): still skipped.
    installSucceedingClaude(h, { bubble: "LATCHED", confidence: "high" });
    await runStopHook(h, buildStopEvent(h.tmpHome, "turn-latched", "sess-breaker-perm-1"));
    expect(invocationCount(h.counter)).toBe(0); // latched: time does NOT clear it
    const jsonl1 = readBrainCallsJsonl(h.homeBase);
    expect(jsonl1).toContain('"skipped":"brain_breaker_open"');
    expect(jsonl1).toContain("permanent failure latched");

    // User action: doctor re-verify — fake claude is on PATH → deterministic
    // re-verify passes and clears ONLY the breaker.
    const doctor = await runCli(DOCTOR_ENTRY, ["--json"], h);
    const json = JSON.parse(doctor.stdout) as DoctorJson;
    const check = json.checks.find((c) => c.name.startsWith("last Brain call"));
    expect(check?.detail ?? "").toContain("breaker cleared by re-verify");
    expect(readHealthFile(h.homeBase).breaker).toBeNull();

    // Next tick spawns again.
    await runStopHook(h, buildStopEvent(h.tmpHome, "turn-after-clear", "sess-breaker-perm-2"));
    expect(invocationCount(h.counter)).toBe(1);
  },
  120_000,
);
