import { test, expect } from "bun:test";
import {
  resolveClaudeHome,
  siltpokeRoot,
  settingsJsonPath,
  commandsDirPath,
  PathError,
} from "../../src/installer/paths";

test("CLAUDE_HOME env wins over HOME", () => {
  const got = resolveClaudeHome({
    HOME: "/home/u",
    CLAUDE_HOME: "/custom/claude",
  } as NodeJS.ProcessEnv);
  expect(got).toBe("/custom/claude");
});

test("falls back to $HOME/.claude when CLAUDE_HOME unset", () => {
  const got = resolveClaudeHome({ HOME: "/home/u" } as NodeJS.ProcessEnv);
  expect(got).toBe("/home/u/.claude");
});

test("empty CLAUDE_HOME falls back to default", () => {
  const got = resolveClaudeHome({
    HOME: "/home/u",
    CLAUDE_HOME: "",
  } as NodeJS.ProcessEnv);
  expect(got).toBe("/home/u/.claude");
});

test("missing HOME throws PathError", () => {
  expect(() => resolveClaudeHome({} as NodeJS.ProcessEnv)).toThrow(PathError);
});

test("siltpokeRoot uses SILTPOKE_HOME when set", () => {
  expect(
    siltpokeRoot({
      HOME: "/home/u",
      SILTPOKE_HOME: "/custom/siltpoke",
    } as NodeJS.ProcessEnv),
  ).toBe("/custom/siltpoke");
});

test("siltpokeRoot falls back to $HOME/.siltpoke", () => {
  expect(
    siltpokeRoot({ HOME: "/home/u" } as NodeJS.ProcessEnv),
  ).toBe("/home/u/.siltpoke");
});

test("settingsJsonPath composes from claude home", () => {
  expect(
    settingsJsonPath({ HOME: "/home/u" } as NodeJS.ProcessEnv),
  ).toBe("/home/u/.claude/settings.json");
});

test("commandsDirPath composes from claude home", () => {
  expect(
    commandsDirPath({ HOME: "/home/u" } as NodeJS.ProcessEnv),
  ).toBe("/home/u/.claude/commands");
});
