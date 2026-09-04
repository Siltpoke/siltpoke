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

describe("stop hook pair (curl fast-path + command fallback)", () => {
  const pair: StopHookPair = {
    httpUrl: "http://127.0.0.1:9876/hooks/stop",
    command: "bun /abs/path/to/on-stop.ts",
    secret: "secret-xyz",
  };

  // The retired pre-track-#6 fast-path shape (type:"http"). Kept here as the
  // migration fixture: registerStopHookPair must REMOVE these on sight (AC7).
  const oldHttpEntry = {
    type: "http",
    url: pair.httpUrl,
    headers: { "X-Siltpoke-Secret": pair.secret },
    timeout: 5,
  };

  type HookShape = { type: string; command?: string; url?: string };
  type StopShape = { Stop: { hooks: HookShape[] }[] };

  function allStopHooks(settings: Record<string, unknown>): HookShape[] {
    const stop = (settings.hooks as StopShape | undefined)?.Stop ?? [];
    return stop.flatMap((m) => m.hooks ?? []);
  }

  function curlEntries(settings: Record<string, unknown>): HookShape[] {
    return allStopHooks(settings).filter(
      (h) => h.type === "command" && (h.command ?? "").includes("curl"),
    );
  }

  test("registerStopHookPair on empty settings creates curl fast-path + command entries, NO http entry (AC6)", () => {
    const next = registerStopHookPair({}, pair);
    const matchers = (next.hooks as StopShape).Stop;
    expect(matchers.length).toBe(1);
    const hooks = matchers[0]?.hooks;
    expect(hooks.length).toBe(2);
    // No type:"http" entry at all — Claude Code's own red ECONNREFUSED comes
    // from http entries; the silent curl command replaces it.
    expect(hooks.some((h) => h.type === "http")).toBe(false);
    const curl = hooks[0];
    expect(curl.type).toBe("command");
    const cmd = curl.command ?? "";
    expect(cmd).toContain("curl");
    expect(cmd).toContain("--silent");
    expect(cmd).toContain("--max-time 5");
    expect(cmd).toContain("--data-binary @-");
    expect(cmd).toContain(`X-Siltpoke-Secret: ${pair.secret}`); // AC8
    expect(cmd).toContain(pair.httpUrl);
    expect(cmd).toContain(">/dev/null 2>&1");
    expect(cmd.endsWith("|| true")).toBe(true);
    expect(hooks[1]).toEqual({ type: "command", command: pair.command });
  });

  test("registerStopHookPair is idempotent on re-apply", () => {
    const once = registerStopHookPair({}, pair);
    const twice = registerStopHookPair(once, pair);
    const stop = (twice.hooks as StopShape).Stop;
    expect(stop.length).toBe(1);
    expect(stop[0]?.hooks.length).toBe(2);
    expect(twice).toEqual(once);
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
    const hooks = (after.hooks as StopShape).Stop[0]?.hooks;
    // After upgrade we expect curl + command, no duplicates, no http.
    expect(hooks.filter((h) => h.type === "http").length).toBe(0);
    expect(curlEntries(after).length).toBe(1);
    expect(
      hooks.filter((h) => h.type === "command" && h.command === pair.command)
        .length,
    ).toBe(1);
  });

  test("registerStopHookPair MIGRATES an old type:http entry: http gone, exactly one curl entry (AC7)", () => {
    const before = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [oldHttpEntry, { type: "command", command: pair.command }],
          },
        ],
      },
    };
    const after = registerStopHookPair(before, pair);
    expect(allStopHooks(after).some((h) => h.type === "http")).toBe(false);
    expect(curlEntries(after).length).toBe(1);
    expect(
      allStopHooks(after).filter(
        (h) => h.type === "command" && h.command === pair.command,
      ).length,
    ).toBe(1);
  });

  test("registerStopHookPair removes TWO stale http entries (historical duplicates) in one pass (AC7 contingency)", () => {
    const staleTwin = {
      ...oldHttpEntry,
      headers: { "X-Siltpoke-Secret": "some-older-secret" },
    };
    const before = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [oldHttpEntry, { type: "command", command: pair.command }],
          },
          { matcher: "", hooks: [staleTwin] },
        ],
      },
    };
    const after = registerStopHookPair(before, pair);
    expect(allStopHooks(after).some((h) => h.type === "http")).toBe(false);
    expect(curlEntries(after).length).toBe(1);
    // The matcher that held only the stale twin must not linger empty.
    const stop = (after.hooks as StopShape).Stop;
    for (const m of stop) expect((m.hooks ?? []).length).toBeGreaterThan(0);
  });

  test("registerStopHookPair updates secret if it changed", () => {
    const before = registerStopHookPair({}, pair);
    const next = registerStopHookPair(before, { ...pair, secret: "rotated" });
    const curls = curlEntries(next);
    expect(curls.length).toBe(1);
    expect(curls[0]?.command).toContain("X-Siltpoke-Secret: rotated");
    expect(curls[0]?.command).not.toContain(pair.secret);
  });

  test("hasStopHookPair returns true only when BOTH curl + command entries are present and match", () => {
    expect(hasStopHookPair({}, pair)).toBe(false);
    const registered = registerStopHookPair({}, pair);
    expect(hasStopHookPair(registered, pair)).toBe(true);
    // Only command, missing curl fast-path: should return false.
    const partial = {
      hooks: {
        Stop: [
          { matcher: "", hooks: [{ type: "command", command: pair.command }] },
        ],
      },
    };
    expect(hasStopHookPair(partial, pair)).toBe(false);
  });

  test("hasStopHookPair returns false on the OLD http shape so install.ts re-runs take the migration branch (AC7)", () => {
    const oldShape = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [oldHttpEntry, { type: "command", command: pair.command }],
          },
        ],
      },
    };
    expect(hasStopHookPair(oldShape, pair)).toBe(false);
  });

  test("unregisterStopHookPair removes both entries", () => {
    const registered = registerStopHookPair({}, pair);
    const after = unregisterStopHookPair(registered, pair);
    expect((after.hooks as { Stop?: unknown } | undefined)?.Stop).toBeUndefined();
  });

  test("unregisterStopHookPair preserves unrelated Stop entries (and sweeps a stale http entry)", () => {
    const before = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              oldHttpEntry,
              { type: "command", command: pair.command },
              { type: "command", command: "/some/other/hook" },
            ],
          },
        ],
      },
    };
    const after = unregisterStopHookPair(before, pair);
    const stop = (after.hooks as StopShape).Stop;
    expect(stop.length).toBe(1);
    const remaining = stop[0]?.hooks;
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toEqual({
      type: "command",
      command: "/some/other/hook",
    });
  });
});
