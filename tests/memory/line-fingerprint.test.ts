import { test, expect } from "bun:test";
import { contentFingerprint, lineContentFingerprint, fileContentFingerprints } from "../../src/memory/line-fingerprint";

const file = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"].join("\n");

test("contentFingerprint ignores pure whitespace reformat", () => {
  expect(contentFingerprint("const c = 3;")).toBe(contentFingerprint("const   c   =   3;"));
});

test("lineContentFingerprint of the flagged line matches contentFingerprint of that line's text", () => {
  expect(lineContentFingerprint(file, 3)).toBe(contentFingerprint("const c = 3;"));
});

test("out-of-range or blank line returns empty string", () => {
  expect(lineContentFingerprint(file, 999)).toBe("");
  expect(lineContentFingerprint("a\n\nb", 2)).toBe("");
});

test("fileContentFingerprints: flagged content still present after an UNRELATED upstream edit (drift-robust)", () => {
  const fp = lineContentFingerprint(file, 3);
  const shifted = "const z = 0;\n" + file;
  expect(fileContentFingerprints(shifted).has(fp)).toBe(true);
});

test("fileContentFingerprints: flagged content GONE after a real edit to that line", () => {
  const fp = lineContentFingerprint(file, 3);
  const edited = file.replace("const c = 3;", "const c = 99;");
  expect(fileContentFingerprints(edited).has(fp)).toBe(false);
});
