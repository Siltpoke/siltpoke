// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { askLabeledMultiChoice, type LabeledChoice, type WizardIO } from "./wizard";

export type MultiSelectKey = "up" | "down" | "space" | "all";

export interface MultiSelectState {
  cursor: number;
  checked: ReadonlySet<number>;
  count: number;
}

export function initMultiSelectState(
  count: number,
  checkedIndices: readonly number[],
  cursor = 0,
): MultiSelectState {
  return { cursor, checked: new Set(checkedIndices), count };
}

export function reduceMultiSelect(
  state: MultiSelectState,
  key: MultiSelectKey,
): MultiSelectState {
  const { cursor, checked, count } = state;
  if (count === 0) return state;
  switch (key) {
    case "down":
      return { ...state, cursor: (cursor + 1) % count };
    case "up":
      return { ...state, cursor: (cursor - 1 + count) % count };
    case "space": {
      const next = new Set(checked);
      if (next.has(cursor)) next.delete(cursor);
      else next.add(cursor);
      return { ...state, checked: next };
    }
    case "all": {
      const allChecked = checked.size === count;
      const next = allChecked
        ? new Set<number>()
        : new Set<number>(Array.from({ length: count }, (_, i) => i));
      return { ...state, checked: next };
    }
  }
}

const ANSI = { cyan: "\x1b[36m", reset: "\x1b[0m", hideCursor: "\x1b[?25l", showCursor: "\x1b[?25h" };

export interface MultiSelectDeps {
  isTTY?: boolean;
  readKey?: () => Promise<MultiSelectKey | "enter" | "cancel">;
  /**
   * Injectable raw-key-reader factory (testing seam for Fix 2, final-branch
   * review). Defaults to the real `makeRawKeyReader`, which enables stdin raw
   * mode as a side effect of being called. If entering raw mode throws
   * (ENOTTY/EIO on some PTYs), `askMultiSelectTTY` catches it and falls back
   * to the readline-based `askLabeledMultiChoice` path instead of crashing.
   */
  makeRawKeyReader?: () => () => Promise<MultiSelectKey | "enter" | "cancel">;
}

interface RenderedMultiSelect {
  block: string;
  /** Terminal lines the block occupies — header (2) + one per choice row. */
  lines: number;
}

function renderMultiSelect<T extends string>(
  question: string,
  choices: readonly LabeledChoice<T>[],
  state: MultiSelectState,
): RenderedMultiSelect {
  const header = `${ANSI.cyan}? ${question}${ANSI.reset}\n  (↑/↓ move · space toggle · a=all · enter confirm)\n`;
  const rows = choices
    .map((c, i) => {
      const caret = i === state.cursor ? "❯" : " ";
      const box = state.checked.has(i) ? "x" : " ";
      return `${caret} [${box}] ${c.label}`;
    })
    .join("\n");
  return { block: `${header}${rows}\n`, lines: 2 + choices.length };
}

export async function askMultiSelectTTY<T extends string>(
  io: WizardIO,
  question: string,
  choices: readonly LabeledChoice<T>[],
  defaults: readonly T[],
  deps?: MultiSelectDeps,
): Promise<T[]> {
  const useTTY =
    deps?.isTTY ??
    (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!useTTY) return askLabeledMultiChoice(io, question, choices, defaults);

  const defaultIdx = choices
    .map((c, i) => (defaults.includes(c.value) ? i : -1))
    .filter((i) => i >= 0);
  let state = initMultiSelectState(choices.length, defaultIdx);

  // Fix 2 (final-branch review): entering raw mode can throw (ENOTTY/EIO on
  // some PTYs) rather than just returning undefined from an optional
  // setRawMode — optional chaining alone can't guard against that. Catch it
  // here and fall back to the readline path so the wizard degrades instead
  // of crashing.
  let readKey: () => Promise<MultiSelectKey | "enter" | "cancel">;
  try {
    readKey = deps?.readKey ?? (deps?.makeRawKeyReader ?? makeRawKeyReader)();
  } catch {
    return askLabeledMultiChoice(io, question, choices, defaults);
  }

  // Fix 3 (final-branch review): redraw in place instead of stacking a fresh
  // header+rows block on every keypress. Before every render after the
  // first, move the cursor up by the previous block's line count and clear
  // to end of screen, then repaint.
  let previousLines = 0;
  for (;;) {
    const rendered = renderMultiSelect(question, choices, state);
    const clear = previousLines > 0 ? `\x1b[${previousLines}A\x1b[0J` : "";
    io.write(`${clear}${rendered.block}`);
    previousLines = rendered.lines;
    const key = await readKey();
    if (key === "enter") {
      return choices.filter((_, i) => state.checked.has(i)).map((c) => c.value);
    }
    if (key === "cancel") return [];
    state = reduceMultiSelect(state, key);
  }
}

// Raw-mode stdin byte stream → key tokens. If entering raw mode throws
// (ENOTTY/EIO on some PTYs), the throw propagates to askMultiSelectTTY's
// try/catch above, which falls back to the readline path.
function makeRawKeyReader(): () => Promise<MultiSelectKey | "enter" | "cancel"> {
  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  process.stdout.write(ANSI.hideCursor);
  const cleanup = () => {
    stdin.setRawMode?.(false);
    stdin.pause();
    process.stdout.write(ANSI.showCursor);
  };
  return () =>
    new Promise((resolve) => {
      const onData = (buf: Buffer) => {
        const s = buf.toString("utf8");
        const done = (k: MultiSelectKey | "enter" | "cancel") => {
          stdin.off("data", onData);
          if (k === "enter" || k === "cancel") cleanup();
          resolve(k);
        };
        if (s === "\x1b[A" || s === "k") return done("up");
        if (s === "\x1b[B" || s === "j") return done("down");
        if (s === " ") return done("space");
        if (s === "a") return done("all");
        if (s === "\r" || s === "\n") return done("enter");
        if (s === "\x03" || s === "\x1b") return done("cancel"); // Ctrl-C / Esc
        // ignore other keys — wait for the next
      };
      stdin.on("data", onData);
    });
}
