import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../src/cli/install";
import type { WizardIO } from "../../src/installer/wizard";

let tmp: string;
let claudeHome: string;
let env: NodeJS.ProcessEnv;
let repoRoot: string;

function fakeIO(answers: string[]): WizardIO {
  let i = 0;
  return {
    async readLine(): Promise<string> {
      return answers[i++] ?? "";
    },
    write(_s: string) {
      // discard
    },
  };
}

// Safety stub for tests that don't care about autostart: the wizard's
// autostart question defaults to YES, so exhausted answer arrays would
// otherwise dispatch the REAL platform installer (launchctl!) on dev machines.
const noopAutostart = async () =>
  ({ status: "skipped", platform: "test" }) as const;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-install-"));
  claudeHome = join(tmp, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  env = {
    HOME: tmp,
    // Mirror the install escape hatch (install.ts: noOllama = env.CI === "true")
    // so tests never trigger a real 4.7GB `ollama pull` (P2 flake fix).
    CI: "true",
  } as NodeJS.ProcessEnv;

  // Fake plugin layout so symlinkCommands has something to walk.
  repoRoot = join(tmp, "repo");
  mkdirSync(join(repoRoot, ".claude-plugin", "commands"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".claude-plugin", "commands", "siltpoke-fake.md"),
    "---\ndescription: fake\n---\nbody",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSettings(content: unknown): void {
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify(content, null, 2),
  );
}

test("install: refuses when SILTPOKE_INTERNAL=1", async () => {
  const r = await runInstall({
    env: { ...env, SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv,
    repoRoot,
    io: fakeIO([]),
  });
  expect(r.status).toBe("internal_subprocess");
});

test("install: aborts when settings.json missing", async () => {
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO([]),
    // Registry-driven interactive menu probes real command presence via
    // `exec` (Task 4) — force "nothing installed" so this fresh-machine
    // assertion stays deterministic regardless of what host CLIs happen to
    // be on the machine running the test suite.
    exec: () => ({ status: 1, stdout: "" }),
  });
  expect(r.status).toBe("no_settings");
});

test("install: happy path swaps statusLine, registers hook, symlinks commands", async () => {
  writeSettings({ statusLine: { command: "old-statusline-cmd" } });
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO([
      "1",         // select Claude Code
      "yes",       // swap statusLine
      "Mochi",     // name
      "cat",       // species
      "zh-CN",     // language
      // no memory files seeded, so no consent prompt
    ]),
    installAutostartFn: noopAutostart,
  });
  expect(r.status).toBe("installed");
  expect(r.inner_command).toBe("old-statusline-cmd");
  const next = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  expect(next.statusLine.command).toContain("face/wrapper.ts");
  // Stop hook pair: silent curl fast-path + on-stop command on the same
  // matcher — NO type:"http" entry (AC6: nothing for Claude Code to print
  // red when the daemon is down).
  const stopHooks = next.hooks.Stop[0].hooks;
  expect(stopHooks.length).toBe(2);
  expect(stopHooks.some((h: { type: string }) => h.type === "http")).toBe(false);
  const curlEntry = stopHooks.find((h: { command?: string }) =>
    (h.command ?? "").includes("curl"),
  );
  const cmdEntry = stopHooks.find((h: { command?: string }) =>
    (h.command ?? "").includes("on-stop.ts"),
  );
  expect(curlEntry.type).toBe("command");
  expect(curlEntry.command).toContain("--silent");
  expect(curlEntry.command).toContain("--max-time 5");
  expect(curlEntry.command).toContain("--data-binary @-");
  expect(curlEntry.command).toContain("http://127.0.0.1:9876/hooks/stop");
  expect(curlEntry.command).toContain(">/dev/null 2>&1");
  expect(curlEntry.command.endsWith("|| true")).toBe(true);
  expect(cmdEntry.command).toContain("hooks/on-stop.ts");
  // Secret file materialised under ~/.siltpoke/secret AND inlined in the
  // curl entry's X-Siltpoke-Secret header (AC8: auth preserved).
  expect(existsSync(join(tmp, ".siltpoke", "secret"))).toBe(true);
  const secret = readFileSync(join(tmp, ".siltpoke", "secret"), "utf8").trim();
  expect(secret.length).toBeGreaterThan(0);
  expect(curlEntry.command).toContain(`X-Siltpoke-Secret: ${secret}`);
  // inner.txt persisted
  expect(readFileSync(join(tmp, ".siltpoke", "inner.txt"), "utf8")).toBe(
    "old-statusline-cmd",
  );
  // config.json reflects wizard answers
  const cfg = JSON.parse(readFileSync(join(tmp, ".siltpoke", "config.json"), "utf8"));
  expect(cfg.name).toBe("Mochi");
  expect(cfg.species).toBe("cat");
  expect(cfg.language).toBe("zh-CN");
  // slash symlink created
  expect(existsSync(join(claudeHome, "commands", "siltpoke-fake.md"))).toBe(true);
  // backup created + symlink updated
  expect(existsSync(join(claudeHome, "settings.json.pre-siltpoke"))).toBe(true);
});

