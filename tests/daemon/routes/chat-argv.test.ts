import { describe, expect, test } from "bun:test";
import { buildChatArgv, CHAT_TOOLS } from "../../../src/daemon/routes/chat-argv";

// Dashboard chat hands `claude -p` the user's words. Before this, the CLI was
// offered every tool it has plus every MCP server the user installed, and a
// real run executed `uname -a ; whoami` through Bash on request.

describe("buildChatArgv — chat may only read", () => {
  const cases = [
    ["no system prompt", undefined, "darwin"],
    ["with a system prompt", "be brief", "darwin"],
    // win32 stages the prompt in a file; the limit must survive that path too.
    ["win32 with a system prompt", "be brief", "win32"],
  ] as const;
  for (const [label, prompt, platform] of cases) {
    test(`${label}: tools are limited to reading`, () => {
      const { args, cleanup } = buildChatArgv("m", prompt, platform);
      cleanup();
      const i = args.indexOf("--tools");
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe(CHAT_TOOLS);
    });

    test(`${label}: MCP servers from the user's config are not loaded`, () => {
      const { args, cleanup } = buildChatArgv("m", prompt, platform);
      cleanup();
      expect(args).toContain("--strict-mcp-config");
      expect(args).not.toContain("--mcp-config");
    });

    // The turn runs in the project's folder. Without this, claude -p loaded
    // that project's CLAUDE.md and ran its .claude/settings.json hooks with no
    // trust prompt — measured 2026-10-18 (an internal design note).
    test(`${label}: only the user's own settings load, never the project's`, () => {
      const { args, cleanup } = buildChatArgv("m", prompt, platform);
      cleanup();
      const i = args.indexOf("--setting-sources");
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe("user");
      expect(args.filter((a) => a === "--setting-sources")).toHaveLength(1);
    });
  }

  test("the tool list has no tool that runs commands, writes or fetches", () => {
    expect(CHAT_TOOLS.split(",").sort()).toEqual(["Glob", "Grep", "Read"]);
  });
});
