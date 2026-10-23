// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { holdsSiltpokeHooks, stripSiltpokeHooks } from "../../src/cli/uninstall-hooks";
import { agyHooksEntry, codexHooksEntry, settingsHooksEntry } from "../../src/installer/receipt-sites";
import { registerSessionStartHook } from "../../src/installer/register-session-start";
import { registerStopHookPair } from "../../src/installer/settings-mutator";

// `[61]` PR 2, plan P3.1 (spec §4, AC10): taking siltpoke's hooks out of a
// host's file removes siltpoke's entries and nothing else. The fixtures are
// built with the same functions the install uses, so the shape under test is
// the shape that is really written.

const ROOT = "/Users/u/siltpoke";
const BUN = "/Users/u/.bun/bin/bun";
const USER_HOOK = { type: "command", command: "/usr/local/bin/notify-me" };

/** What a source install writes into a settings.json-shaped file (Claude Code, codebuddy, qoder). */
function settingsWithOurs(base: Record<string, unknown>, stopScript = "on-stop.ts"): Record<string, unknown> {
  const withStop = registerStopHookPair(base, {
    httpUrl: "http://127.0.0.1:9876/hooks/stop",
    command: `${BUN} ${ROOT}/src/hooks/${stopScript}`,
    secret: "s3cret",
  });
  return registerSessionStartHook(withStop, `${BUN} ${ROOT}/src/hooks/handle-session-start.ts`);
}

/** What `installCodexIntegration` writes into ~/.codex/hooks.json. */
function codexWithOurs(base: { hooks?: Record<string, unknown[]> } & Record<string, unknown>) {
  const hooks = { ...(base.hooks ?? {}) };
  hooks.SessionStart = [
    ...(hooks.SessionStart ?? []),
    {
      matcher: "startup|resume",
      hooks: [{ type: "command", command: `${BUN} ${ROOT}/src/hooks/handle-session-start.ts`, timeout: 30, statusMessage: "Siltpoke captures the session baseline" }],
    },
  ];
  hooks.Stop = [
    ...(hooks.Stop ?? []),
    { hooks: [{ type: "command", command: `${BUN} ${ROOT}/src/hooks/codex-stop.ts`, timeout: 30, statusMessage: "Siltpoke reviews the completed Codex turn" }] },
  ];
  return { ...base, hooks };
}

const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const settingsUndo = settingsHooksEntry("codebuddy", "/h/.codebuddy/settings.json", ROOT).undo;
const codexUndo = codexHooksEntry("/h/.codex/hooks.json", ROOT).undo;
const agyUndo = agyHooksEntry("/h/.gemini/config/hooks.json", "siltpoke-review").undo;

function stripped(input: unknown, undo: Record<string, unknown> | null, id: string): unknown {
  const r = stripSiltpokeHooks(text(input), undo, id);
  if (r.outcome !== "removed") throw new Error(`expected removed, got ${r.outcome}`);
  return JSON.parse(r.next);
}

describe("stripSiltpokeHooks — settings.json-shaped hosts (Claude Code source install, codebuddy, qoder)", () => {
  const mine = {
    theme: "dark",
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      Stop: [{ matcher: "", hooks: [USER_HOOK] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
    },
  };

  for (const id of ["hook:claude-code", "hook:codebuddy", "hook:qodercli"]) {
    test(`${id}: siltpoke's entries go, every other key is equal`, () => {
      const installed = settingsWithOurs(mine);
      // The fixture is not vacuous: the install really added something.
      expect(JSON.stringify(installed)).toContain("X-Siltpoke-Secret");
      expect(JSON.stringify(installed)).toContain("handle-session-start.ts");
      expect(stripped(installed, settingsUndo, id)).toEqual(mine);
    });
  }

  test("a file that held only siltpoke's hooks loses the hooks key, and keeps the rest", () => {
    expect(stripped(settingsWithOurs({ theme: "dark" }), settingsUndo, "hook:codebuddy")).toEqual({ theme: "dark" });
  });

  test("siltpoke's entry inside the user's own matcher: the matcher and the user's hook stay", () => {
    const installed = {
      hooks: { Stop: [{ matcher: "", hooks: [USER_HOOK, { type: "command", command: `${BUN} ${ROOT}/src/hooks/on-stop.ts` }] }] },
    };
    expect(stripped(installed, settingsUndo, "hook:codebuddy")).toEqual({ hooks: { Stop: [{ matcher: "", hooks: [USER_HOOK] }] } });
  });

  test("the status line is not a hook: a wrapper command under the same root is left alone", () => {
    const wrapper = { type: "command", command: `bun ${ROOT}/src/face/wrapper.ts` };
    const out = stripped(settingsWithOurs({ statusLine: wrapper }), settingsUndo, "hook:claude-code");
    expect(out).toEqual({ statusLine: wrapper });
  });

  test("an event the receipt does not name is not touched, even when its command is under the root", () => {
    const other = { hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: `bun ${ROOT}/src/hooks/on-stop.ts` }] }] } };
    expect(stripSiltpokeHooks(text(other), settingsUndo, "hook:codebuddy").outcome).toBe("nothing");
  });

  test("a user's own hook on another server's /hooks/stop is not siltpoke's", () => {
    const other = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "curl -X POST https://example.com/hooks/stop" }] }] } };
    expect(stripSiltpokeHooks(text(other), settingsUndo, "hook:codebuddy").outcome).toBe("nothing");
  });
});

