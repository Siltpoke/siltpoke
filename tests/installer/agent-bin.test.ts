import { describe, expect, test } from "bun:test";
import { resolveAgentBinary } from "../../src/installer/agent-bin";

describe("resolveAgentBinary", () => {
  test("prefers an explicit which() hit", () => {
    const got = resolveAgentBinary("claude", { which: () => "/Users/x/.local/bin/claude" });
    expect(got).toBe("/Users/x/.local/bin/claude");
  });

  test("falls back to a known install dir when which() misses but the file exists", () => {
    const home = "/Users/x";
    const got = resolveAgentBinary("claude", {
      which: () => null,
      home,
      existsSync: (p) => p === "/Users/x/.local/bin/claude",
    });
    expect(got).toBe("/Users/x/.local/bin/claude");
  });

  test("returns the bare name when nothing resolves (degrade to PATH)", () => {
    const got = resolveAgentBinary("codex", { which: () => null, home: "/Users/x", existsSync: () => false });
    expect(got).toBe("codex");
  });
});
