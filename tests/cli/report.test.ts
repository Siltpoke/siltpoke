import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, restartDashboard } from "../../src/cli/report";

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-report-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const noon = new Date("2026-05-14T12:00:00Z");

test("buildReport: writes self-contained HTML to outPath", async () => {
  writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({ name: "Mochi", species: "cat", language: "en" }),
  );
  const outPath = join(homeBase, "report.html");
  const result = await buildReport({ homeBase, outPath, now: () => noon });
  expect(result.outPath).toBe(outPath);
  const html = readFileSync(outPath, "utf8");
  expect(html).toContain("<!doctype html>");
  expect(html).toContain("Mochi");
  expect(html).toContain("cat");
  expect(html).toContain("LAST 7 DAYS");
  expect(html).toContain("RECENT CALLS");
  // every right-column section is now collapsible via <details class="panel">
  expect(html).toContain("details class=\"panel\"");
});

test("buildReport: surfaces pending critiques per project", async () => {
  const project = join(tmp, "proj-x");
  const archive = join(project, ".siltpoke", "critiques", "archive", "2026-05-14");
  mkdirSync(archive, { recursive: true });
  const mdPath = join(archive, "c-rep1.md");
  writeFileSync(
    mdPath,
    `---\nschemaVersion: 1\ncritique_id: c-rep1\nstatus: pending\n---\nbody`,
  );
  writeFileSync(
    join(project, ".siltpoke", "critiques", "history.jsonl"),
    `${JSON.stringify({
      timestamp: noon.toISOString(),
      critique_id: "c-rep1",
      cwd: project,
      severity: "high",
      confidence: "high",
      bubble_short: "ship me",
      path: mdPath,
    })}\n`,
  );
  // Need a brain-calls row so the project is discovered.
  appendFileSync(
    join(homeBase, "brain-calls.jsonl"),
    `${JSON.stringify({ timestamp: noon.toISOString(), cwd: project })}\n`,
  );

  const outPath = join(homeBase, "report.html");
  const result = await buildReport({ homeBase, outPath, now: () => noon });
  expect(result.pendingTotal).toBe(1);
  expect(result.projectsTouched).toBe(1);
  const html = readFileSync(outPath, "utf8");
  expect(html).toContain("c-rep1");
  expect(html).toContain("ship me");
  expect(html).toContain("proj-x");
});

test("buildReport: escapes user-provided text into HTML safely", async () => {
  writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({ name: "<img src=x onerror=alert(1)>", species: "cat" }),
  );
  const outPath = join(homeBase, "report.html");
  await buildReport({ homeBase, outPath, now: () => noon });
  const html = readFileSync(outPath, "utf8");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

test("buildReport: empty state still produces a valid HTML doc", async () => {
  const outPath = join(homeBase, "report.html");
  const result = await buildReport({ homeBase, outPath, now: () => noon });
  expect(result.pendingTotal).toBe(0);
  expect(result.projectsTouched).toBe(0);
  const html = readFileSync(outPath, "utf8");
  expect(html).toContain("</html>");
  expect(html).toContain("inbox clean");
});

// --- restartDashboard branch selection (FIX A: unify the two restart paths) ---
//
// When a launchd job is installed for the daemon, restartDashboard must
// delegate to runRestart() (the launchd `kickstart` path SwiftBar already
// uses) INSTEAD of the manual SIGTERM + detached-spawn path below — the
// manual path starts a non-launchd process that squats the port and breaks
// the next launchd-based restart. Both `exec` (the launchd-job-installed
// probe) and `runLaunchdRestart` are injected here, so this never touches a
// real launchd domain, a real pidfile, or the real :9876 port.

test("restartDashboard: a launchd job present → delegates to runLaunchdRestart, does not touch the manual path", async () => {
  let launchdCalls = 0;
  await restartDashboard({
    homeBase,
    exec: () => ({ status: 0 }), // `launchctl print` exit 0 ⇒ job installed
    uid: 501,
    runLaunchdRestart: async () => { launchdCalls++; return 0; },
  });
  expect(launchdCalls).toBe(1);
  // The manual path would have written/read siltpoked.pid via stopReport +
  // openDashboard; asserting no pidfile appeared is a cheap proxy for "the
  // manual branch never ran" without needing to mock fetch/Bun.spawn too.
  expect(existsSync(join(homeBase, "siltpoked.pid"))).toBe(false);
});

test("restartDashboard: launchd delegate failing surfaces as a thrown error", async () => {
  await expect(
    restartDashboard({
      homeBase,
      exec: () => ({ status: 0 }),
      uid: 501,
      runLaunchdRestart: async () => 1, // launchd restart reported failure
    }),
  ).rejects.toThrow();
});

// NB: the "no launchd job → manual fallback" branch is deliberately NOT
// exercised here, same rationale as the pre-existing "dashboard /
// restart-daemon are deliberately NOT exercised" note at the bottom of
// tests/cli/plugin-cli.test.ts — its two remaining steps (stopReport's poll,
// then openDashboard's alive-check) both hit the hardcoded real DASHBOARD_URL
// (127.0.0.1:9876/api/ping) with no injection seam. On a dev machine where the
// real launchd daemon is up (the common case for this repo), a test
// exercising this branch would observe THAT daemon's answers, not anything
// under this test's tmp homeBase — unreliable at best, and it would be
// touching the very daemon these instructions say not to break. The fallback
// path itself is UNCHANGED by this fix (identical stopReport + openDashboard
// call as before FIX A); its manual-reasoning check is: `isLaunchdJobInstalled`
// is read once, synchronously, before any of that code runs, so a `false`
// result provably cannot reach `runLaunchdRestart` — confirmed by inspection
// of the `if (isLaunchdJobInstalled(...)) { ...; return; }` guard in
// src/cli/report.ts, and by `bunx tsc --noEmit` typechecking the branch.
