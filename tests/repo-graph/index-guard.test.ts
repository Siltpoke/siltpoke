/**
 * Path validation + allow-root containment, the security core
 * of the in-dashboard index trigger. Each rejection branch is exercised
 * explicitly; the realpath→containment chain is the load-bearing guard against
 * traversal + symlink escape.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateIndexPath, validateListDir } from "../../src/repo-graph/index-guard";
import { computeProjHash } from "../../src/repo-graph/proj-hash";

let root: string; // canonical allow-root for the test
let outside: string; // a dir outside the allow-root

beforeEach(() => {
  // realpath the tmp dir so comparisons are canonical (macOS /tmp → /private/tmp).
  root = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-guard-root-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-guard-out-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const guard = (input: string) => validateIndexPath(input, { allowRoots: [root] });

describe("validateIndexPath — rejections", () => {
  test("empty / whitespace → empty", () => {
    expect(guard("")).toEqual({ ok: false, reason: "empty" });
    expect(guard("   ")).toEqual({ ok: false, reason: "empty" });
  });

  test("relative path → not_absolute", () => {
    expect(guard("some/rel/dir")).toEqual({ ok: false, reason: "not_absolute" });
    expect(guard("./x")).toEqual({ ok: false, reason: "not_absolute" });
  });

  test("non-existent absolute path → not_found", () => {
    expect(guard(join(root, "does-not-exist"))).toEqual({ ok: false, reason: "not_found" });
  });

  test("a file (not a directory) → not_a_directory", () => {
    const f = join(root, "file.ts");
    writeFileSync(f, "x");
    expect(guard(f)).toEqual({ ok: false, reason: "not_a_directory" });
  });

  test("directory outside the allow-root → outside_allow_root", () => {
    const proj = join(outside, "proj");
    mkdirSync(proj);
    expect(guard(proj)).toEqual({ ok: false, reason: "outside_allow_root" });
  });

  test("the allow-root itself (too broad) → outside_allow_root", () => {
    expect(guard(root)).toEqual({ ok: false, reason: "outside_allow_root" });
  });

  test("traversal that escapes the allow-root → rejected (not_found or outside)", () => {
    const r = guard(join(root, "..", "..", "etc"));
    expect(r.ok).toBe(false);
  });

  test("symlink inside the allow-root pointing OUTSIDE → outside_allow_root (realpath escape caught)", () => {
    const link = join(root, "escape");
    symlinkSync(outside, link); // root/escape → outside
    expect(guard(link)).toEqual({ ok: false, reason: "outside_allow_root" });
  });

  test("adjacent-name prefix collision: allowRoot `/x/a`, target `/x/ab` → outside_allow_root", () => {
    // sibling dir whose name has the allow-root's basename as a prefix
    const sibling = `${root}evil`;
    mkdirSync(sibling, { recursive: true });
    const proj = join(sibling, "proj");
    mkdirSync(proj);
    // allowRoots=[root]; target is /…/<root>evil/proj — must NOT be admitted by a
    // bare startsWith(root). The `+ sep` guard rejects it.
    expect(validateIndexPath(proj, { allowRoots: [root] })).toEqual({ ok: false, reason: "outside_allow_root" });
    rmSync(sibling, { recursive: true, force: true });
  });

  test("empty allowRoots → rejects everything (safe-fail, NOT allow-all)", () => {
    const proj = join(root, "proj");
    mkdirSync(proj);
    expect(validateIndexPath(proj, { allowRoots: [] })).toEqual({ ok: false, reason: "outside_allow_root" });
  });

  test("non-string input → empty (no throw)", () => {
    // the future HTTP body could hand us non-strings; guard must not throw
    expect(validateIndexPath(undefined as unknown as string, { allowRoots: [root] })).toEqual({ ok: false, reason: "empty" });
    expect(validateIndexPath(123 as unknown as string, { allowRoots: [root] })).toEqual({ ok: false, reason: "empty" });
  });

  test("a configured allow-root that doesn't exist on disk is skipped, not fatal", () => {
    const proj = join(root, "proj");
    mkdirSync(proj);
    const r = validateIndexPath(proj, { allowRoots: [join(root, "ghost-root"), root] });
    expect(r.ok).toBe(true); // the real root still matches; the ghost is skipped
  });
});

describe("validateIndexPath — accept + canonicalization", () => {
  test("valid dir strictly within the allow-root → ok with realPath + 12-hex projHash", () => {
    const proj = join(root, "myproj");
    mkdirSync(proj);
    const r = guard(proj);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.realPath).toBe(proj);
      expect(r.projHash).toMatch(/^[0-9a-f]{12}$/);
      expect(r.projHash).toBe(computeProjHash(proj));
    }
  });

  test("trailing slash + `.` segments dedupe to the same realPath + hash", () => {
    const proj = join(root, "myproj");
    mkdirSync(proj);
    const a = guard(proj);
    const b = guard(`${proj}/`);
    const c = guard(join(proj, ".", "."));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(b.realPath).toBe(a.realPath);
      expect(c.realPath).toBe(a.realPath);
      expect(b.projHash).toBe(a.projHash);
      expect(c.projHash).toBe(a.projHash);
    }
  });

  test("a symlink inside the allow-root pointing to another dir INSIDE it → ok", () => {
    const realProj = join(root, "real");
    mkdirSync(realProj);
    const link = join(root, "alias");
    symlinkSync(realProj, link);
    const r = guard(link);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.realPath).toBe(realProj); // canonicalized to the real dir
  });

  test("nested dir several levels under the allow-root → ok", () => {
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(guard(deep).ok).toBe(true);
  });

  test("multiple allow-roots: contained in the second is accepted", () => {
    const proj = join(outside, "proj");
    mkdirSync(proj);
    const r = validateIndexPath(proj, { allowRoots: [root, outside] });
    expect(r.ok).toBe(true);
  });
});

// ── validateListDir reuses the same realpath+containment core but ALLOWS
// the allow-root itself (the browser starts at + must list $HOME). ──
describe("validateListDir — browser containment (allowRootItself)", () => {
  const list = (input: string) => validateListDir(input, { allowRoots: [root] });

  test("the allow-root itself → ok (vs validateIndexPath rejects it)", () => {
    const r = list(root);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.realPath).toBe(root);
    // regression: indexing the root-exact is still rejected as too broad
    expect(validateIndexPath(root, { allowRoots: [root] })).toEqual({ ok: false, reason: "outside_allow_root" });
  });

  test("a child dir → ok", () => {
    const child = join(root, "proj");
    mkdirSync(child);
    expect(list(child).ok).toBe(true);
  });

  test("outside the allow-root → outside_allow_root", () => {
    expect(list(outside)).toEqual({ ok: false, reason: "outside_allow_root" });
  });

  test("symlink inside the root pointing outside → outside_allow_root (realpath escape caught)", () => {
    const link = join(root, "escape");
    symlinkSync(outside, link);
    expect(list(link)).toEqual({ ok: false, reason: "outside_allow_root" });
  });

  test("a file → not_a_directory; nonexistent → not_found; relative → not_absolute", () => {
    const f = join(root, "f.ts");
    writeFileSync(f, "x");
    expect(list(f)).toEqual({ ok: false, reason: "not_a_directory" });
    expect(list(join(root, "ghost"))).toEqual({ ok: false, reason: "not_found" });
    expect(list("rel/dir")).toEqual({ ok: false, reason: "not_absolute" });
  });

  test("empty allowRoots → deny-all (safe-fail)", () => {
    expect(validateListDir(root, { allowRoots: [] })).toEqual({ ok: false, reason: "outside_allow_root" });
  });
});
