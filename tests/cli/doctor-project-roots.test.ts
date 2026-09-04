/**
 * Tests for the project-root liveness check.
 *
 * The failure this check exists to make visible: a project's `project_root` is
 * an absolute path recorded at registration time, and nothing updates it when
 * the directory is moved or renamed. Every surface that resolves a project
 * filters on `existsSync(project_root)`, so a stale root removes the project
 * from the dashboard, the repo switcher and /knowledge — while every one of
 * them still returns success. Measured 2026-08-13: nine of ten registered
 * projects had dead roots and not one surface reported it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkProjectRoots } from "../../src/cli/doctor-project-roots-check";
import { type DoctorTmp, setupDoctorTmp, teardownDoctorTmp } from "./_doctor-fixtures";

function writeProject(home: string, id: string, projectRoot: string, displayName = id): void {
  const dir = join(home, "projects", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "memory.json"),
    JSON.stringify({ schemaVersion: 3, project_id: id, project_root: projectRoot, display_name: displayName }),
  );
}

describe("doctor — project roots", () => {
  let env: DoctorTmp;

  beforeEach(() => {
    env = setupDoctorTmp("siltpoke-doctor-roots-");
  });

  afterEach(() => {
    teardownDoctorTmp(env);
  });

  test("passes when there are no registered projects at all", () => {
    // A fresh install has no projects/ directory. That is not a failure.
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.pass).toBe(true);
  });

  test("passes when every project root exists", () => {
    writeProject(env.siltpokeHome, "aaaa1111", env.tmp);
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.pass).toBe(true);
    expect(r.detail).toBeNull();
  });

  test("fails and names the project when a root no longer exists", () => {
    // The display name is deliberately unrelated to the temp-dir prefix
    // (`siltpoke-doctor-roots-`). When it was "siltpoke", the public
    // snapshot's repo-name scrub rewrote it to "siltpoke" — which the NEXT
    // assertion's path already contains, so this one became implied and stopped
    // checking that the detail names the project at all.
    writeProject(env.siltpokeHome, "bbbb2222", join(env.tmp, "gone"), "my-project");
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("my-project");
    expect(r.detail).toContain(join(env.tmp, "gone"));
  });

  test("reports every dead root, not just the first", () => {
    writeProject(env.siltpokeHome, "cccc3333", join(env.tmp, "gone-a"), "alpha");
    writeProject(env.siltpokeHome, "dddd4444", join(env.tmp, "gone-b"), "beta");
    writeProject(env.siltpokeHome, "eeee5555", env.tmp, "alive");
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("alpha");
    expect(r.detail).toContain("beta");
    expect(r.detail).not.toContain("alive");
  });

  test("says how many of how many, so the scale is visible at a glance", () => {
    // "9 of 10" was the real number when this was found by hand. A bare list
    // does not convey that the install is almost entirely dead.
    writeProject(env.siltpokeHome, "ffff6666", join(env.tmp, "gone"), "alpha");
    writeProject(env.siltpokeHome, "aaaa7777", env.tmp, "alive");
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.detail).toContain("1 of 2");
  });

  test("does NOT point at a remedy that cannot be run", () => {
    // `siltpoke relocate` is implemented (src/cli/relocate.ts) but is not
    // registered in the CLI dispatcher and is not built into dist/, so
    // `siltpoke-cli relocate` answers "unknown subcommand". A remedy line
    // naming it would send the reader down a path that does not exist —
    // the exact failure shape this repo has already shipped twice
    // (doctor's Stop-hook remedy, and the close-gate's scope-narrowing hint).
    // Re-admit the mention only in the same change that wires the subcommand.
    writeProject(env.siltpokeHome, "bbbb8888", join(env.tmp, "gone"), "alpha");
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.detail).not.toContain("relocate");
  });

  test("a SYMLINKED project directory is still inspected", () => {
    // `Dirent.isDirectory()` reflects lstat and is false for a symlink to a
    // directory. Filtering the listing on it would drop this store without
    // ever reading it — and the check would report pass while being blind to
    // the project, which is the exact failure it exists to catch elsewhere.
    const real = join(env.tmp, "real-store");
    mkdirSync(real, { recursive: true });
    writeFileSync(
      join(real, "memory.json"),
      JSON.stringify({ project_id: "link0001", project_root: join(env.tmp, "gone"), display_name: "linked-repo" }),
    );
    mkdirSync(join(env.siltpokeHome, "projects"), { recursive: true });
    symlinkSync(real, join(env.siltpokeHome, "projects", "link0001"));

    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("linked-repo");
  });

  test("an unreadable store is counted and reported, not dropped from the total", () => {
    // `existsSync` returns false for a permission error exactly as it does for
    // a missing file. Gating on it would remove this project from BOTH the
    // count and the list — silently understating how much of the install is
    // broken, which is precisely what this check is for.
    const dir = join(env.siltpokeHome, "projects", "locked01");
    mkdirSync(dir, { recursive: true });
    const memory = join(dir, "memory.json");
    writeFileSync(memory, JSON.stringify({ project_id: "locked01", project_root: env.tmp }));
    chmodSync(memory, 0o000);
    try {
      const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
      expect(r.pass).toBe(false);
      expect(r.detail).toContain("locked01");
      expect(r.detail).toContain("1 of 1");
    } finally {
      chmodSync(memory, 0o600); // so teardown can remove it
    }
  });

  test("a plain file sitting in projects/ is not counted as a project", () => {
    mkdirSync(join(env.siltpokeHome, "projects"), { recursive: true });
    writeFileSync(join(env.siltpokeHome, "projects", ".DS_Store"), "junk");
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.pass).toBe(true);
  });

  test("the headline stays truthful when the rows are not all dead roots", () => {
    // "N of M point at a path that no longer exists" would be false for an
    // unreadable store. Mixed causes get a neutral verb plus the dead-root count.
    writeProject(env.siltpokeHome, "aaaa0001", join(env.tmp, "gone"), "alpha");
    const dir = join(env.siltpokeHome, "projects", "bbbb0002");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memory.json"), "{ not json");
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.detail).toContain("could not be confirmed");
    expect(r.detail).toContain("1 point at a path that no longer exists");
  });

  test("a malformed memory.json is reported, not silently skipped", () => {
    // Skipping it quietly would under-report the very thing this check exists
    // to surface.
    const dir = join(env.siltpokeHome, "projects", "cccc9999");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memory.json"), "{ not json");
    const r = checkProjectRoots({ siltpokeHome: env.siltpokeHome });
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("cccc9999");
  });
});
