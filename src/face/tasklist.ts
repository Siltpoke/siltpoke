// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { stripAnsi, truncateToVisualWidth, visualWidth } from "./width";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface TasklistProgress {
  done: number;
  total: number;
  currentStep?: string;
}

// Generic markdown checkbox leaf: -, *, or + marker, one+ spaces, single
// state char in brackets, optional description. Parse by STRUCTURE only.
const LEAF = /^\s*[-*+]\s+\[(.)\]\s*(.*)$/;
// A fenced code block opener/closer (``` or ~~~), possibly indented.
const FENCE = /^\s*(```|~~~)/;

/**
 * Parse a generic markdown-checkbox tasklist into progress counts.
 * Returns null when the text has no checkbox leaves (nothing to render).
 * Never throws.
 */
export function parseTasklist(md: string): TasklistProgress | null {
  let inFence = false;
  let done = 0;
  let total = 0;
  let currentStep: string | undefined;

  for (const line of md.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = LEAF.exec(line);
    if (!m) continue;

    total += 1;
    const state = m[1];
    if (state === "x" || state === "X") {
      done += 1;
    } else if (state === "/" && currentStep === undefined) {
      currentStep = (m[2] ?? "").trim();
    }
  }

  if (total === 0) return null;
  return currentStep === undefined ? { done, total } : { done, total, currentStep };
}

const DEFAULT_MAX_STEP_COLS = 40;
// C0 controls (incl. ESC 0x1B, BEL 0x07), DEL (0x7F), and C1 (0x80–0x9F).
// Stripped so a project-authored task name cannot inject escape sequences
// into the host statusline.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional strip
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Render a TasklistProgress into a compact one-line segment.
 * done===total → "📋 N/N ✓"; else with a step → "📋 d/t ▶ <step>";
 * else "📋 d/t". The step is control-char-stripped and hard-truncated to
 * maxStepCols visual columns (ellipsis appended when truncated).
 */
export function formatTasklistSegment(
  p: TasklistProgress,
  maxStepCols: number = DEFAULT_MAX_STEP_COLS,
): string {
  const base = `📋 ${p.done}/${p.total}`;
  if (p.done === p.total) return `${base} ✓`;

  // stripAnsi removes complete ESC-led sequences (e.g. \x1b[31m); the
  // CONTROL_CHARS pass then removes any stray control bytes (BEL, lone ESC).
  // Stripping only the ESC byte would leave the visible "[31m" literal.
  const step = stripAnsi(p.currentStep ?? "").replace(CONTROL_CHARS, "").trim();
  if (!step) return base;

  if (visualWidth(step) <= maxStepCols) return `${base} ▶ ${step}`;
  const clipped = truncateToVisualWidth(step, maxStepCols - 1);
  return `${base} ▶ ${clipped}…`;
}

/**
 * Read cwd/.claude/tasklist.md. Returns null when cwd is undefined, the file
 * is absent, or any read error occurs — the statusline must never crash.
 * The `if (!cwd)` guard is BEFORE join() because join(undefined, …) throws
 * synchronously, ahead of the try/catch.
 */
export async function readTasklist(cwd: string | undefined): Promise<string | null> {
  if (!cwd) return null;
  try {
    const path = join(cwd, ".claude", "tasklist.md");
    if (!existsSync(path)) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
