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
      "yes",       // swap statusLine
      "Mochi",     // name
      "cat",       // species
      "zh-CN",     // language
      // no memory files seeded, so no consent prompt
    ]),
  });
  expect(r.status).toBe("installed");
  expect(r.inner_command).toBe("old-statusline-cmd");
  const next = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  expect(next.statusLine.command).toContain("face/wrapper.ts");
  // Stop hook pair: http entry + command entry on the same matcher.
  const stopHooks = next.hooks.Stop[0].hooks;
  const httpEntry = stopHooks.find((h: { type: string }) => h.type === "http");
  const cmdEntry = stopHooks.find((h: { type: string }) => h.type === "command");
  expect(httpEntry.url).toBe("http://127.0.0.1:9876/hooks/stop");
  expect(httpEntry.timeout).toBe(5);
  expect(typeof httpEntry.headers["X-Siltpoke-Secret"]).toBe("string");
  expect(httpEntry.headers["X-Siltpoke-Secret"].length).toBeGreaterThan(0);
  expect(cmdEntry.command).toContain("hooks/on-stop.ts");
  // Secret file materialised under ~/.siltpoke/secret.
  expect(existsSync(join(tmp, ".siltpoke", "secret"))).toBe(true);
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

test("install: user declines swap → user_aborted, no mutations", async () => {
  writeSettings({ statusLine: { command: "old" } });
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
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
    io: fakeIO(["yes", "Mochi", "cat", "en"]),
  });
  const settings1 = readFileSync(join(claudeHome, "settings.json"), "utf8");
  // Second pass — already installed
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO([]),
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

// --- runInstall calls migrateAll(home) ---

const v1MemorySample = {
  schemaVersion: 1,
  long_term_summary: "user prefers terse",
  learned_rules: [],
  personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
  last_consolidated_at: "2026-05-14T00:00:00Z",
  consolidation_due_at: "2026-05-21T00:00:00Z",
};

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
