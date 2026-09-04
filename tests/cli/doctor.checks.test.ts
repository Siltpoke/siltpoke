/**
 * Unit tests for doctor checks 1-7 in src/cli/doctor.ts (brain + autostart +
 * daemon rows are covered in doctor-daemon-check.test.ts / doctor.test.ts).
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
    // Plugin-era remediation — no `bun src/cli/install.ts` in a plugin cache.
    expect(r.detail).toContain("/siltpoke-setup");
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

  // Post-track-#6 canonical shape: curl fast path (type:"command") + on-stop
  // command — settings-mutator.ts registerStopHookPair no longer writes http.
  const CURL_FAST_PATH =
    'curl --silent --max-time 5 -X POST -H "X-Siltpoke-Secret: s3cret" -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:9876/hooks/stop >/dev/null 2>&1 || true';

  test("passes clean on the new shape (curl fast path + on-stop command)", () => {
    writeSettings({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [
            { type: "command", command: CURL_FAST_PATH },
            { type: "command", command: "bun /path/to/src/hooks/on-stop.ts" },
          ],
        }],
      },
    });
    const r = hookCheck();
    expect(r.pass).toBe(true);
    expect(r.status).not.toBe("info");
    expect(r.detail).toBeNull();
  });

  test("passes with migration note on the legacy shape (http + on-stop command)", () => {
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
    const r = hookCheck();
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe(
      "legacy http Stop hook shape detected — run `/siltpoke-setup` to migrate to the silent curl fast path",
    );
  });

  test("fails when hooks.Stop is missing", () => {
    writeSettings({});
    const r = hookCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("hooks.Stop");
  });

  test("fails when matcher has only the curl fast path (no on-stop fallback)", () => {
    writeSettings({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: CURL_FAST_PATH }] }] },
    });
    const r = hookCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("curl fast path");
  });

  test("fails when matcher has only http entry (no command fallback)", () => {
    writeSettings({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "http", url: "http://127.0.0.1:9876/hooks/stop" }] }] },
    });
    const r = hookCheck();
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("Run `/siltpoke-setup`");
  });

  test("fails when matcher has only on-stop command entry (no fast path)", () => {
    writeSettings({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "bun /path/on-stop.ts" }] }] },
    });
    expect(hookCheck().pass).toBe(false);
  });

  test("fails when neither curl command nor http url points at /hooks/stop", () => {
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

  // ── plugin-owned Stop hook (task 6c) ─────────────────────────────────────
  //
  // Plugin era: hooks/hooks.json (copied to
  // ${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json on install) owns the Stop hook,
  // not settings.json. A healthy plugin install has an EMPTY settings.json
  // hooks.Stop[] — that must PASS, not be treated as the false alarm it was
  // before this fix.

  function pluginHookCheck(pluginHooksJsonPath: string): CheckResult {
    return runAllChecks({
      claudeHome: env.claudeHome,
      siltpokeHome: env.siltpokeHome,
      pluginInstall: true,
      pluginHooksJsonPath,
    })[1]!;
  }

  test("plugin install + plugin hooks.json declares Stop + settings.json Stop empty → passes (false-alarm fix)", () => {
    writeSettings({ hooks: { Stop: [] } });
    const pluginHooksPath = join(env.tmp, "plugin-hooks.json");
    writeFileSync(
      pluginHooksPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh"' }] }],
        },
      }),
    );
    const r = pluginHookCheck(pluginHooksPath);
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toContain("plugin-owned");
  });

  test("plugin install + plugin hooks.json missing + settings.json also empty → fails (genuinely broken)", () => {
    writeSettings({ hooks: { Stop: [] } });
    const pluginHooksPath = join(env.tmp, "does-not-exist", "hooks.json");
    const r = pluginHookCheck(pluginHooksPath);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("hooks.Stop");
  });

  test("plugin install + plugin hooks.json has no Stop entry + settings.json also empty → fails", () => {
    writeSettings({ hooks: { Stop: [] } });
    const pluginHooksPath = join(env.tmp, "plugin-hooks-no-stop.json");
    writeFileSync(pluginHooksPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] } }));
    const r = pluginHookCheck(pluginHooksPath);
    expect(r.pass).toBe(false);
  });

  test("plugin install + plugin hooks.json declares Stop, even when settings.json is entirely empty object", () => {
    writeSettings({});
    const pluginHooksPath = join(env.tmp, "plugin-hooks-2.json");
    writeFileSync(
      pluginHooksPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "sh stop.sh" }] }] } }),
    );
    const r = pluginHookCheck(pluginHooksPath);
    expect(r.pass).toBe(true);
  });

  test("non-plugin install is unaffected by an (irrelevant) pluginHooksJsonPath override", () => {
    writeSettings({
      hooks: {
        Stop: [{
          matcher: "",
          hooks: [
            { type: "command", command: CURL_FAST_PATH },
            { type: "command", command: "bun /path/to/src/hooks/on-stop.ts" },
          ],
        }],
      },
    });
    const r = runAllChecks({
      claudeHome: env.claudeHome,
      siltpokeHome: env.siltpokeHome,
      pluginInstall: false,
      pluginHooksJsonPath: join(env.tmp, "does-not-exist", "hooks.json"),
    })[1]!;
    expect(r.pass).toBe(true);
    expect(r.status).not.toBe("info");
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
    // No `/siltpoke-setup` equivalent re-links command files — plugin reinstall does.
    expect(r.detail).toContain("Reinstall: /plugin install siltpoke");
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

  test("on win32: passes when files are copied (regular files, not symlinks)", () => {
    // Windows installs COPY command files (no symlink permission)
    for (const name of ["alpha.md", "beta.md", "gamma.md"]) {
      writeFileSync(join(env.claudeHome, "commands", name), "x");
    }
    const r = runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome, repoRoot: fakeRepo, platform: "win32" })[5]!;
    expect(r.pass).toBe(true);
    expect(r.name).toContain("3/3");
    expect(r.name).toContain("files");
  });

  test("on win32: fails when a command file is missing", () => {
    writeFileSync(join(env.claudeHome, "commands", "alpha.md"), "x");
    writeFileSync(join(env.claudeHome, "commands", "beta.md"), "x");
    // gamma.md is missing
    const r = runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome, repoRoot: fakeRepo, platform: "win32" })[5]!;
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("missing");
  });

  test("on win32: fails when an entry is not a regular file (e.g. directory)", () => {
    writeFileSync(join(env.claudeHome, "commands", "alpha.md"), "x");
    mkdirSync(join(env.claudeHome, "commands", "beta.md"));
    writeFileSync(join(env.claudeHome, "commands", "gamma.md"), "x");
    const r = runAllChecks({ claudeHome: env.claudeHome, siltpokeHome: env.siltpokeHome, repoRoot: fakeRepo, platform: "win32" })[5]!;
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("not a regular file");
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

// ── check 11: agy hooks.json siltpoke-review Stop registered ───────────────

describe("doctor — check 11: agy hooks.json siltpoke-review Stop registered", () => {
  let env: DoctorTmp;
  beforeEach(() => { env = setupDoctorTmp("c11-"); });
  afterEach(() => { teardownDoctorTmp(env); });

  function agyCheck(hooksPath: string): CheckResult {
    // Index bumped 10 → 12 on 2026-07-11 (single-brain #10 S1): the single
    // reviewer-provider row at index 9 was replaced by three per-role rows
    // (indices 9-11), shifting this trailing row from 10 to 12.
    return runAllChecks({
      claudeHome: env.claudeHome,
      siltpokeHome: env.siltpokeHome,
      agyHooksJsonPath: hooksPath,
    })[12]!;
  }

  test("absent hooks.json is healthy info (agy not wired) — not a failure", () => {
    const hooksPath = join(env.tmp, "does-not-exist", "hooks.json");
    const r = agyCheck(hooksPath);
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toContain("not wired");
    // Honest plugin-era wording — /siltpoke-setup does NOT wire agy hooks
    // (only the from-source installer does), so this must not claim it does.
    expect(r.detail).not.toContain("bun run setup");
    expect(r.detail).not.toContain("bun src/");
  });

  test("passes when siltpoke-review.Stop contains an agy-stop.ts command entry", () => {
    const hooksPath = join(env.tmp, "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({
        "siltpoke-review": {
          Stop: [{ type: "command", command: "bun /repo/src/hooks/agy-stop.ts", timeout: 30 }],
        },
      }),
    );
    const r = agyCheck(hooksPath);
    expect(r.pass).toBe(true);
    expect(r.detail).toBeNull();
  });

  test("fails when siltpoke-review key is missing", () => {
    const hooksPath = join(env.tmp, "hooks.json");
    writeFileSync(hooksPath, JSON.stringify({ "some-other-tool": { PreToolUse: [] } }));
    const r = agyCheck(hooksPath);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("siltpoke-review");
    // /siltpoke-setup does not wire agy hooks — must not claim it does.
    expect(r.detail).not.toContain("bun src/cli/install.ts");
  });

  test("fails when siltpoke-review.Stop has no agy-stop.ts command entry", () => {
    const hooksPath = join(env.tmp, "hooks.json");
    writeFileSync(hooksPath, JSON.stringify({ "siltpoke-review": { Stop: [{ type: "command", command: "echo hi" }] } }));
    const r = agyCheck(hooksPath);
    expect(r.pass).toBe(false);
    expect(r.detail).not.toContain("bun src/cli/install.ts");
  });

  test("fails when hooks.json is corrupt JSON", () => {
    const hooksPath = join(env.tmp, "hooks.json");
    writeFileSync(hooksPath, "{ not json");
    const r = agyCheck(hooksPath);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("not valid JSON");
  });
});