test("install: migrates old type:http Stop entries to the curl fast-path — no http left, no duplicates (AC7)", async () => {
  // EXISTING install shape from before track #6: type:"http" fast-path
  // (plus a historical duplicate — contingency) registered in settings.json.
  writeSettings({
    statusLine: { command: "old-statusline-cmd" },
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "http",
              url: "http://127.0.0.1:9876/hooks/stop",
              headers: { "X-Siltpoke-Secret": "stale-secret" },
              timeout: 5,
            },
            {
              type: "http",
              url: "http://127.0.0.1:9876/hooks/stop",
              headers: { "X-Siltpoke-Secret": "even-staler-secret" },
              timeout: 5,
            },
          ],
        },
      ],
    },
  });
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["1", "yes", "Mochi", "cat", "zh-CN"]),
    installAutostartFn: noopAutostart,
  });
  expect(r.status).toBe("installed");
  const next = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  const allHooks = (next.hooks.Stop as { hooks: { type: string; command?: string }[] }[])
    .flatMap((m) => m.hooks ?? []);
  // Old http entries GONE (both), replaced by exactly one curl entry.
  expect(allHooks.some((h) => h.type === "http")).toBe(false);
  const curls = allHooks.filter((h) => (h.command ?? "").includes("curl"));
  expect(curls.length).toBe(1);
  const secret = readFileSync(join(tmp, ".siltpoke", "secret"), "utf8").trim();
  expect(curls[0].command).toContain(`X-Siltpoke-Secret: ${secret}`);
  // on-stop fallback still present exactly once.
  const onStops = allHooks.filter((h) => (h.command ?? "").includes("on-stop.ts"));
  expect(onStops.length).toBe(1);
});

test("install: user declines swap → user_aborted, no mutations", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["1", "n"]),
  });
  expect(r.status).toBe("user_aborted");
  // settings unchanged
  const after = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  expect(after.statusLine.command).toBe("old");
  // no inner.txt written
  expect(existsSync(join(tmp, ".siltpoke", "inner.txt"))).toBe(false);
});

test("install: double-install reports already_installed without mutation", async () => {
  writeSettings({ statusLine: { command: "old" } });
  await runInstall({
    env,
    repoRoot,
    io: fakeIO(["1", "yes", "Mochi", "cat", "en"]),
    installAutostartFn: noopAutostart,
  });
  const settings1 = readFileSync(join(claudeHome, "settings.json"), "utf8");
  // Second pass — already installed. The already-installed path still offers
  // autostart (T2), so the stub is REQUIRED here or the exhausted fakeIO
  // answers default to yes and install a real LaunchAgent on the test machine.
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["1"]),
    installAutostartFn: noopAutostart,
  });
  expect(r.status).toBe("already_installed");
  const settings2 = readFileSync(join(claudeHome, "settings.json"), "utf8");
  expect(settings2).toBe(settings1);
});

