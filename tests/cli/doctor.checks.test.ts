/**
 * Unit tests for each of the 7 individual doctor checks in src/cli/doctor.ts.
 *
 * Orchestration + formatter tests live in tests/cli/doctor.test.ts.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runAllChecks, type CheckResult } from "../../src/cli/doctor";
import {
  setupDoctorTmp,
  teardownDoctorTmp,
  validGlobalV3,
  type DoctorTmp,
} from "./_doctor-fixtures";

// ── check 1: settings.json valid ───────────────────────────────────────────

describe("doctor — check 1: settings.json valid", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c1-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function settingsCheck(): CheckResult {
    return runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome })[0]!;
  }

  test("passes when settings.json is a valid object", () => {
    writeFileSync(join(env.claudeHome, "settings.json"), JSON.stringify({ statusLine: { command: "x" } }));
    const r = settingsCheck();
    expect(r.pass).toBe(true);
    expect(r.detail).toBeNull();
  });

  test("fails when settings.json is missing", () => {
    const r = settingsCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("does not exist");
  });

  test("fails when settings.json is corrupt JSON", () => {
    writeFileSync(join(env.claudeHome, "settings.json"), "{ not json");
    const r = settingsCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("not valid JSON");
  });

  test("fails when settings.json root is not an object", () => {
    writeFileSync(join(env.claudeHome, "settings.json"), "[]");
    const r = settingsCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("not a JSON object");
  });

  test("fails when settings.json root is null", () => {
    writeFileSync(join(env.claudeHome, "settings.json"), "null");
    const r = settingsCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("not a JSON object");
  });
});

// ── check 2: Stop hook registered ──────────────────────────────────────────

describe("doctor — check 2: Stop hook registered", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c2-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function writeSettings(body: unknown): void {
    writeFileSync(join(env.claudeHome, "settings.json"), JSON.stringify(body));
  }
  function hookCheck(): CheckResult {
    return runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome })[1]!;
  }

  test("passes when Stop matcher has both http and command entries", () => {
    writeSettings({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [
            { type: "http", url: "http://127.0.0.1:9876/hooks/stop" },
            { type: "command", command: "bun /path/to/src/hooks/on-stop.ts" },
          ],
        }],
      },
    });
    expect(hookCheck().pass).toBe(true);
  });

  test("fails when hooks.Stop is missing", () => {
    writeSettings({});
    const r = hookCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("hooks.Stop");
  });

  test("fails when matcher has only http entry (no command fallback)", () => {
    writeSettings({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:9876/hooks/stop" }] }] },
    });
    const r = hookCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("both an http entry");
  });

  test("fails when matcher has only command entry (no http)", () => {
    writeSettings({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "bun /path/on-stop.ts" }] }] },
    });
    expect(hookCheck().pass).toBe(false);
  });

  test("fails when http url doesn't point at /hooks/stop", () => {
    writeSettings({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [
            { type: "http", url: "http://127.0.0.1:9876/other" },
            { type: "command", command: "bun on-stop.ts" },
          ],
        }],
      },
    });
    expect(hookCheck().pass).toBe(false);
  });
});

// ── check 3: inner.txt readable ────────────────────────────────────────────

describe("doctor — check 3: inner.txt readable", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c3-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function innerCheck(): CheckResult {
    return runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome })[2]!;
  }

  test("passes when inner.txt exists and is readable", () => {
    writeFileSync(join(env.siltpokeHome, "inner.txt"), "anything");
    expect(innerCheck().pass).toBe(true);
  });

  test("passes with empty inner.txt", () => {
    writeFileSync(join(env.siltpokeHome, "inner.txt"), "");
    expect(innerCheck().pass).toBe(true);
  });

  test("passes when inner.txt is missing (fresh install, no inner statusline to chain)", () => {
    const r = innerCheck();
    expect(r.pass).toBe(true);
  });
});

// ── check 4: wake.json healthy ─────────────────────────────────────────────

describe("doctor — check 4: wake.json healthy", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c4-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function wakeCheck(): CheckResult {
    return runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome })[3]!;
  }

  test("passes when wake.json is absent (expired/cleaned is healthy)", () => {
    expect(wakeCheck().pass).toBe(true);
  });

  test("passes with fresh wake.json (valid schema)", () => {
    writeFileSync(join(env.siltpokeHome, "wake.json"), JSON.stringify({ schemaVersion: 1, expires_at_ms: Date.now() + 60_000 }));
    expect(wakeCheck().pass).toBe(true);
  });

  test("passes with expired wake.json (timestamp in past — still valid shape)", () => {
    writeFileSync(join(env.siltpokeHome, "wake.json"), JSON.stringify({ schemaVersion: 1, expires_at_ms: 1 }));
    expect(wakeCheck().pass).toBe(true);
  });

  test("fails when wake.json has wrong schemaVersion", () => {
    writeFileSync(join(env.siltpokeHome, "wake.json"), JSON.stringify({ schemaVersion: 99, expires_at_ms: Date.now() }));
    const r = wakeCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("schemaVersion");
  });

  test("fails when wake.json has corrupt JSON", () => {
    writeFileSync(join(env.siltpokeHome, "wake.json"), "{ broken");
    const r = wakeCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("not valid JSON");
  });

  test("fails when wake.json missing expires_at_ms field", () => {
    writeFileSync(join(env.siltpokeHome, "wake.json"), JSON.stringify({ schemaVersion: 1 }));
    const r = wakeCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("expires_at_ms");
  });
});

// ── check 5: global.json schema v3 ─────────────────────────────────────────

describe("doctor — check 5: global.json schema v3", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c5-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function globalCheck(): CheckResult {
    return runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome })[4]!;
  }

  test("passes when global.json matches schema v3", () => {
    writeFileSync(join(env.siltpokeHome, "global.json"), JSON.stringify(validGlobalV3()));
    expect(globalCheck().pass).toBe(true);
  });

  test("fails when global.json is missing", () => {
    const r = globalCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("does not exist");
  });

  test("fails when global.json schemaVersion is wrong", () => {
    const body = validGlobalV3();
    body.schemaVersion = 2;
    writeFileSync(join(env.siltpokeHome, "global.json"), JSON.stringify(body));
    const r = globalCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("schemaVersion");
  });
});

// ── check 6: slash command symlinks ────────────────────────────────────────

describe("doctor — check 6: slash command symlinks", () => {
  let env: DoctorTmp;
  let fakeRepo: string;

  beforeEach(() => {
    env = setupDoctorTmp("c6-");
    fakeRepo = join(env.tmp, "repo");
    mkdirSync(join(env.claudeHome, "commands"), { recursive: true });
    mkdirSync(join(fakeRepo, ".claude-plugin", "commands"), { recursive: true });
    for (const name of ["alpha.md", "beta.md", "gamma.md"]) {
      writeFileSync(join(fakeRepo, ".claude-plugin", "commands", name), "x");
    }
  });

  afterEach(() => { teardownDoctorTmp(env); });

  function linkAll(): void {
    for (const name of ["alpha.md", "beta.md", "gamma.md"]) {
      symlinkSync(
        join(fakeRepo, ".claude-plugin", "commands", name),
        join(env.claudeHome, "commands", name),
      );
    }
  }
  function symlinksCheck(): CheckResult {
    return runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome, repoRoot: fakeRepo })[5]!;
  }

  test("passes when all symlinks exist with correct targets", () => {
    linkAll();
    const r = symlinksCheck();
    expect(r.pass).toBe(true);
    expect(r.name).toContain("3/3");
  });

  test("fails when one symlink is missing", () => {
    symlinkSync(join(fakeRepo, ".claude-plugin", "commands", "alpha.md"), join(env.claudeHome, "commands", "alpha.md"));
    const r = symlinksCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("missing");
  });

  test("fails when one entry is a regular file (not a symlink)", () => {
    linkAll();
    rmSync(join(env.claudeHome, "commands", "beta.md"));
    writeFileSync(join(env.claudeHome, "commands", "beta.md"), "copy not symlink");
    const r = symlinksCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("not a symlink");
  });

  test("fails when symlink target is wrong path", () => {
    symlinkSync(join(fakeRepo, ".claude-plugin", "commands", "alpha.md"), join(env.claudeHome, "commands", "alpha.md"));
    const wrongTarget = join(env.tmp, "decoy");
    writeFileSync(wrongTarget, "x");
    symlinkSync(wrongTarget, join(env.claudeHome, "commands", "beta.md"));
    symlinkSync(join(fakeRepo, ".claude-plugin", "commands", "gamma.md"), join(env.claudeHome, "commands", "gamma.md"));
    const r = symlinksCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("points to");
  });
});

// ── check 7: config.json valid ─────────────────────────────────────────────

describe("doctor — check 7: config.json valid", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c7-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function configCheck(): CheckResult {
    return runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome })[6]!;
  }

  test("passes with valid config.json", () => {
    writeFileSync(join(env.siltpokeHome, "config.json"), JSON.stringify({ name: "Mochi", species: "cat", language: "en" }));
    expect(configCheck().pass).toBe(true);
  });

  test("fails when config.json is missing", () => {
    const r = configCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("does not exist");
  });

  test("fails when required field is missing", () => {
    writeFileSync(join(env.siltpokeHome, "config.json"), JSON.stringify({ name: "Mochi", language: "en" }));
    const r = configCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("species");
  });

  test("fails when required field is empty string", () => {
    writeFileSync(join(env.siltpokeHome, "config.json"), JSON.stringify({ name: "", species: "cat", language: "en" }));
    const r = configCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("name");
  });
});
