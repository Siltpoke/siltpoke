import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPresence } from "../../src/installer/agent-detect";
import {
  agyHostAdapter,
  ccForkAdapters,
  codebuddyAdapter,
  codexHostAdapter,
  type HostWireContext,
  qoderAdapter,
  secondaryHostAdapters,
} from "../../src/installer/host-adapter";

const CTX: HostWireContext = { repoRoot: "/repo", secret: "s3cr3t" };

function presence(over: Partial<AgentPresence>): AgentPresence {
  return {
    claude: false, codex: false, codebuddy: false, qodercli: false,
    antigravity: false, antigravityApp: false, ...over,
  };
}

describe("ccForkAdapters metadata", () => {
  test("codebuddy + qoder instances are exported with correct ids/keys", () => {
    expect(ccForkAdapters.map((a) => a.id)).toEqual(["codebuddy", "qodercli"]);
    expect(codebuddyAdapter.presenceKey).toBe("codebuddy");
    expect(qoderAdapter.presenceKey).toBe("qodercli");
    expect(codebuddyAdapter.probeBin).toBe("codebuddy");
    expect(qoderAdapter.probeBin).toBe("qodercli");
  });

  test("detect reads the mapped presence field", () => {
    expect(codebuddyAdapter.detect(presence({ codebuddy: true }))).toBe(true);
    expect(codebuddyAdapter.detect(presence({ codebuddy: false }))).toBe(false);
    expect(qoderAdapter.detect(presence({ qodercli: true }))).toBe(true);
  });
});

describe("writeHooks", () => {
  test("writes Stop + SessionStart into the host's settings.json (empty start)", async () => {
    const home = mkdtempSync(join(tmpdir(), "cb-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const res = await codebuddyAdapter.writeHooks(env, CTX);
    expect(res.path).toBe(join(home, ".codebuddy", "settings.json"));

    const written = JSON.parse(readFileSync(res.path, "utf8"));
    // SessionStart command present, derived from ctx.repoRoot
    const ss = written.hooks.SessionStart.flatMap((m: { hooks: { command?: string }[] }) => m.hooks);
    expect(ss.some((h: { command?: string }) => (h.command ?? "").includes("/repo/src/hooks/handle-session-start.ts"))).toBe(true);
    // Stop pair: a curl fast-path + the on-stop command
    const stop = written.hooks.Stop.flatMap((m: { hooks: { command?: string }[] }) => m.hooks);
    expect(stop.some((h: { command?: string }) => (h.command ?? "").startsWith("curl ") && (h.command ?? "").includes("/hooks/stop"))).toBe(true);
    expect(stop.some((h: { command?: string }) => (h.command ?? "").includes("/repo/src/hooks/on-stop.ts"))).toBe(true);
    // curl carries the secret header
    expect(stop.some((h: { command?: string }) => (h.command ?? "").includes("s3cr3t"))).toBe(true);
  });

  test("preserves unrelated keys already in settings.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "q-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const path = join(home, ".qoder", "settings.json");
    // pre-seed settings.json with an unrelated key
    mkdirSync(join(home, ".qoder"), { recursive: true });
    writeFileSync(path, JSON.stringify({ model: { name: "performance" } }));

    await qoderAdapter.writeHooks(env, CTX);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.model).toEqual({ name: "performance" }); // untouched
    expect(written.hooks.Stop).toBeDefined();
  });
});

describe("secondaryHostAdapters", () => {
  test("contains codex + codebuddy + qoder + antigravity in order", () => {
    expect(secondaryHostAdapters.map((a) => a.id)).toEqual(["codex", "codebuddy", "qodercli", "antigravity"]);
  });
});

describe("ccForkHostAdapter stopScript", () => {
  test("default Stop command points at src/hooks/on-stop.ts", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "cb-"));
    const res = await codebuddyAdapter.writeHooks({ HOME: home } as NodeJS.ProcessEnv, { repoRoot: "/repo", secret: "x" });
    const written = JSON.parse(readFileSync(res.path, "utf8"));
    const stop = written.hooks.Stop.flatMap((m: { hooks: { command?: string }[] }) => m.hooks);
    expect(stop.some((h: { command?: string }) => (h.command ?? "").includes("/repo/src/hooks/on-stop.ts"))).toBe(true);
  });
});

