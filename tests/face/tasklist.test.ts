import { test, expect } from "bun:test";
import { parseTasklist } from "../../src/face/tasklist.ts";

const SAMPLE = `<!-- plc-tasklist: cc130a2281c1 -->
# Phase dep-boundary — track PLC's principle

## Write
- [x] Write references/dependency-boundary.md
- [x] SKILL.md: add pointer
- [x] confirm no banned token

## Verify
- [x] python3 scripts/validate.py green

## Wrap-up
- [x] CHANGELOG entry
- [x] journal FACT
- [x] spec + plan docs
- [x] refresh evidence fingerprint

## Awaiting
- [/] human merge of the pull request (merge is human-only)
`;

test("parses the real PLC sample: 8/9 with the in-progress step", () => {
  expect(parseTasklist(SAMPLE)).toEqual({
    done: 8,
    total: 9,
    currentStep: "human merge of the pull request (merge is human-only)",
  });
});

test("uppercase [X] counts as done", () => {
  expect(parseTasklist("- [X] a\n- [ ] b")).toEqual({ done: 1, total: 2 });
});

test("unknown state char counts as todo, never crashes", () => {
  expect(parseTasklist("- [?] a\n- [~] b\n- [x] c")).toEqual({ done: 1, total: 3 });
});

test("alternate list markers * and + are counted", () => {
  expect(parseTasklist("* [x] a\n+ [ ] b")).toEqual({ done: 1, total: 2 });
});

test("multiple spaces after marker still match", () => {
  expect(parseTasklist("-   [x]   done task")).toEqual({ done: 1, total: 1 });
});

test("checkbox with no trailing description is counted", () => {
  expect(parseTasklist("- [x]\n- [/] real step")).toEqual({
    done: 1,
    total: 2,
    currentStep: "real step",
  });
});

test("checkboxes inside a fenced code block are ignored", () => {
  const md = "- [x] real\n```yaml\n- [ ] example\n- [ ] example2\n```\n- [/] step";
  expect(parseTasklist(md)).toEqual({ done: 1, total: 2, currentStep: "step" });
});

test("no checkbox leaves returns null", () => {
  expect(parseTasklist("# heading\n\njust prose\n")).toBeNull();
});

test("first [/] wins for currentStep", () => {
  expect(parseTasklist("- [/] first\n- [/] second")).toEqual({
    done: 0,
    total: 2,
    currentStep: "first",
  });
});

import { formatTasklistSegment } from "../../src/face/tasklist.ts";

test("all done renders the check mark", () => {
  expect(formatTasklistSegment({ done: 10, total: 10 })).toBe("📋 10/10 ✓");
});

test("in-progress step renders the play glyph", () => {
  expect(formatTasklistSegment({ done: 8, total: 9, currentStep: "human merge" })).toBe(
    "📋 8/9 ▶ human merge",
  );
});

test("no current step renders count only", () => {
  expect(formatTasklistSegment({ done: 3, total: 9 })).toBe("📋 3/9");
});

test("empty current step falls back to count only", () => {
  expect(formatTasklistSegment({ done: 3, total: 9, currentStep: "" })).toBe("📋 3/9");
});

test("long ASCII step is truncated to maxStepCols with an ellipsis", () => {
  const step = "a".repeat(60);
  const out = formatTasklistSegment({ done: 1, total: 9, currentStep: step }, 40);
  // 39 kept chars + the ellipsis
  expect(out).toBe(`📋 1/9 ▶ ${"a".repeat(39)}…`);
});

test("CJK step truncates by visual width (2 cols per char), not char count", () => {
  const step = "任".repeat(30); // 60 visual cols
  const out = formatTasklistSegment({ done: 1, total: 9, currentStep: step }, 40);
  // maxStepCols-1 = 39 visual cols → floor(39/2) = 19 chars, then ellipsis
  expect(out).toBe(`📋 1/9 ▶ ${"任".repeat(19)}…`);
});

test("control chars / ANSI escapes in the step are stripped", () => {
  const out = formatTasklistSegment({ done: 1, total: 9, currentStep: "a\x1b[31mb\x07c" });
  expect(out).toBe("📋 1/9 ▶ abc");
});

test("short step within budget is untouched (no ellipsis)", () => {
  expect(formatTasklistSegment({ done: 1, total: 9, currentStep: "short" })).toBe(
    "📋 1/9 ▶ short",
  );
});

import { readTasklist } from "../../src/face/tasklist.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("readTasklist returns null when cwd is undefined (no join crash)", async () => {
  expect(await readTasklist(undefined)).toBeNull();
});

test("readTasklist returns null when the file is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-tl-"));
  try {
    expect(await readTasklist(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTasklist returns the file contents when present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-tl-"));
  try {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "tasklist.md"), "- [x] a\n- [ ] b");
    expect(await readTasklist(dir)).toBe("- [x] a\n- [ ] b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tasklist module has no PLC coupling and no shellout", () => {
  const src = readFileSync(new URL("../../src/face/tasklist.ts", import.meta.url), "utf8");
  expect(src.toLowerCase()).not.toContain("plc");
  expect(src).not.toMatch(/tasklist-view/);
  expect(src).not.toMatch(/Bun\.spawn|spawnSync|execSync|child_process|(?<!\.)\bexec\(/);
});
