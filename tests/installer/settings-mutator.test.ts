import { test, expect, describe } from "bun:test";
import {
  swapStatusLine,
  restoreStatusLine,
  registerStopHook,
  unregisterStopHook,
  hasStopHook,
  registerStopHookPair,
  hasStopHookPair,
  unregisterStopHookPair,
  type StopHookPair,
} from "../../src/installer/settings-mutator";

const WRAPPER = "bun /path/to/wrapper.ts";
const HOOK = "bun /path/to/on-stop.ts";

test("swapStatusLine: returns old command + replaces", () => {
  const input = { statusLine: { type: "command", command: "old-cmd" } };
  const r = swapStatusLine(input, WRAPPER);
  expect(r.oldStatusLineCommand).toBe("old-cmd");
  expect((r.next as { statusLine: { command: string } }).statusLine.command).toBe(WRAPPER);
});

test("swapStatusLine: returns null old when statusLine missing", () => {
  const r = swapStatusLine({}, WRAPPER);
  expect(r.oldStatusLineCommand).toBeNull();
});

test("swapStatusLine: preserves unrelated keys", () => {
  const input = { permissions: { foo: 1 }, statusLine: { command: "x" } };
  const r = swapStatusLine(input, WRAPPER);
  expect((r.next as { permissions: { foo: number } }).permissions.foo).toBe(1);
});

test("restoreStatusLine: writes back old command", () => {
  const input = { statusLine: { command: WRAPPER } };
  const out = restoreStatusLine(input, "old-cmd");
  expect((out as { statusLine: { command: string } }).statusLine.command).toBe("old-cmd");
});

test("restoreStatusLine: deletes statusLine when oldCommand is null", () => {
  const input = { statusLine: { command: WRAPPER } };
  const out = restoreStatusLine(input, null);
  expect((out as { statusLine?: unknown }).statusLine).toBeUndefined();
});

test("registerStopHook on empty settings: creates hooks.Stop", () => {
  const out = registerStopHook({}, HOOK);
  expect(hasStopHook(out, HOOK)).toBe(true);
});

test("registerStopHook preserves existing PreToolUse hook", () => {
  const input = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "my-tool hook" }],
        },
      ],
    },
  };
  const out = registerStopHook(input, HOOK);
  const hooks = (out as { hooks: { PreToolUse: unknown[]; Stop: unknown[] } })
    .hooks;
  expect(hooks.PreToolUse).toHaveLength(1);
  expect(hasStopHook(out, HOOK)).toBe(true);
});

test("registerStopHook is idempotent: double-register leaves one entry", () => {
  let out = registerStopHook({}, HOOK);
  out = registerStopHook(out, HOOK);
  const matchers = (out as { hooks: { Stop: { hooks: unknown[] }[] } }).hooks.Stop;
  const totalHooks = matchers.reduce(
    (n, m) => n + (m.hooks ?? []).length,
    0,
  );
  expect(totalHooks).toBe(1);
});

test("unregisterStopHook removes only our entry", () => {
  const input = {
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: HOOK },
            { type: "command", command: "some-other-cmd" },
          ],
        },
      ],
    },
  };
  const out = unregisterStopHook(input, HOOK);
  expect(hasStopHook(out, HOOK)).toBe(false);
  const remaining = (out as { hooks: { Stop: { hooks: unknown[] }[] } })
    .hooks.Stop[0]?.hooks!;
  expect(remaining).toHaveLength(1);
  expect((remaining[0] as { command: string }).command).toBe("some-other-cmd");
});

test("unregisterStopHook removes empty Stop array entirely", () => {
  const input = {
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: HOOK }] },
      ],
    },
  };
  const out = unregisterStopHook(input, HOOK) as {
    hooks?: { Stop?: unknown };
  };
  expect(out.hooks?.Stop).toBeUndefined();
});

test("unregisterStopHook on settings without hooks is no-op", () => {
  const out = unregisterStopHook({ permissions: { allow: [] } }, HOOK);
  expect((out as { permissions: { allow: unknown[] } }).permissions.allow).toEqual([]);
});

