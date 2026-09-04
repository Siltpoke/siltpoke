/**
 * Tests for checkProjectResolutionUnderRoot — the standing-guard doctor row
 * for the daemon per-request project-resolution track (T13). Asserts a live
 * project resolves via `resolveDaemonProject`, catching a silent
 * re-regression of the whole cwd=/ bug class.
 *
 * Orchestration wiring (runDoctorCli spreads this alongside the other async
 * daemon checks) lives in src/cli/doctor.ts; per-check unit tests for the 13
 * sync checks live in doctor.checks.test.ts.
 */
import { expect, test } from "bun:test";
import { checkProjectResolutionUnderRoot } from "../../src/cli/doctor";

test("passes when a live project resolves under a forced cwd=/", async () => {
  const r = await checkProjectResolutionUnderRoot({
    siltpokeHome: "/fake",
    resolve: async () => ({ source: "recent", project_root: "/r", proj_hash: "abcdef012345", project_id: "x", display_name: "r" }),
  });
  expect(r.pass).toBe(true);
  expect(r.name).toBe("project resolution survives cwd=/");
  expect(r.status).not.toBe("warn");
});

test("warns when resolution yields none (empty install is not an error)", async () => {
  const r = await checkProjectResolutionUnderRoot({
    siltpokeHome: "/fake",
    resolve: async () => ({ source: "none", project_root: null, proj_hash: null, project_id: null, display_name: null }),
  });
  expect(r.status).toBe("warn");
  expect(r.pass).toBe(true);
});

test("fails when the resolver returns a non-none source with no project_root (genuine fault)", async () => {
  const r = await checkProjectResolutionUnderRoot({
    siltpokeHome: "/fake",
    resolve: async () => ({ source: "stale", project_root: null }),
  });
  expect(r.pass).toBe(false);
  expect(r.detail).toContain("stale");
});

test("defaults to the real resolveDaemonProject when no resolve override is given (no throw)", async () => {
  const r = await checkProjectResolutionUnderRoot({ siltpokeHome: "/definitely-does-not-exist-siltpoke-home" });
  expect(typeof r.pass).toBe("boolean");
  expect(r.name).toBe("project resolution survives cwd=/");
});
