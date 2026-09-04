// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Menu-bar-pet T5 — guarded, bounded side effects on a fired Stop-hook
 * review: (1) tell SwiftBar to re-render instantly, (2) pop a gated desktop
 * notification. Both are macOS-only and must never crash or stall the
 * caller — the injected `exec` seam below is exactly what keeps these tests
 * from actually shelling out to `open`/`osascript` on the dev machine.
 */
import { expect, test } from "bun:test";
import { notifyReview, refreshMenubar } from "../../src/hooks/menubar-refresh";

test("refresh is a no-op off darwin", () => {
  const calls: string[] = [];
  refreshMenubar({ platform: "linux", exec: (c) => calls.push(c) });
  expect(calls.length).toBe(0);
});

test("refresh execs open on darwin", () => {
  const calls: Array<[string, string[]]> = [];
  refreshMenubar({ platform: "darwin", exec: (c, a) => calls.push([c, a]) });
  expect(calls[0]![0]).toBe("open");
  expect(calls[0]![1].join(" ")).toContain(
    "swiftbar://refreshplugin?name=siltpoke",
  );
});

test("refresh opens in background (-g) so it never steals keyboard focus", () => {
  const calls: Array<[string, string[]]> = [];
  refreshMenubar({ platform: "darwin", exec: (c, a) => calls.push([c, a]) });
  // Without -g, `open` activates SwiftBar and pulls focus off the user's
  // window on every Stop hook. -g must precede the URL.
  expect(calls[0]![1]).toContain("-g");
  expect(calls[0]![1].indexOf("-g")).toBeLessThan(
    calls[0]![1].indexOf("swiftbar://refreshplugin?name=siltpoke"),
  );
});

test("notify suppressed when muted", () => {
  const calls: string[] = [];
  notifyReview("hi", true, {
    platform: "darwin",
    exec: (c) => calls.push(c),
    shimExists: () => true,
  });
  expect(calls.length).toBe(0);
});

test("notify is a no-op off darwin even when not muted", () => {
  const calls: string[] = [];
  notifyReview("hi", false, {
    platform: "linux",
    exec: (c) => calls.push(c),
  });
  expect(calls.length).toBe(0);
});

test("notify fires osascript when not muted", () => {
  const calls: Array<[string, string[]]> = [];
  notifyReview("watch out", false, {
    platform: "darwin",
    exec: (c, a) => calls.push([c, a]),
    shimExists: () => true,
  });
  expect(calls[0]![0]).toBe("osascript");
  expect(calls[0]![1].join(" ")).toContain("watch out");
});

test("notify sanitizes double-quotes and backslashes out of the comment", () => {
  const calls: Array<[string, string[]]> = [];
  notifyReview('say "hi" \\ there', false, {
    platform: "darwin",
    exec: (c, a) => calls.push([c, a]),
    shimExists: () => true,
  });
  const script = calls[0]![1].join(" ");
  expect(script).not.toContain('"hi"');
  expect(script).not.toContain("\\");
});

test("notify collapses newlines in the comment", () => {
  const calls: Array<[string, string[]]> = [];
  notifyReview("line one\nline two\r\nline three", false, {
    platform: "darwin",
    exec: (c, a) => calls.push([c, a]),
    shimExists: () => true,
  });
  const script = calls[0]![1].join(" ");
  expect(script).not.toContain("\n");
  expect(script).toContain("line one");
  expect(script).toContain("line two");
  expect(script).toContain("line three");
});

test("notify caps comment length to avoid an unbounded AppleScript string", () => {
  const calls: Array<[string, string[]]> = [];
  const longComment = "x".repeat(500);
  notifyReview(longComment, false, {
    platform: "darwin",
    exec: (c, a) => calls.push([c, a]),
    shimExists: () => true,
  });
  const script = calls[0]![1].join(" ");
  // 120-char cap on the sanitized comment plus the surrounding AppleScript
  // boilerplate — well under the full 500 chars.
  expect(script.length).toBeLessThan(300);
});

test("refresh with no injected exec on non-darwin never touches the real default exec", () => {
  // Deliberately omit `exec` to exercise the "falls through to defaultExec"
  // branch — gated safely by platform !== "darwin" so this never shells out
  // for real on the dev machine (would pop a real `open` invocation there).
  expect(() => refreshMenubar({ platform: "linux" })).not.toThrow();
});

test("notify with no injected exec on non-darwin never touches the real default exec", () => {
  expect(() =>
    notifyReview("hi", false, { platform: "linux" }),
  ).not.toThrow();
});

// FIX 3 (I3): notifications must be gated on the SwiftBar plugin shim
// actually being installed, so users who never opted into the menu-bar
// pet don't get surprise desktop notifications.
test("FIX3: notify no-ops when the SwiftBar plugin shim is absent, even on darwin + not muted", () => {
  const calls: string[] = [];
  notifyReview("hi", false, {
    platform: "darwin",
    exec: (c) => calls.push(c),
    shimExists: () => false,
  });
  expect(calls.length).toBe(0);
});

test("FIX3: notify fires when the SwiftBar plugin shim is present + darwin + not muted", () => {
  const calls: Array<[string, string[]]> = [];
  notifyReview("hi", false, {
    platform: "darwin",
    exec: (c, a) => calls.push([c, a]),
    shimExists: () => true,
  });
  expect(calls.length).toBe(1);
  expect(calls[0]![0]).toBe("osascript");
});