// Review round 1: three ways the first version took, or left, the wrong entry.
describe("stripSiltpokeHooks — whose hook is it (review round 1)", () => {
  const cmd = (command: string) => ({ type: "command", command });
  const stop = (...hooks: unknown[]) => ({ hooks: { Stop: [{ matcher: "", hooks }] } });
  const undoFor = (root: string) => settingsHooksEntry("codebuddy", "x", root).undo;

  test("a recorded root that is the start of another folder's name does not take that folder's hook", () => {
    const theirs = cmd("bun /work/siltpoke-other/src/hooks/on-stop.ts");
    const input = stop(theirs, cmd("bun /work/silt/src/hooks/on-stop.ts"));
    expect(stripped(input, undoFor("/work/silt"), "hook:codebuddy")).toEqual(stop(theirs));
  });

  test("the user's own script elsewhere under the recorded root is not a siltpoke hook", () => {
    const input = stop(cmd(`${ROOT}/scripts/my-notify.sh`));
    expect(stripSiltpokeHooks(text(input), undoFor(ROOT), "hook:codebuddy").outcome).toBe("nothing");
  });

  for (const root of ["/", "", "/Users/u"]) {
    test(`a recorded root of ${JSON.stringify(root)} takes nothing of the user's`, () => {
      const input = stop(USER_HOOK, cmd("bun /Users/u/tools/src/hooks/notify.ts"));
      expect(stripSiltpokeHooks(text(input), undoFor(root), "hook:codebuddy").outcome).toBe("nothing");
    });
  }

  test("a root recorded with a trailing slash still matches", () => {
    expect(stripped(stop(cmd(`bun ${ROOT}/src/hooks/on-stop.ts`)), undoFor(`${ROOT}/`), "hook:codebuddy")).toEqual({});
  });

  test("the hook an earlier checkout left behind goes too, and the file then holds nothing of siltpoke's", () => {
    // Setup from /b after setup from /a: the curl entry is replaced, /a's script entry is not.
    const installed = settingsWithOurs(stop(USER_HOOK, cmd("bun /a/siltpoke/src/hooks/on-stop.ts")));
    const r = stripSiltpokeHooks(text(installed), settingsUndo, "hook:codebuddy");
    expect(r.outcome === "removed" && JSON.parse(r.next)).toEqual(stop(USER_HOOK));
    expect(r.outcome === "removed" && holdsSiltpokeHooks(r.next, settingsUndo, "hook:codebuddy")).toBe(false);
  });

  test("a loopback /hooks/stop on another port is the user's own server", () => {
    const theirs = { type: "http", url: "http://localhost:3000/hooks/stop" };
    for (const undo of [settingsUndo, null]) {
      expect(stripSiltpokeHooks(text(stop(theirs)), undo, "hook:codebuddy").outcome).toBe("nothing");
      expect(holdsSiltpokeHooks(text(stop(theirs)), undo, "hook:codebuddy")).toBe(false);
    }
  });

  test("siltpoke's older http entry is recognised by its port, or by its secret header", () => {
    const byPort = { type: "http", url: "http://127.0.0.1:9876/hooks/stop" };
    const byHeader = { type: "http", url: "http://127.0.0.1:9999/hooks/stop", headers: { "X-Siltpoke-Secret": "s" } };
    expect(stripped(stop(USER_HOOK, byPort, byHeader), null, "hook:codebuddy")).toEqual(stop(USER_HOOK));
  });

  test("an undo type from a newer version is not reported as a broken file", () => {
    expect(stripSiltpokeHooks(text(stop(USER_HOOK)), { type: "from-a-newer-version" }, "hook:codebuddy")).toEqual({ outcome: "unknown-undo" });
    expect(stripSiltpokeHooks("{ broken", { type: "from-a-newer-version" }, "hook:codebuddy")).toEqual({ outcome: "unknown-undo" });
  });
});

describe("stripSiltpokeHooks — codex hooks.json", () => {
  test("siltpoke's two entries go, the user's hooks and other keys are equal", () => {
    const mine = { version: 1, hooks: { Stop: [{ hooks: [USER_HOOK] }], UserPromptSubmit: [{ hooks: [USER_HOOK] }] } };
    expect(stripped(codexWithOurs(mine), codexUndo, "hook:codex")).toEqual(mine);
  });
});

