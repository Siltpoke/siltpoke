import { test, expect } from "bun:test";
import { stripAnsi, visibleWidth, visibleWidthOfWidestLine } from "../../src/face/width";

const ESC = "\x1b";

test("stripAnsi removes color escape sequences", () => {
  const colored = `${ESC}[36m[Claude]${ESC}[0m`;
  expect(stripAnsi(colored)).toBe("[Claude]");
});

test("visibleWidth ignores ANSI escapes", () => {
  expect(visibleWidth(`${ESC}[36mhello${ESC}[0m`)).toBe(5);
});

test("visibleWidth of plain string equals code-point length", () => {
  expect(visibleWidth("abcde")).toBe(5);
});

test("visibleWidthOfWidestLine returns longest visible line", () => {
  const block = `${ESC}[36mhi${ESC}[0m\nworld!\nok`;
  expect(visibleWidthOfWidestLine(block)).toBe(6);
});

test("stripAnsi handles empty string", () => {
  expect(stripAnsi("")).toBe("");
  expect(visibleWidth("")).toBe(0);
});