test("install: --noninteractive (no TTY) installs with defaults", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
  });
  expect(r.status).toBe("installed");
  const cfg = JSON.parse(readFileSync(join(tmp, ".siltpoke", "config.json"), "utf8"));
  expect(cfg.name).toBe("Siltpoke");
  expect(cfg.species).toBe("slime");
  expect(cfg.language).toBe("en");
});

test("install: --noninteractive preserves Claude-only default when Codex also exists", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const codexHome = join(tmp, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5\"\n");

  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
  });

  expect(r.status).toBe("installed");
  expect(existsSync(join(codexHome, "hooks.json"))).toBe(false);
  const cfg = JSON.parse(readFileSync(join(tmp, ".siltpoke", "config.json"), "utf8"));
  expect(cfg.agents).toEqual(["claude-code"]);
});

test("install: Codex-only setup works without Claude settings", async () => {
  rmSync(join(claudeHome, "settings.json"), { force: true });
  const codexHome = join(tmp, ".codex");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5\"\n");

  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["2", "yes", "Mochi", "cat", "en"]),
    installAutostartFn: noopAutostart,
  });

  expect(r.status).toBe("installed");
  const hooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
  expect(JSON.stringify(hooks)).toContain("hooks/codex-stop.ts");
  expect(JSON.stringify(hooks)).toContain("hooks/handle-session-start.ts");
  const cfg = JSON.parse(readFileSync(join(tmp, ".siltpoke", "config.json"), "utf8"));
  expect(cfg.agents).toEqual(["codex"]);
});

test("install: agy selected via presetAgents writes hooks.json but does NOT symlink slash-commands (mirrors codex exclusion)", async () => {
  writeSettings({ statusLine: { command: "old" } });

  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["claude-code", "antigravity"],
    io: fakeIO([]),
  });

  expect(r.status).toBe("installed");

  // agyHostAdapter.writeHooks registers ~/.gemini/config/hooks.json.
  const agyHooksPath = join(tmp, ".gemini", "config", "hooks.json");
  expect(existsSync(agyHooksPath)).toBe(true);
  const hooks = JSON.parse(readFileSync(agyHooksPath, "utf8"));
  expect(JSON.stringify(hooks)).toContain("agy-stop.ts");

  // agy is excluded from symlinkCommands the same way codex is
  // (wireSecondaryHosts, src/cli/install.ts): cleanAgyOrphanSettings writes
  // its own settings.json into antigravity-cli/, but the plugin's
  // slash-command .md files must NEVER be symlinked in there — agy has no
  // symlinked-commands surface.
  const antigravityHomeDir = join(tmp, ".gemini", "antigravity-cli");
  expect(existsSync(join(antigravityHomeDir, "settings.json"))).toBe(true);
  expect(existsSync(join(antigravityHomeDir, "siltpoke-fake.md"))).toBe(false);

  const cfg = JSON.parse(readFileSync(join(tmp, ".siltpoke", "config.json"), "utf8"));
  expect(cfg.agents).toEqual(["claude-code", "antigravity"]);
});

// --- runInstall calls migrateAll(home) ---

const v1MemorySample = {
  schemaVersion: 1,
  long_term_summary: "user prefers terse",
  learned_rules: [],
  personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
  last_consolidated_at: "2026-05-14T00:00:00Z",
  consolidation_due_at: "2026-05-21T00:00:00Z",
};

test("install: accepting the menu-bar question dispatches runMenubarSetupFn (darwin only, track #7 T7)", async () => {
  writeSettings({ statusLine: { command: "old-statusline-cmd" } });
  const calls: unknown[] = [];
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    platform: "darwin",
    io: fakeIO([
      "1",         // select Claude Code
      "yes",       // swap statusLine
      "Mochi",     // name
      "cat",       // species
      "en",        // language
      "1",         // personality method: use defaults
      "no",        // decline autostart
      "yes",       // accept menu-bar pet
    ]),
    installAutostartFn: noopAutostart,
    runMenubarSetupFn: async (deps) => {
      calls.push(deps);
      return { installed: true, wroteShim: true, reason: "ok" };
    },
  });
  expect(r.status).toBe("installed");
  expect(calls.length).toBe(1);
});

