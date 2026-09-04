// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import {
  askMultiSelectTTY,
  initMultiSelectState,
  type MultiSelectState,
  reduceMultiSelect,
} from "../../src/installer/multiselect-tty";
import type { WizardIO } from "../../src/installer/wizard";

const asArray = (s: MultiSelectState) => [...s.checked].sort((a, b) => a - b);

describe("reduceMultiSelect", () => {
  test("init seeds checked from defaults, cursor 0", () => {
    const s = initMultiSelectState(5, [0, 1, 3]);
    expect(s.cursor).toBe(0);
    expect(asArray(s)).toEqual([0, 1, 3]);
    expect(s.count).toBe(5);
  });

  test("down moves cursor, wraps at end", () => {
    let s = initMultiSelectState(3, []);
    s = reduceMultiSelect(s, "down");
    expect(s.cursor).toBe(1);
    s = reduceMultiSelect(reduceMultiSelect(s, "down"), "down"); // 2 -> wrap 0
    expect(s.cursor).toBe(0);
  });

  test("up wraps to last from first", () => {
    const s = reduceMultiSelect(initMultiSelectState(3, []), "up");
    expect(s.cursor).toBe(2);
  });

  test("space toggles the cursor row only", () => {
    let s = initMultiSelectState(3, []);
    s = reduceMultiSelect(s, "space"); // check 0
    expect(asArray(s)).toEqual([0]);
    s = reduceMultiSelect(s, "space"); // uncheck 0
    expect(asArray(s)).toEqual([]);
  });

  test("all checks everything, again clears everything", () => {
    let s = initMultiSelectState(3, [1]);
    s = reduceMultiSelect(s, "all"); // not all checked -> check all
    expect(asArray(s)).toEqual([0, 1, 2]);
    s = reduceMultiSelect(s, "all"); // all checked -> clear
    expect(asArray(s)).toEqual([]);
  });

  test("reducer never mutates the input state", () => {
    const s0 = initMultiSelectState(3, [0]);
    const before = asArray(s0);
    reduceMultiSelect(s0, "space");
    expect(asArray(s0)).toEqual(before);
    expect(s0.cursor).toBe(0);
  });
});

function captureIO(lines: string[] = []): { io: WizardIO; out: string[] } {
  const out: string[] = [];
  let i = 0;
  return {
    out,
    io: { write: (s) => out.push(s), readLine: async () => lines[i++] ?? "" },
  };
}

const CHOICES = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "antigravity", label: "Antigravity" },
] as const;

describe("askMultiSelectTTY", () => {
  test("non-TTY delegates to askLabeledMultiChoice (blank Enter = defaults)", async () => {
    const { io } = captureIO([""]); // blank line = accept defaults in readline path
    const picked = await askMultiSelectTTY(
      io,
      "pick",
      CHOICES,
      ["claude-code", "codex"],
      { isTTY: false },
    );
    expect(picked.sort()).toEqual(["claude-code", "codex"]);
  });

  test("TTY path: injected keys — space-toggle then enter", async () => {
    const { io } = captureIO();
    const keys = ["down", "space", "enter"] as const; // move to idx1 (codex), toggle, confirm
    let k = 0;
    const picked = await askMultiSelectTTY(io, "pick", CHOICES, [], {
      isTTY: true,
      readKey: async () => keys[k++]!,
    });
    expect(picked).toEqual(["codex"]);
  });

  test("TTY path: cancel returns empty", async () => {
    const { io } = captureIO();
    const picked = await askMultiSelectTTY(io, "pick", CHOICES, ["claude-code"], {
      isTTY: true,
      readKey: async () => "cancel",
    });
    expect(picked).toEqual([]);
  });

  test("Fix 2 (final-branch review): raw-mode entry throwing falls back to askLabeledMultiChoice instead of rejecting", async () => {
    const { io } = captureIO([""]); // blank line = accept defaults in the readline fallback
    const picked = await askMultiSelectTTY(
      io,
      "pick",
      CHOICES,
      ["claude-code", "codex"],
      {
        isTTY: true,
        // Simulates setRawMode throwing (ENOTTY/EIO on some PTYs) instead of
        // just being undefined — optional chaining alone can't catch this.
        makeRawKeyReader: () => {
          throw new Error("ENOTTY: raw mode not supported on this stream");
        },
      },
    );
    expect(picked.sort()).toEqual(["claude-code", "codex"]);
  });

  test("Fix 3 (final-branch review): second render moves cursor up + clears instead of stacking a new block", async () => {
    const { io, out } = captureIO();
    const keys = ["down", "up", "enter"] as const;
    let k = 0;
    await askMultiSelectTTY(io, "pick", CHOICES, [], {
      isTTY: true,
      readKey: async () => {
        const key = keys[k] ?? "cancel";
        k += 1;
        return key;
      },
    });
    // 3 renders total (initial + after "down" + after "up"). The first must
    // NOT carry a cursor-reposition escape; every render after it must move
    // up by the previous block's line count (header: 2 lines + 3 choice
    // rows = 5) and clear to end of screen before repainting.
    const clearPrefix = "\x1b[5A\x1b[0J";
    expect(out.length).toBe(3);
    expect(out[0]?.startsWith(clearPrefix)).toBe(false);
    expect(out[1]?.startsWith(clearPrefix)).toBe(true);
    expect(out[2]?.startsWith(clearPrefix)).toBe(true);
  });
});