test("hasStopHook returns false for unrelated entries", () => {
  const input = {
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [{ type: "command", command: "other-hook" }],
        },
      ],
    },
  };
  expect(hasStopHook(input, HOOK)).toBe(false);
});

describe("stop hook pair (http + command)", () => {
  const pair: StopHookPair = {
    httpUrl: "http://127.0.0.1:9876/hooks/stop",
    command: "bun /abs/path/to/on-stop.ts",
    secret: "secret-xyz",
  };

  test("registerStopHookPair on empty settings creates both entries on the Stop matcher", () => {
    const next = registerStopHookPair({}, pair);
    const matchers = (next.hooks as { Stop: { hooks: unknown[] }[] }).Stop;
    expect(matchers.length).toBe(1);
    const hooks = matchers[0]?.hooks;
    expect(hooks.length).toBe(2);
    expect(hooks[0]).toEqual({
      type: "http",
      url: pair.httpUrl,
      headers: { "X-Siltpoke-Secret": pair.secret },
      timeout: 5,
    });
    expect(hooks[1]).toEqual({ type: "command", command: pair.command });
  });

  test("registerStopHookPair is idempotent on re-apply", () => {
    const once = registerStopHookPair({}, pair);
    const twice = registerStopHookPair(once, pair);
    const stop = (twice.hooks as { Stop: { hooks: unknown[] }[] }).Stop;
    expect(stop.length).toBe(1);
    expect(stop[0]?.hooks.length).toBe(2);
  });

  test("registerStopHookPair on settings with only the old command entry upgrades to the pair", () => {
    // Pre-existing: just the command entry (old install).
    const before = {
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: pair.command }] },
        ],
      },
    };
    const after = registerStopHookPair(before, pair);
    const hooks = (after.hooks as { Stop: { hooks: { type: string }[] }[] })
      .Stop[0]?.hooks;
    // After upgrade we expect both http + command, no duplicates.
    expect(hooks.filter((h) => h.type === "http").length).toBe(1);
    expect(hooks.filter((h) => h.type === "command").length).toBe(1);
  });

  test("registerStopHookPair updates secret if it changed", () => {
    const before = registerStopHookPair({}, pair);
    const next = registerStopHookPair(before, { ...pair, secret: "rotated" });
    const httpEntry = (
      next.hooks as {
        Stop: {
          hooks: {
            type: string;
            headers?: Record<string, string>;
          }[];
        }[];
      }
    ).Stop[0]?.hooks.find((h) => h.type === "http");
    expect(httpEntry?.headers?.["X-Siltpoke-Secret"]).toBe("rotated");
  });

  test("hasStopHookPair returns true only when BOTH entries are present and match", () => {
    expect(hasStopHookPair({}, pair)).toBe(false);
    const registered = registerStopHookPair({}, pair);
    expect(hasStopHookPair(registered, pair)).toBe(true);
    // Only command, missing http: should return false.
    const partial = {
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: pair.command }] },
        ],
      },
    };
    expect(hasStopHookPair(partial, pair)).toBe(false);
  });

  test("unregisterStopHookPair removes both entries", () => {
    const registered = registerStopHookPair({}, pair);
    const after = unregisterStopHookPair(registered, pair);
    expect((after.hooks as { Stop?: unknown } | undefined)?.Stop).toBeUndefined();
  });

  test("unregisterStopHookPair preserves unrelated Stop entries", () => {
    const before = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "http",
                url: pair.httpUrl,
                headers: { "X-Siltpoke-Secret": pair.secret },
                timeout: 5,
              },
              { type: "command", command: pair.command },
              { type: "command", command: "/some/other/hook" },
            ],
          },
        ],
      },
    };
    const after = unregisterStopHookPair(before, pair);
    const stop = (after.hooks as { Stop: { hooks: unknown[] }[] }).Stop;
    expect(stop.length).toBe(1);
    const remaining = stop[0]?.hooks;
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toEqual({
      type: "command",
      command: "/some/other/hook",
    });
  });
});