test("install: declining the menu-bar question never dispatches runMenubarSetupFn", async () => {
  writeSettings({ statusLine: { command: "old-statusline-cmd" } });
  const calls: unknown[] = [];
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    platform: "darwin",
    io: fakeIO(["1", "yes", "Mochi", "cat", "en", "1", "no", "no"]),
    installAutostartFn: noopAutostart,
    runMenubarSetupFn: async (deps) => {
      calls.push(deps);
      return { installed: true, wroteShim: true, reason: "ok" };
    },
  });
  expect(r.status).toBe("installed");
  expect(calls.length).toBe(0);
});

test("install: menu-bar question is skipped entirely on non-darwin platforms", async () => {
  writeSettings({ statusLine: { command: "old-statusline-cmd" } });
  const calls: unknown[] = [];
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    platform: "linux",
    // No "menu-bar" answer needed — an exhausted queue here would prove the
    // question wasn't asked (a real ask would default to "no" too, so the
    // stronger assertion is calls.length === 0 below).
    io: fakeIO(["1", "yes", "Mochi", "cat", "en", "no"]),
    installAutostartFn: noopAutostart,
    runMenubarSetupFn: async (deps) => {
      calls.push(deps);
      return { installed: true, wroteShim: true, reason: "ok" };
    },
  });
  expect(r.status).toBe("installed");
  expect(calls.length).toBe(0);
});

test("install: migrates pre-existing v1 memory.json to v2", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const home = join(tmp, ".siltpoke");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "memory.json"),
    JSON.stringify(v1MemorySample),
  );

  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
  });
  expect(r.status).toBe("installed");

  // v1→v2 migrateAll runs first, then auto-fire splits v2→v3. The
  // v1 backup must still exist (v1-backup contract); the v2 file is
  // renamed to memory.v2.legacy.json (v2-legacy contract); a v3 global.json
  // and a v2.* backup under backups/ are created.
  const v1Bak = readdirSync(home)
    .find((e: string) => /^memory\.json\.bak\.v1\.\d+$/.test(e));
  expect(v1Bak).toBeDefined();
  expect(existsSync(join(home, "memory.json"))).toBe(false);
  expect(existsSync(join(home, "memory.v2.legacy.json"))).toBe(true);
  expect(existsSync(join(home, "global.json"))).toBe(true);
  expect(existsSync(join(home, "backups"))).toBe(true);
});

test("install: pre-existing v2 memory.json splits to v3 layout (auto-fire)", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const home = join(tmp, ".siltpoke");
  mkdirSync(home, { recursive: true });
  // Write a fully-formed v2 file
  writeFileSync(
    join(home, "memory.json"),
    JSON.stringify({
      ...v1MemorySample,
      schemaVersion: 2,
      user_profile: {
        communication_style: "neutral",
        goals: [],
        constraints: [],
        prefs: {},
      },
      chat_sessions: [],
      facts: [],
    }),
  );

  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
  });
  expect(r.status).toBe("installed");

  // v1→v2 migrateAll was a no-op (already v2). The v2→v3 auto-split fires.
  const v1Baks = readdirSync(home)
    .filter((e: string) => /^memory\.json\.bak\.v1/.test(e));
  expect(v1Baks).toEqual([]);
  expect(existsSync(join(home, "memory.json"))).toBe(false);
  expect(existsSync(join(home, "memory.v2.legacy.json"))).toBe(true);
  expect(existsSync(join(home, "global.json"))).toBe(true);
});

test("install: fresh install with no memory.json runs without migration crash", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
  });
  expect(r.status).toBe("installed");
});

// --- A1 — pet identity idempotency (config.json merge-not-overwrite) ---

