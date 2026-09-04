import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync, existsSync as fsExists } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentFlag, runWrapper } from "../../src/face/wrapper.ts";
import { getSpecies } from "../../src/face/species.ts";

let tempBase: string;

beforeEach(() => {
  tempBase = mkdtempSync(join(tmpdir(), "siltpoke-test-"));
});

afterEach(() => {
  rmSync(tempBase, { recursive: true, force: true });
});

test("happy path: splices default species face beside inner stdout", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'hello from inner'");

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  // Inner content preserved
  expect(result).toContain("hello from inner");
  // Default species (slime) art spliced in
  const slimeArt = getSpecies(undefined).art.base;
  const firstSlimeLine = slimeArt.split("\n")[0]?.trim();
  expect(result).toContain(firstSlimeLine);
});

test("happy path: includes name row below face when config has name", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", name: "Bangbang" }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toContain("Bangbang");
  // Face is now 4 rows: 3 art + 1 name. Output has at least 4 lines.
  expect(result.split("\n").length).toBeGreaterThanOrEqual(4);
});

test("face block: includes L{level} {xp}/{target} progression line", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", name: "Bangbang" }),
  );
  writeFileSync(
    join(tempBase, "progression.json"),
    JSON.stringify({
      schemaVersion: 1,
      level: 3,
      xp: 47,
      xp_to_next_level: 300,
      unlocked_poses: ["base", "peek", "blink"],
      unlocked_titles: ["Hatchling", "Watcher"],
      pet_log: [],
    }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toContain("L3 47/300");
});

test("face block: default progression renders L1 0/100 when no file", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", name: "Bangbang" }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toContain("L1 0/100");
});

test("happy path: appends quoted bubble line with chosen color", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", bubble: "hello world", bubbleColor: "pink" }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toContain(`"hello world"`);
  // pink = 256-color code 213
  expect(result).toContain("\x1b[38;5;213m");
  expect(result).toContain("\x1b[0m");
});

test("happy path: unknown bubbleColor falls back to cyan", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", bubble: "hi", bubbleColor: "neon-glitter" }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toContain(`"hi"`);
  // default cyan = 36
  expect(result).toContain("\x1b[36m");
});

test("happy path: missing bubble omits bubble line entirely", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", name: "Bangbang" }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).not.toMatch(/"\s*"/);
  expect(result).not.toContain("\x1b[38;5;213m");
});

test("happy path: empty/missing name leaves face at 3 rows", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'a\nb'");
  writeFileSync(join(tempBase, "config.json"), JSON.stringify({ species: "cat" }));

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  // 3 face rows; inner echoes 2 lines + trailing newline → max(3, 3) = 3
  // No name row appended
  expect(result).not.toMatch(/name/i);
});

test("happy path: respects species from config.json", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(join(tempBase, "config.json"), JSON.stringify({ species: "cat" }));

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  const catArt = getSpecies("cat").art.base;
  const firstCatLine = catArt.split("\n")[0]?.trim();
  expect(result).toContain(firstCatLine);
});

test("happy path: unknown species in config falls back to default silently", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(join(tempBase, "config.json"), JSON.stringify({ species: "dragon" }));

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  const slimeArt = getSpecies(undefined).art.base;
  const firstSlimeLine = slimeArt.split("\n")[0]?.trim();
  expect(result).toContain(firstSlimeLine);
});

test("happy path: malformed config.json falls back to default silently", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(join(tempBase, "config.json"), "not valid json");

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  const slimeArt = getSpecies(undefined).art.base;
  const firstSlimeLine = slimeArt.split("\n")[0]?.trim();
  expect(result).toContain(firstSlimeLine);
});

test("happy path: narrow termWidth hides face, returns raw inner output", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'hello'");

  const result = await runWrapper({ basePath: tempBase, termWidth: 5 });

  expect(result).toBe("hello\n");
});

test("missing inner.txt: renders standalone face (fresh install, no inner statusline to chain)", async () => {
  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  // Fresh install with no prior statusLine is a supported path (install.ts:295).
  // Siltpoke must still render its own face — not a "not configured" cliff.
  const slimeArt = getSpecies(undefined).art.base;
  const firstSlimeLine = slimeArt.split("\n")[0]?.trim();
  expect(result).toContain(firstSlimeLine);
  expect(result).not.toContain("not configured");
});

