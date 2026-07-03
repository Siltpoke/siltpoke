import { test, expect } from "bun:test";
import { composeOutput } from "../../src/face/composer";

const face = ["  ___  ", " (o.o) ", " (___) "].join("\n");
const ESC = "\x1b";

test("composes face on the left, inner on the right", () => {
  const out = composeOutput({ face, inner: "hello\nworld", termWidth: 200 });
  const lines = out.split("\n");
  expect(lines.length).toBe(3);
  expect(lines[0]).toContain("___");
  expect(lines[0]).toContain("hello");
});

test("inner-only fallback when termWidth too narrow", () => {
  const out = composeOutput({ face, inner: "hello", termWidth: 5 });
  expect(out).toBe("hello");
});

test("pads face to widest line so inner aligns vertically", () => {
  const out = composeOutput({ face, inner: "a\nb\nc", termWidth: 200 });
  const lines = out.split("\n");
  for (const line of lines) {
    expect(line.length).toBeGreaterThan(7);
  }
});

test("more inner lines than face lines extends face with blank rows", () => {
  const out = composeOutput({ face, inner: "1\n2\n3\n4\n5", termWidth: 200 });
  expect(out.split("\n").length).toBe(5);
});

test("more face lines than inner lines extends inner with blank rows", () => {
  const out = composeOutput({ face, inner: "only", termWidth: 200 });
  expect(out.split("\n").length).toBe(3);
});

test("empty face returns inner unchanged", () => {
  expect(composeOutput({ face: "", inner: "abc", termWidth: 200 })).toBe("abc");
});

test("empty inner returns the face standalone (fresh install, no inner statusline)", () => {
  expect(composeOutput({ face, inner: "", termWidth: 200 })).toBe(face);
});

test("preserves ANSI escapes in inner output", () => {
  const ansi = `${ESC}[36mhi${ESC}[0m`;
  const out = composeOutput({ face, inner: ansi, termWidth: 200 });
  expect(out).toContain(`${ESC}[36m`);
  expect(out).toContain(`${ESC}[0m`);
});

test("termWidth of 0 disables width gate (always splices)", () => {
  const out = composeOutput({ face, inner: "x", termWidth: 0 });
  expect(out).toContain("___");
  expect(out).toContain("x");
});
