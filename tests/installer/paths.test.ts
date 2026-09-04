import { describe, expect, test } from "bun:test";
import {
  commandsDirPath,
  hostCommandsDirPath,
  hostSettingsJsonPath,
  PathError,
  resolveAgyHooksJsonPath,
  resolveAntigravityHome,
  resolveClaudeHome,
  resolveCodebuddyHome,
  resolveQoderHome,
  settingsJsonPath,
  siltpokeRoot,
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

test("siltpokeRoot treats empty SILTPOKE_HOME as unset", () => {
  expect(
    siltpokeRoot({
      HOME: "/home/u",
      SILTPOKE_HOME: "",
    } as NodeJS.ProcessEnv),
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

describe("host path helpers", () => {
  test("resolveCodebuddyHome defaults to ~/.codebuddy, honors override", () => {
    expect(resolveCodebuddyHome({ HOME: "/home/x" } as NodeJS.ProcessEnv)).toBe(
      "/home/x/.codebuddy",
    );
    expect(
      resolveCodebuddyHome({
        HOME: "/home/x",
        CODEBUDDY_HOME: "/custom/cb",
      } as NodeJS.ProcessEnv),
    ).toBe("/custom/cb");
  });

  test("resolveQoderHome defaults to ~/.qoder, honors override", () => {
    expect(resolveQoderHome({ HOME: "/home/x" } as NodeJS.ProcessEnv)).toBe(
      "/home/x/.qoder",
    );
    expect(
      resolveQoderHome({
        HOME: "/home/x",
        QODER_HOME: "/custom/q",
      } as NodeJS.ProcessEnv),
    ).toBe("/custom/q");
  });

  test("hostSettingsJsonPath / hostCommandsDirPath join under the given home", () => {
    expect(hostSettingsJsonPath("/home/x/.codebuddy")).toBe(
      "/home/x/.codebuddy/settings.json",
    );
    expect(hostCommandsDirPath("/home/x/.qoder")).toBe("/home/x/.qoder/commands");
  });
});

describe("Antigravity (agy) path helpers", () => {
  test("resolveAntigravityHome defaults to ~/.gemini/antigravity-cli", () => {
    expect(resolveAntigravityHome({ HOME: "/home/x" } as NodeJS.ProcessEnv)).toBe(
      "/home/x/.gemini/antigravity-cli",
    );
  });

  test("resolveAntigravityHome honors ANTIGRAVITY_HOME override", () => {
    expect(
      resolveAntigravityHome({ HOME: "/home/x", ANTIGRAVITY_HOME: "/custom/agy" } as NodeJS.ProcessEnv),
    ).toBe("/custom/agy");
  });

  test("resolveAntigravityHome falls back to GEMINI_HOME when ANTIGRAVITY_HOME is unset", () => {
    expect(
      resolveAntigravityHome({ HOME: "/home/x", GEMINI_HOME: "/custom/gemini" } as NodeJS.ProcessEnv),
    ).toBe("/custom/gemini");
  });

  test("resolveAntigravityHome prefers ANTIGRAVITY_HOME over GEMINI_HOME when both are set", () => {
    expect(
      resolveAntigravityHome({
        HOME: "/home/x",
        ANTIGRAVITY_HOME: "/custom/agy",
        GEMINI_HOME: "/custom/gemini",
      } as NodeJS.ProcessEnv),
    ).toBe("/custom/agy");
  });

  test("resolveAgyHooksJsonPath defaults to ~/.gemini/config/hooks.json (NOT nested under antigravity-cli)", () => {
    expect(resolveAgyHooksJsonPath({ HOME: "/home/x" } as NodeJS.ProcessEnv)).toBe(
      "/home/x/.gemini/config/hooks.json",
    );
  });

  test("resolveAgyHooksJsonPath honors ANTIGRAVITY_HOOKS_HOME override", () => {
    expect(
      resolveAgyHooksJsonPath({
        HOME: "/home/x",
        ANTIGRAVITY_HOOKS_HOME: "/custom/gemini-config",
      } as NodeJS.ProcessEnv),
    ).toBe("/custom/gemini-config/hooks.json");
  });
});
