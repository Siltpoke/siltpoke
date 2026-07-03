/**
 * Doctor check 8 — last Brain call health.
 *
 * Split from doctor.checks.test.ts to keep that file under the 400-LOC
 * ratchet. Check implementation: src/cli/doctor-brain-check.ts.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runAllChecks, type CheckResult } from "../../src/cli/doctor";
import {
  freshBrainHealth,
  recordFailure,
  recordSuccess,
  readBrainHealth,
  writeBrainHealth,
} from "../../src/state/brain-health";
import {
  setupDoctorTmp,
  teardownDoctorTmp,
  type DoctorTmp,
} from "./_doctor-fixtures";

// ── check 8: last Brain call health ─────────────────────────────────────────

describe("doctor — check 8: last Brain call health", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c8-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function brainCheck(reverify?: () => boolean): CheckResult {
    const checks = runAllChecks({
      claudeHome: env.claudeHome,
      siltpokeHome: env.siltpokeHome,
      brainReverifyFn: reverify,
    });
    return checks[7]!;
  }

  test("check ALWAYS renders — passes with 'none recorded' when no health file exists", () => {
    const r = brainCheck();
    expect(r.name).toContain("last Brain call");
    expect(r.pass).toBe(true);
    expect(r.name).toContain("none recorded");
  });

  test("failing state shows result, class, reason excerpt, and timestamp", () => {
    let h = freshBrainHealth();
    h = recordFailure(h, {
      class: "ambiguous", exit_code: 1, stderr_excerpt: "exit 1, no stderr",
      ts: "2026-06-11T09:00:00.000Z",
    });
    writeBrainHealth(env.siltpokeHome, h);
    const r = brainCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("ambiguous");
    expect(r.detail).toContain("exit 1, no stderr");
    expect(r.detail).toContain("2026-06-11T09:00:00.000Z");
  });

  test("after a success the check passes AND retains the last-failure record with timestamp", () => {
    let h = freshBrainHealth();
    h = recordFailure(h, {
      class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN",
      ts: "2026-06-11T09:00:00.000Z",
    });
    h = recordSuccess(h, "2026-06-11T10:00:00.000Z");
    writeBrainHealth(env.siltpokeHome, h);
    const r = brainCheck();
    expect(r.pass).toBe(true);
    expect(r.name).toContain("ok");
    expect(r.name).toContain("2026-06-11T10:00:00.000Z");
    expect(r.name).toContain("resource");
    expect(r.name).toContain("2026-06-11T09:00:00.000Z");
  });

  test("binary-missing permanent breaker is CLEARED by a passing deterministic re-verify", () => {
    let h = freshBrainHealth();
    h = recordFailure(h, {
      class: "permanent", exit_code: null,
      stderr_excerpt: "ENOENT: no such file or directory, posix_spawn 'claude'",
      ts: "2026-06-11T09:00:00.000Z",
    });
    writeBrainHealth(env.siltpokeHome, h);
    const r = brainCheck(() => true);
    expect(readBrainHealth(env.siltpokeHome).breaker).toBeNull();
    expect(r.detail ?? r.name).toContain("re-verify");
  });

  test("auth-flavored permanent breaker stays latched — re-verify cannot prove auth fixed", () => {
    let h = freshBrainHealth();
    h = recordFailure(h, {
      class: "permanent", exit_code: 1,
      stderr_excerpt: "Invalid API key · Please run /login",
      ts: "2026-06-11T09:00:00.000Z",
    });
    writeBrainHealth(env.siltpokeHome, h);
    brainCheck(() => true);
    expect(readBrainHealth(env.siltpokeHome).breaker?.class).toBe("permanent");
  });
});
