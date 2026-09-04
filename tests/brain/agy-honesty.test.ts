// Cross-family-honesty detector (track #7 T7): isClaudeFamilyModel is a pure
// string-prefix classifier over agy's `--model` menu values (Task 1 spike's
// `agy models` output). No I/O, no state — the warn-once wiring itself is
// covered in tests/brain/brain-guarded.test.ts (the seam that owns warn-once).
import { test, expect } from "bun:test";
import { isClaudeFamilyModel } from "../../src/brain/agy-honesty";

test("true for agy's real Claude-family display strings (Task 1 spike's `agy models` output)", () => {
  expect(isClaudeFamilyModel("Claude Sonnet 4.6 (Thinking)")).toBe(true);
  expect(isClaudeFamilyModel("Claude Opus 4.6 (Thinking)")).toBe(true);
});

test("true for claude- prefixed programmatic model ids", () => {
  expect(isClaudeFamilyModel("claude-3-5-sonnet-20241022")).toBe(true);
  expect(isClaudeFamilyModel("claude-opus-4-6")).toBe(true);
});

test("false for agy's Gemini display strings", () => {
  expect(isClaudeFamilyModel("Gemini 3.5 Flash (Medium)")).toBe(false);
  expect(isClaudeFamilyModel("Gemini 3.5 Flash (High)")).toBe(false);
  expect(isClaudeFamilyModel("Gemini 3.5 Flash (Low)")).toBe(false);
  expect(isClaudeFamilyModel("Gemini 3.1 Pro (Low)")).toBe(false);
  expect(isClaudeFamilyModel("Gemini 3.1 Pro (High)")).toBe(false);
});

test("false for other non-Claude entries", () => {
  expect(isClaudeFamilyModel("GPT-OSS 120B (Medium)")).toBe(false);
  expect(isClaudeFamilyModel("")).toBe(false);
  expect(isClaudeFamilyModel("gpt-4o")).toBe(false);
});

test("false for strings that merely contain 'claude' without the matching prefix", () => {
  expect(isClaudeFamilyModel("not-claude-at-all")).toBe(false);
  expect(isClaudeFamilyModel("clauderiffic")).toBe(false);
});
