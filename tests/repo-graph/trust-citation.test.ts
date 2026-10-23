import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { citationExists } from "../../src/repo-graph/trust-citation";

let parent: string;
let root: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "cite-parent-"));
  root = join(parent, "root");
  mkdirSync(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "..foo"));
  writeFileSync(join(root, "src/a.ts"), "1\n2\n3\n");
  writeFileSync(join(root, "..foo/bar.ts"), "1\n2\n");
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

it("exists with enough lines", () => expect(citationExists(root, "src/a.ts", 3)).toBe(true));
it("line beyond EOF", () => expect(citationExists(root, "src/a.ts", 4)).toBe(false));
it("deleted file", () => { unlinkSync(join(root, "src/a.ts")); expect(citationExists(root, "src/a.ts", 1)).toBe(false); });
it("escape is never read", () => {
  writeFileSync(join(parent, "outside-cite.ts"), "x\n");
  expect(citationExists(root, "../outside-cite.ts", 1)).toBe(false);
  expect(citationExists(root, join(root, "src/a.ts"), 1)).toBe(false); // absolute
});
it("line < 1 is false", () => expect(citationExists(root, "src/a.ts", 0)).toBe(false));
it("symlink inside root to file outside root", () => {
  symlinkSync(join(parent, "outside-cite.ts"), join(root, "link-out.ts"));
  writeFileSync(join(parent, "outside-cite.ts"), "x\n");
  expect(citationExists(root, "link-out.ts", 1)).toBe(false);
});
it("dotdot-named dir inside root", () => {
  expect(citationExists(root, "..foo/bar.ts", 2)).toBe(true);
});