test("inner command exits non-zero: returns empty and logs error", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "exit 1");

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toBe("");

  const logPath = join(tempBase, "logs", "errors.log");
  expect(fsExists(logPath)).toBe(true);
  const logContents = readFileSync(logPath, "utf8");
  expect(logContents).toContain("exited with code 1");
});

test("empty inner.txt: returns empty and logs error", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "   \n");

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toBe("");

  const logPath = join(tempBase, "logs", "errors.log");
  expect(fsExists(logPath)).toBe(true);
  const logContents = readFileSync(logPath, "utf8");
  expect(logContents).toContain("inner.txt is empty");
});

test("state.json fresh: bubble_short from state overrides config.bubble", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({
      species: "cat",
      bubble: "from config",
      bubbleColor: "pink",
    }),
  );
  writeFileSync(
    join(tempBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "happy",
      pose: "base",
      bubble_short: "from state",
      severity: "info",
      confidence: "high",
      last_updated_ms: Date.now(),
      last_session_id: "s1",
    }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toContain('"from state"');
  expect(result).not.toContain('"from config"');
});

test("state.json fresh + mood=annoyed: face renders concerned variant", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat" }),
  );
  writeFileSync(
    join(tempBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "annoyed",
      pose: "arms_crossed",
      bubble_short: "concerns",
      severity: "medium",
      confidence: "high",
      last_updated_ms: Date.now(),
      last_session_id: "s1",
    }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  // Cat concerned variant signature: (>.<)
  expect(result).toContain("(>.<)");
});

test("state.json stale: falls back to config bubble", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", bubble: "fallback bubble" }),
  );
  writeFileSync(
    join(tempBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "annoyed",
      pose: "arms_crossed",
      bubble_short: "stale bubble",
      severity: "high",
      confidence: "high",
      last_updated_ms: Date.now() - 60 * 60 * 1000,
      last_session_id: "s1",
    }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toContain('"fallback bubble"');
  expect(result).not.toContain('"stale bubble"');
});

test("state.json fresh + severity=high: bubble color shifts to red", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", bubbleColor: "cyan" }),
  );
  writeFileSync(
    join(tempBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "concerned",
      pose: "arms_crossed",
      bubble_short: "danger",
      severity: "high",
      confidence: "high",
      last_updated_ms: Date.now(),
      last_session_id: "s1",
    }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  // red ANSI = 31
  expect(result).toContain("\x1b[31m");
});

test("minimalMode: face block omitted, only inner stdout + bubble line", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'inner-line'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({
      species: "cat",
      name: "Mochi",
      bubble: "minimal bubble",
      minimalMode: true,
    }),
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });
  expect(result).toContain("inner-line");
  expect(result).toContain("minimal bubble");
  // cat face base line " /\\_/\\ " should NOT appear in minimal mode
  expect(result).not.toContain("/\\_/\\");
  expect(result).not.toContain("Mochi");
});

test("minimalMode + no bubble: returns inner stdout untouched", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'plain'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat", minimalMode: true }),
  );
  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });
  expect(result).toBe("plain\n");
});

test("minimalMode default false: face still rendered without the field", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ species: "cat" }),
  );
  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });
  expect(result).toContain("/\\_/\\");
});

test("projectBase state.json takes precedence over basePath state.json", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "happy",
      pose: "base",
      bubble_short: "global state",
      severity: "info",
      confidence: "high",
      last_updated_ms: Date.now(),
      last_session_id: "g1",
    }),
  );

  const projectBase = mkdtempSync(join(tmpdir(), "siltpoke-proj-"));
  try {
    writeFileSync(
      join(projectBase, "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        mood: "annoyed",
        pose: "arms_crossed",
        bubble_short: "project state",
        severity: "high",
        confidence: "high",
        last_updated_ms: Date.now(),
        last_session_id: "p1",
      }),
    );

    const result = await runWrapper({
      basePath: tempBase,
      projectBase,
      termWidth: 200,
    });
    expect(result).toContain('"project state"');
    expect(result).not.toContain('"global state"');
  } finally {
    rmSync(projectBase, { recursive: true, force: true });
  }
});

