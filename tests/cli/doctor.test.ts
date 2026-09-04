/**
 * Tests for src/cli/doctor.ts — orchestration + output formatters.
 *
 * Per-check unit tests live in tests/cli/doctor.checks.test.ts (file split
 * to keep each test file under the 400 LOC warn threshold).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type CheckResult,
  formatChecklist,
  formatJson,
  runAllChecks,
} from "../../src/cli/doctor";
import { type DoctorTmp, setupDoctorTmp, teardownDoctorTmp } from "./_doctor-fixtures";

describe("doctor — orchestration", () => {
  let env: DoctorTmp;

  beforeEach(() => {
    env = setupDoctorTmp("siltpoke-doctor-orch-");
  });

  afterEach(() => {
    teardownDoctorTmp(env);
  });

  // Count bumped 7 → 8 on 2026-06-11 (last-Brain-call health check);
  // 8 → 9 on 2026-07-07 (track #6 T5: daemon-autostart presence check);
  // 9 → 10 on 2026-07-07 (track #7 T5: reviewer-provider check);
  // 10 → 11 on 2026-07-10 (agy track: hooks.json siltpoke-review Stop check);
  // 11 → 13 on 2026-07-11 (single-brain #10 S1: the single reviewer-provider
  // row is replaced by three per-role rows — chat/review/extract);
  // 13 → 14 on 2026-08-11 (knowledge render cache: warn-only row reporting
  // whether deriveRenderVersion() can enable itself on this installation);
  // 14 → 15 on 2026-08-13 (registered project roots still exist — the
  // path-identity audit found nine of ten roots dead with no surface saying so).
  test("runAllChecks returns 14 entries (one per check)", () => {
    const results = runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome });
    expect(results).toHaveLength(14);
    for (const r of results) {
      expect(typeof r.name).toBe("string");
      expect(typeof r.pass).toBe("boolean");
      expect(r.detail === null || typeof r.detail === "string").toBe(true);
    }
  });

  test("runAllChecks check names are stable identifiers in order", () => {
    const results = runAllChecks({
      claudeHome: env.claudeHome,
      siltpokeHome: env.siltpokeHome,
      pluginInstall: false,
    });
    const names = results.map((r) => r.name);
    expect(names[0]).toContain("settings.json");
    expect(names[1]).toContain("Stop hook");
    expect(names[2]).toContain("inner.txt");
    expect(names[3]).toContain("wake.json");
    expect(names[4]).toContain("global.json");
    expect(names[5]).toContain("symlinks");
    expect(names[6]).toContain("config.json");
    expect(names[8]).toContain("autostart");
    expect(names[9]).toBe("brain role: chat");
    expect(names[10]).toBe("brain role: review");
    expect(names[11]).toBe("brain role: extract");
    expect(names[12]).toContain("hooks.json");
  });

  // A `/plugin install` creates no symlinks — the host loads commands from the
  // plugin dir. Before this branch, doctor reported "0/8 broken" and exited 1
  // on a perfectly healthy plugin install. The symlink row must become a
  // pass/info row when running as the plugin.
  test("under a plugin install the symlink check is an info row, never a failure", () => {
    const asPlugin = runAllChecks({
      claudeHome: env.claudeHome,
      siltpokeHome: env.siltpokeHome,
      pluginInstall: true,
    });
    const row = asPlugin[5];
    expect(row?.name).toBe("slash commands");
    expect(row?.pass).toBe(true);
    expect(row?.status).toBe("info");

    // And with pluginInstall:false against a temp home that has no symlinks,
    // the SAME check fails — proving the branch is what flips the verdict, not
    // some unrelated environmental accident.
    const fromSource = runAllChecks({
      claudeHome: env.claudeHome,
      siltpokeHome: env.siltpokeHome,
      pluginInstall: false,
    });
    expect(fromSource[5]?.pass).toBe(false);
  });
});

describe("doctor — formatters", () => {
  const happy: CheckResult[] = [
    { name: "a", pass: true, detail: null },
    { name: "b", pass: true, detail: null },
  ];
  const mixed: CheckResult[] = [
    { name: "a", pass: true, detail: null },
    { name: "b", pass: false, detail: "broken because reasons" },
    { name: "c", pass: true, detail: null },
  ];

  test("formatChecklist verbose all-pass shows 'Install healthy'", () => {
    const out = formatChecklist(happy);
    expect(out).toContain("✓");
    expect(out).toContain("All 2 checks passed");
    expect(out).toContain("Install healthy");
    expect(out).not.toContain("✗");
  });

  test("formatChecklist verbose failure shows detail line under row", () => {
    const out = formatChecklist(mixed);
    expect(out).toContain("✗  b");
    expect(out).toContain("broken because reasons");
    expect(out).toContain("1 of 3 checks failed");
  });

  test("formatChecklist quiet all-pass = single-line summary", () => {
    const out = formatChecklist(happy, { quiet: true });
    expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(out).toContain("all 2 checks passed");
  });

  test("formatChecklist quiet failure lists failing names", () => {
    const out = formatChecklist(mixed, { quiet: true });
    expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    expect(out).toContain("1 of 3");
    expect(out).toContain("b");
  });

  test("formatJson emits valid JSON with all_pass + checks", () => {
    const out = formatJson(mixed);
    const parsed = JSON.parse(out);
    expect(parsed.all_pass).toBe(false);
    expect(parsed.fail_count).toBe(1);
    expect(parsed.checks).toHaveLength(3);
    expect(parsed.checks[1].pass).toBe(false);
    expect(parsed.checks[1].detail).toBe("broken because reasons");
  });

  test("formatJson all_pass = true when no failures", () => {
    const out = formatJson(happy);
    const parsed = JSON.parse(out);
    expect(parsed.all_pass).toBe(true);
    expect(parsed.fail_count).toBe(0);
  });

  // status override (warn-only / informational rows, e.g. daemon-staleness)
  test("formatChecklist renders ⚠ for status:'warn' and its detail (pass=true)", () => {
    const withWarn: CheckResult[] = [
      { name: "ok-row", pass: true, detail: null },
      { name: "stale-row", pass: true, detail: "daemon 3 commits behind — restart", status: "warn" },
    ];
    const out = formatChecklist(withWarn);
    expect(out).toContain("⚠  stale-row");
    expect(out).toContain("daemon 3 commits behind — restart");
    // warn-only: still "all passed" + healthy (no exit-code impact).
    expect(out).toContain("All 2 checks passed");
  });

  test("formatChecklist renders ◦ for status:'info' and its detail", () => {
    const withInfo: CheckResult[] = [
      { name: "skip-row", pass: true, detail: "skipped (daemon down)", status: "info" },
    ];
    const out = formatChecklist(withInfo);
    expect(out).toContain("◦  skip-row");
    expect(out).toContain("skipped (daemon down)");
    expect(out).not.toContain("✗");
  });
});