describe("stripSiltpokeHooks — Antigravity hooks.json (one top-level key)", () => {
  test("only the recorded key goes", () => {
    const mine = { "my-linter": { Stop: [{ type: "command", command: "lint" }] } };
    const installed = { ...mine, "siltpoke-review": { Stop: [{ type: "command", command: `${BUN} ${ROOT}/src/hooks/agy-stop.ts`, timeout: 30 }] } };
    expect(stripped(installed, agyUndo, "hook:antigravity")).toEqual(mine);
  });

  test("the key is already gone: nothing to do", () => {
    expect(stripSiltpokeHooks(text({ "my-linter": {} }), agyUndo, "hook:antigravity").outcome).toBe("nothing");
  });
});

describe("stripSiltpokeHooks — a file that cannot be parsed is not rewritten (contingency 2)", () => {
  for (const [name, bad] of [["broken JSON", '{ "hooks": '], ["an array", "[]"], ["a string", '"x"'], ["empty", ""]] as const) {
    test(name, () => {
      expect(stripSiltpokeHooks(bad, settingsUndo, "hook:codebuddy")).toEqual({ outcome: "unreadable" });
      expect(stripSiltpokeHooks(bad, agyUndo, "hook:antigravity")).toEqual({ outcome: "unreadable" });
    });
  }

  test("shapes siltpoke never wrote are kept as they are", () => {
    const odd = { hooks: { Stop: "not-an-array", SessionStart: [{ matcher: "x" }, 7, null] } };
    expect(stripSiltpokeHooks(text(odd), settingsUndo, "hook:codebuddy").outcome).toBe("nothing");
  });
});

describe("no receipt (spec §8 D-A): only what the file itself says is siltpoke's", () => {
  test("settings.json: the curl entry names siltpoke, so the hook scripts beside it go too", () => {
    const mine = { hooks: { Stop: [{ matcher: "", hooks: [USER_HOOK] }] } };
    expect(stripped(settingsWithOurs(mine), null, "hook:codebuddy")).toEqual(mine);
  });

  test("codex: the status message names siltpoke", () => {
    const mine = { hooks: { Stop: [{ hooks: [USER_HOOK] }] } };
    expect(stripped(codexWithOurs(mine), null, "hook:codex")).toEqual(mine);
  });

  test("Antigravity: the key name is siltpoke's", () => {
    expect(stripped({ a: 1, "siltpoke-review": {} }, null, "hook:antigravity")).toEqual({ a: 1 });
  });

  test("a script path of siltpoke's shape with nothing naming siltpoke is NOT taken", () => {
    const lookalike = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "bun /work/other-tool/src/hooks/on-stop.ts" }] }] } };
    expect(stripSiltpokeHooks(text(lookalike), null, "hook:codebuddy").outcome).toBe("nothing");
    expect(holdsSiltpokeHooks(text(lookalike), null, "hook:codebuddy")).toBe(false);
  });
});

describe("holdsSiltpokeHooks — is there anything of siltpoke's in the hook events?", () => {
  test("true after an install, false once stripped", () => {
    const installed = text(settingsWithOurs({ theme: "dark" }));
    expect(holdsSiltpokeHooks(installed, settingsUndo, "hook:claude-code")).toBe(true);
    const r = stripSiltpokeHooks(installed, settingsUndo, "hook:claude-code");
    expect(r.outcome === "removed" && holdsSiltpokeHooks(r.next, settingsUndo, "hook:claude-code")).toBe(false);
  });

  // P2's presence check searched the whole file for the install root, so a
  // source install's hooks read as "still there" for as long as the status
  // line (same root, not a hook) was.
  test("the install root in the status line alone is not a hook", () => {
    const onlyStatusLine = text({ statusLine: { type: "command", command: `bun ${ROOT}/src/face/wrapper.ts` } });
    expect(holdsSiltpokeHooks(onlyStatusLine, settingsUndo, "hook:claude-code")).toBe(false);
  });

  test("a Windows root is matched as written in the command", () => {
    const winRoot = "C:\\Users\\u\\siltpoke";
    const undo = settingsHooksEntry("claude-code", "x", winRoot).undo;
    const file = text({ hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: `bun ${winRoot}\\src\\hooks\\handle-session-start.ts` }] }] } });
    expect(holdsSiltpokeHooks(file, undo, "hook:claude-code")).toBe(true);
    expect(stripped(JSON.parse(file), undo, "hook:claude-code")).toEqual({});
  });

  test("unparseable: no answer (the caller decides)", () => {
    expect(holdsSiltpokeHooks("{", settingsUndo, "hook:claude-code")).toBeNull();
  });
});