test("projectBase missing state falls back to basePath state", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(
    join(tempBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "happy",
      pose: "base",
      bubble_short: "global fallback",
      severity: "info",
      confidence: "high",
      last_updated_ms: Date.now(),
      last_session_id: "g1",
    }),
  );

  const projectBase = mkdtempSync(join(tmpdir(), "siltpoke-proj-"));
  try {
    const result = await runWrapper({
      basePath: tempBase,
      projectBase,
      termWidth: 200,
    });
    expect(result).toContain('"global fallback"');
  } finally {
    rmSync(projectBase, { recursive: true, force: true });
  }
});

test("inner command is a nonexistent program: returns empty and logs error", async () => {
  writeFileSync(
    join(tempBase, "inner.txt"),
    "/this/path/does/not/exist/binary --foo"
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });

  expect(result).toBe("");

  const logPath = join(tempBase, "logs", "errors.log");
  expect(fsExists(logPath)).toBe(true);
  const logContents = readFileSync(logPath, "utf8");
  expect(logContents).toContain("exited with code");
});

describe("runWrapper --agent option", () => {
  test("agent set + inner.txt present: inner-chaining is skipped entirely, face renders standalone", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "siltpoke-wrapper-agent-"));
    try {
      writeFileSync(join(tmp, "inner.txt"), "echo SHOULD-NOT-RUN-FOR-AGY");
      writeFileSync(join(tmp, "config.json"), JSON.stringify({ name: "Pip", species: "slime" }));
      const out = await runWrapper({ basePath: tmp, agent: "antigravity", termWidth: 80 });
      // Inner.txt must not leak into a non-Claude host render...
      expect(out).not.toContain("SHOULD-NOT-RUN-FOR-AGY");
      // ...AND the face must actually render standalone (name row from
      // config.json), not collapse to an empty string. Guards against a
      // future regression where the options.agent branch returns "".
      expect(out).toContain("Pip");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("agent unset + inner.txt present: inner command still runs (unchanged Claude-wrap behavior)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "siltpoke-wrapper-agent-"));
    try {
      writeFileSync(join(tmp, "inner.txt"), "echo INNER-RAN");
      writeFileSync(join(tmp, "config.json"), JSON.stringify({ name: "Pip", species: "slime" }));
      const out = await runWrapper({ basePath: tmp, termWidth: 80 });
      expect(out).toContain("INNER-RAN");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("tasklist: appends 📋 segment when cwd has .claude/tasklist.md", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  const cwd = mkdtempSync(join(tmpdir(), "siltpoke-cwd-"));
  try {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "tasklist.md"),
      "- [x] a\n- [x] b\n- [/] ship it",
    );
    const result = await runWrapper({ basePath: tempBase, cwd, termWidth: 200 });
    expect(result).toContain("📋 2/3 ▶ ship it");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("tasklist: no segment when the file is absent", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  const cwd = mkdtempSync(join(tmpdir(), "siltpoke-cwd-"));
  try {
    const result = await runWrapper({ basePath: tempBase, cwd, termWidth: 200 });
    expect(result).not.toContain("📋");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("tasklist: no cwd → no segment, no crash", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });
  expect(result).not.toContain("📋");
});

test("tasklist: shows in minimal mode with no bubble (past the early return)", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(join(tempBase, "config.json"), JSON.stringify({ minimalMode: true }));
  const cwd = mkdtempSync(join(tmpdir(), "siltpoke-cwd-"));
  try {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "tasklist.md"), "- [x] a\n- [/] go");
    const result = await runWrapper({ basePath: tempBase, cwd, termWidth: 200 });
    expect(result).toContain("📋 1/2 ▶ go");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

describe("parseAgentFlag (CLI entry helper)", () => {
  test("extracts the value following --agent", () => {
    expect(parseAgentFlag(["bun", "wrapper.ts", "--agent", "antigravity"])).toBe("antigravity");
  });

  test("returns undefined when --agent is absent", () => {
    expect(parseAgentFlag(["bun", "wrapper.ts"])).toBeUndefined();
  });

  test("returns undefined when --agent has no following value", () => {
    expect(parseAgentFlag(["bun", "wrapper.ts", "--agent"])).toBeUndefined();
  });
});