test("install: preserves existing pet identity (merge not overwrite)", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const home = join(tmp, ".siltpoke");
  mkdirSync(home, { recursive: true });
  // Seed an existing pet with non-default identity + progression.
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      name: "Bangbang",
      species: "cat",
      language: "zh",
      snark: 5,
      patience: 5,
      rigor: 5,
      // chattiness intentionally OMITTED → proves fresh fills a key prior lacked.
      curiosity: 9, // non-default dial
      level: 5,
      xp: 1200,
    }),
  );

  // Run install noninteractive → fresh defaults are Siltpoke/slime/en.
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
  });
  expect(r.status).toBe("installed");

  const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  // Existing identity + progression must be PRESERVED (prior wins on merge).
  expect(cfg.name).toBe("Bangbang");
  expect(cfg.species).toBe("cat");
  expect(cfg.language).toBe("zh");
  expect(cfg.curiosity).toBe(9);
  expect(cfg.level).toBe(5);
  expect(cfg.xp).toBe(1200);
  // ...AND the other half of the merge promise: a dial the prior config OMITTED
  // (`chattiness`) is filled from fresh defaults (undefined would fail here).
  expect(cfg.chattiness).toBe(5);

  // The prior config was backed up before the merge.
  expect(existsSync(join(home, "config.json.preinstall-bak"))).toBe(true);
});

// --- A2 — inner.txt self-reference guard (prevents statusline fork bomb) ---

test("install: does not write the wrapper into inner.txt on re-install (self-reference guard)", async () => {
  const home = join(tmp, ".siltpoke");
  mkdirSync(home, { recursive: true });
  // settings.json statusLine is ALREADY the siltpoke wrapper (re-install case).
  const wrapperCmd = `bun ${join(repoRoot, "src", "face", "wrapper.ts")}`;
  writeSettings({ statusLine: { command: wrapperCmd } });
  // A pre-existing GOOD inner.txt (the real inner statusline).
  writeFileSync(join(home, "inner.txt"), "claude-hud");

  // No secret / Stop hook on disk → NOT already_installed, so install proceeds
  // and exercises the inner.txt write path with currentStatusStr == wrapper.
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
  });
  expect(r.status).toBe("installed");

  const inner = readFileSync(join(home, "inner.txt"), "utf8");
  // Must NOT point at the wrapper (would cause the wrapper to spawn itself).
  expect(inner).not.toContain("wrapper.ts");
  // The prior good value is preserved untouched.
  expect(inner).toBe("claude-hud");
});

// --- track #6 T2 — wizard autostart step (AC1-5) ---

// Copy + default flipped 2026-07-18, when the daemon became opt-in: autostart
// only powers the opt-in web surfaces (dashboard/chat) — core review never
// needs it — so the prompt now defaults to "no".
const AUTOSTART_PROMPT =
  "开机自启 siltpoke daemon？(可选 — 只 dashboard/chat 等网页面需要它，核心 review 不需要)";
const MANUAL_AUTOSTART_CMD = "bun src/cli/daemon.ts install-autostart";

function recordingIO(answers: string[]): {
  io: WizardIO;
  transcript: () => string;
} {
  let i = 0;
  const chunks: string[] = [];
  return {
    io: {
      async readLine(): Promise<string> {
        return answers[i++] ?? "";
      },
      write(s: string) {
        chunks.push(s);
      },
    },
    transcript: () => chunks.join(""),
  };
}

function countingAutostartFn(): {
  fn: () => Promise<{ status: "installed"; platform: string }>;
  calls: () => number;
} {
  let n = 0;
  return {
    fn: async () => {
      n++;
      return { status: "installed" as const, platform: "darwin" };
    },
    calls: () => n,
  };
}

test("install: interactive autostart question defaults to no → Enter installs nothing (AC1, flipped 2026-07-18)", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const autostart = countingAutostartFn();
  const { io, transcript } = recordingIO([
    "1",     // select Claude Code
    "yes",   // proceed with install
    "Mochi", // name
    "cat",   // species
    "zh-CN", // language
    "1",     // personality method: defaults
    "",      // autostart question — Enter = accept default (now "no")
  ]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    installAutostartFn: autostart.fn,
  });
  expect(r.status).toBe("installed");
  expect(transcript()).toContain(AUTOSTART_PROMPT);
  expect(autostart.calls()).toBe(0);
});

