import { describe, expect, test } from "bun:test";
import { wrapText } from "../../../src/web/client/export/layout-text";

// Fixed sizes the module documents: title 14px, body 11px, mono 10px.
describe("wrapText", () => {
  test("long English title wraps within maxWidth and loses no words", () => {
    const text = "Persistent memory and preference storage for the reviewer brain and critic";
    const lines = wrapText(text, "title", 140);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(text);
    // 14px * 0.58 * up-to-1.25 for wide latin glyphs: no line may exceed the budget
    for (const l of lines) expect(l.length * 14 * 0.58 * 0.5).toBeLessThanOrEqual(140);
  });
  test("20-character CJK title wraps by character count and never overflows", () => {
    const text = "这是一个很长的中文标题用来测试换行是否不会溢出框";
    expect(Array.from(text).length).toBe(24);
    const lines = wrapText(text, "title", 140); // CJK = 1em = 14px -> at most 10 per line
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(Array.from(l).length * 14).toBeLessThanOrEqual(140);
    expect(lines.join("")).toBe(text);
  });
  test("emoji counts as a full em", () => {
    const lines = wrapText("📁📁📁📁📁📁📁📁📁📁📁📁", "body", 55); // 11px each -> 5 per line
    for (const l of lines) expect(Array.from(l).length * 11).toBeLessThanOrEqual(55);
    expect(lines.join("")).toBe("📁".repeat(12));
  });
  test("an unbreakable long token is split, not overflowed", () => {
    const lines = wrapText("src/very/long/path/without/any/spaces/at/all/file.ts", "mono", 60);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length * 10 * 0.6).toBeLessThanOrEqual(60);
    expect(lines.join("")).toBe("src/very/long/path/without/any/spaces/at/all/file.ts");
  });
  test("empty string yields one empty line", () => {
    expect(wrapText("", "body", 100)).toEqual([""]);
  });
  test("short text stays on one line; whitespace is collapsed", () => {
    expect(wrapText("a  b\n c", "body", 500)).toEqual(["a b c"]);
  });
});