describe("codexHostAdapter", () => {
  test("writeHooks writes ~/.codex/hooks.json with Stop(codex-stop) + SessionStart", async () => {
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "cx-"));
    const res = await codexHostAdapter.writeHooks({ HOME: home } as NodeJS.ProcessEnv, { repoRoot: process.cwd(), secret: "x" });
    expect(res.path).toBe(join(home, ".codex", "hooks.json"));
    expect(existsSync(res.path)).toBe(true);
    const written = JSON.parse(readFileSync(res.path, "utf8"));
    expect(written.hooks.Stop).toBeDefined();
    expect(written.hooks.SessionStart).toBeDefined();
    const stop = written.hooks.Stop.flatMap((m: { hooks: { command?: string }[] }) => m.hooks);
    expect(stop.some((h: { command?: string }) => (h.command ?? "").includes("codex-stop.ts"))).toBe(true);
  });
});

describe("agyHostAdapter", () => {
  test("writeHooks writes ~/.gemini/config/hooks.json with the siltpoke-review Stop handler (flat array, no matcher wrapper)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agy-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const res = await agyHostAdapter.writeHooks(env, { repoRoot: "/repo", secret: "x" });
    expect(res.path).toBe(join(home, ".gemini", "config", "hooks.json"));
    const written = JSON.parse(readFileSync(res.path, "utf8"));
    expect(written["siltpoke-review"].Stop).toEqual([
      { type: "command", command: "bun /repo/src/hooks/agy-stop.ts", timeout: 30 },
    ]);
  });

  test("preserves sibling named hooks already in hooks.json (read-modify-write, only touches siltpoke-review)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agy-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const hooksPath = join(home, ".gemini", "config", "hooks.json");
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({ "some-other-tool": { PreToolUse: [{ type: "command", command: "echo hi" }] } }),
    );
    await agyHostAdapter.writeHooks(env, { repoRoot: "/repo", secret: "x" });
    const written = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(written["some-other-tool"]).toEqual({ PreToolUse: [{ type: "command", command: "echo hi" }] });
    expect(written["siltpoke-review"].Stop).toBeDefined();
  });

  test("re-running writeHooks is idempotent (byte-identical output on a second call)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agy-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    await agyHostAdapter.writeHooks(env, { repoRoot: "/repo", secret: "x" });
    const first = readFileSync(join(home, ".gemini", "config", "hooks.json"), "utf8");
    await agyHostAdapter.writeHooks(env, { repoRoot: "/repo", secret: "x" });
    const second = readFileSync(join(home, ".gemini", "config", "hooks.json"), "utf8");
    expect(second).toBe(first);
  });

  test("cleans the orphaned Claude-shaped `hooks` key from antigravity-cli/settings.json while preserving other keys, and refreshes statusLine", async () => {
    const home = mkdtempSync(join(tmpdir(), "agy-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: { name: "performance" },
        hooks: { Stop: [{ type: "http", url: "http://127.0.0.1:9876/hooks/stop" }] },
        statusLine: { type: "command", command: "some-old-command" },
      }),
    );
    await agyHostAdapter.writeHooks(env, { repoRoot: "/repo", secret: "x" });
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.hooks).toBeUndefined();
    expect(written.model).toEqual({ name: "performance" });
    expect(written.statusLine).toEqual({
      type: "command",
      command: "bun /repo/src/face/wrapper.ts --agent antigravity",
    });
  });

  test("settings.json absent (fresh machine): writeHooks creates it with statusLine, no pre-existing hooks key to clean", async () => {
    const home = mkdtempSync(join(tmpdir(), "agy-"));
    const env = { HOME: home } as NodeJS.ProcessEnv;
    await agyHostAdapter.writeHooks(env, { repoRoot: "/repo", secret: "x" });
    const settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(written.statusLine.command).toBe("bun /repo/src/face/wrapper.ts --agent antigravity");
  });

  test("adapter metadata: id/label/probeBin/presenceKey/detect", () => {
    expect(agyHostAdapter.id).toBe("antigravity");
    expect(agyHostAdapter.label).toBe("Antigravity");
    expect(agyHostAdapter.probeBin).toBe("agy");
    expect(agyHostAdapter.presenceKey).toBe("antigravity");
    expect(agyHostAdapter.detect(presence({ antigravity: true }))).toBe(true);
    expect(agyHostAdapter.detect(presence({ antigravity: false }))).toBe(false);
  });
});