test("install: declining the autostart question installs nothing autostart-related (AC3)", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const autostart = countingAutostartFn();
  const { io, transcript } = recordingIO([
    "1", "yes", "Mochi", "cat", "zh-CN", "1",
    "n", // autostart question — decline
  ]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    installAutostartFn: autostart.fn,
  });
  expect(r.status).toBe("installed");
  expect(transcript()).toContain(AUTOSTART_PROMPT);
  expect(autostart.calls()).toBe(0);
});

test("install: noninteractive neither prompts nor installs autostart (AC4)", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const autostart = countingAutostartFn();
  const { io, transcript } = recordingIO([]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io,
    installAutostartFn: autostart.fn,
  });
  expect(r.status).toBe("installed");
  expect(transcript()).not.toContain(AUTOSTART_PROMPT);
  expect(transcript()).not.toContain("开机自启");
  expect(autostart.calls()).toBe(0);
});

test("install: autostart installer failure → one warn line with manual command, setup still succeeds (contingency)", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const { io, transcript } = recordingIO([
    "1", "yes", "Mochi", "cat", "zh-CN", "1",
    "y", // autostart question — accept
  ]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    installAutostartFn: async () => {
      throw new Error("launchctl bootstrap failed");
    },
  });
  // Autostart failure never blocks install.
  expect(r.status).toBe("installed");
  const out = transcript();
  expect(out).toContain("launchctl bootstrap failed");
  expect(out).toContain(MANUAL_AUTOSTART_CMD);
  // Exactly ONE warn line about the autostart failure.
  const warnLines = out
    .split("\n")
    .filter((l) => l.includes(MANUAL_AUTOSTART_CMD));
  expect(warnLines.length).toBe(1);
  // The success summary still printed after the warning.
  expect(out).toContain("=== Installed ===");
});

test("install: already-installed interactive re-run STILL asks the autostart question (primary use case)", async () => {
  writeSettings({ statusLine: { command: "old" } });
  // First pass: real install (autostart declined).
  await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["1", "yes", "Mochi", "cat", "en", "1", "n"]),
    installAutostartFn: noopAutostart,
  });
  const settings1 = readFileSync(join(claudeHome, "settings.json"), "utf8");

  // Second pass: settings already carry the full pair → already_installed
  // early return. The autostart question must fire BEFORE that return.
  const autostart = countingAutostartFn();
  const { io, transcript } = recordingIO([
    "1", // agent multi-select: Claude Code
    "",  // autostart question — Enter = accept default (now "no")
  ]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    installAutostartFn: autostart.fn,
  });
  expect(r.status).toBe("already_installed");
  expect(transcript()).toContain(AUTOSTART_PROMPT);
  expect(autostart.calls()).toBe(0);
  // settings.json untouched by the re-run.
  const settings2 = readFileSync(join(claudeHome, "settings.json"), "utf8");
  expect(settings2).toBe(settings1);
});

test("install: already-installed NONinteractive re-run stays silent — no prompt, no dispatch (AC4)", async () => {
  writeSettings({ statusLine: { command: "old" } });
  await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
    installAutostartFn: noopAutostart,
  });
  const autostart = countingAutostartFn();
  const { io, transcript } = recordingIO([]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io,
    installAutostartFn: autostart.fn,
  });
  expect(r.status).toBe("already_installed");
  expect(transcript()).not.toContain("开机自启");
  expect(autostart.calls()).toBe(0);
});

test("install: corrupt memory.json gets quarantined during install", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const home = join(tmp, ".siltpoke");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "memory.json"), "{garbage");

  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: fakeIO([]),
  });
  expect(r.status).toBe("installed");
  const corrupt = readdirSync(home)
    .find((e: string) => /^memory\.json\.corrupt-\d+$/.test(e));
  expect(corrupt).toBeDefined();
});
