import { describe, expect, test } from "bun:test";
import type {
  CallerResolver,
  CallerSet,
  ResolveOpts,
} from "../../../src/critic/caller-impact/caller-resolver";
import type { ImageReader } from "../../../src/critic/caller-impact/changed-functions";
import {
  buildCallerImpactSection,
  type CallerImpactDeps,
} from "../../../src/critic/caller-impact/inject";

// ---------------------------------------------------------------------------
// Fakes — no git, no rg. Drive buildCallerImpactSection over real diff strings
// + hand-built pre/post images so the whole pipeline runs deterministically.
// ---------------------------------------------------------------------------

/** A resolver that always returns the same caller set (or unavailable). */
function fakeResolver(set: CallerSet): CallerResolver {
  return {
    async resolveCallers(_name: string, _opts: ResolveOpts): Promise<CallerSet> {
      return set;
    },
  };
}

/** An ImageReader backed by two in-memory path→source maps. */
function fakeImages(
  pre: Record<string, string>,
  post: Record<string, string>,
): ImageReader {
  return {
    pre: (path) => (path in pre ? pre[path] : null),
    post: (path) => (path in post ? post[path] : null),
  };
}

function crossFileCallers(file: string, line: number): CallerSet {
  return {
    callers: [{ file, line }],
    defs: 1,
    ambiguous: false,
    callsiteCount: 1,
    unavailable: false,
  };
}

const NO_CALLERS: CallerSet = {
  callers: [],
  defs: 1,
  ambiguous: false,
  callsiteCount: 0,
  unavailable: false,
};

const UNAVAILABLE: CallerSet = {
  callers: [],
  defs: 0,
  ambiguous: false,
  callsiteCount: 0,
  unavailable: true,
};

// A `modified` diff for `foo` whose param count goes 1 → 2 (signature change).
// The hunk replaces the signature line so a removed-old + added-new land on the
// function body, marking it `modified`.
const SIG_CHANGE_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 111..222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,3 @@",
  "-export function foo(a) {",
  "+export function foo(a, b) {",
  "   return a;",
  " }",
].join("\n");

const FOO_PRE = ["export function foo(a) {", "  return a;", "}"].join("\n");
const FOO_POST_SIGCHANGE = ["export function foo(a, b) {", "  return a;", "}"].join("\n");

function depsFor(images: ImageReader, callers: CallerSet): CallerImpactDeps {
  return { images, resolver: fakeResolver(callers) };
}

describe("buildCallerImpactSection", () => {
  test("modified foo (param count changed) + cross-file caller ⇒ section + tokens contain caller token", async () => {
    const images = fakeImages({ "src/foo.ts": FOO_PRE }, { "src/foo.ts": FOO_POST_SIGCHANGE });
    const result = await buildCallerImpactSection(
      { diffBody: SIG_CHANGE_DIFF, changedFiles: ["src/foo.ts"], cwd: "/repo" },
      depsFor(images, crossFileCallers("src/bar.ts", 42)),
    );

    expect(result.section).toContain("caller: src/bar.ts:42");
    expect(result.section).toContain("Caller impact");
    expect(result.tokens).toContain("caller: src/bar.ts:42");
  });

  test("body-only change (signature unchanged) ⇒ empty", async () => {
    // foo's param count stays 1; only the body line changes.
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +1,3 @@",
      " export function foo(a) {",
      "-  return a;",
      "+  return a + 1;",
      " }",
    ].join("\n");
    const pre = ["export function foo(a) {", "  return a;", "}"].join("\n");
    const post = ["export function foo(a) {", "  return a + 1;", "}"].join("\n");
    const images = fakeImages({ "src/foo.ts": pre }, { "src/foo.ts": post });

    const result = await buildCallerImpactSection(
      { diffBody: diff, changedFiles: ["src/foo.ts"], cwd: "/repo" },
      depsFor(images, crossFileCallers("src/bar.ts", 42)),
    );

    expect(result).toEqual({ section: "", tokens: [] });
  });

  test("zero callers ⇒ empty, no throw", async () => {
    const images = fakeImages({ "src/foo.ts": FOO_PRE }, { "src/foo.ts": FOO_POST_SIGCHANGE });
    const result = await buildCallerImpactSection(
      { diffBody: SIG_CHANGE_DIFF, changedFiles: ["src/foo.ts"], cwd: "/repo" },
      depsFor(images, NO_CALLERS),
    );
    expect(result).toEqual({ section: "", tokens: [] });
  });

  test("resolver unavailable ⇒ empty, no throw", async () => {
    const images = fakeImages({ "src/foo.ts": FOO_PRE }, { "src/foo.ts": FOO_POST_SIGCHANGE });
    const result = await buildCallerImpactSection(
      { diffBody: SIG_CHANGE_DIFF, changedFiles: ["src/foo.ts"], cwd: "/repo" },
      depsFor(images, UNAVAILABLE),
    );
    expect(result).toEqual({ section: "", tokens: [] });
  });

  test("empty diff ⇒ empty", async () => {
    const result = await buildCallerImpactSection(
      { diffBody: "   ", changedFiles: [], cwd: "/repo" },
      depsFor(fakeImages({}, {}), crossFileCallers("src/bar.ts", 1)),
    );
    expect(result).toEqual({ section: "", tokens: [] });
  });

  test("missing pre image ⇒ no signature delta ⇒ empty", async () => {
    // post present, pre absent — sig-delta cannot be computed, no block.
    const images = fakeImages({}, { "src/foo.ts": FOO_POST_SIGCHANGE });
    const result = await buildCallerImpactSection(
      { diffBody: SIG_CHANGE_DIFF, changedFiles: ["src/foo.ts"], cwd: "/repo" },
      depsFor(images, crossFileCallers("src/bar.ts", 42)),
    );
    expect(result).toEqual({ section: "", tokens: [] });
  });

  test("removed function still referenced ⇒ orphan block + token", async () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,3 +0,0 @@",
      "-export function gone(a) {",
      "-  return a;",
      "-}",
    ].join("\n");
    const pre = ["export function gone(a) {", "  return a;", "}"].join("\n");
    const images = fakeImages({ "src/foo.ts": pre }, { "src/foo.ts": "" });

    const result = await buildCallerImpactSection(
      { diffBody: diff, changedFiles: ["src/foo.ts"], cwd: "/repo" },
      depsFor(images, crossFileCallers("src/bar.ts", 7)),
    );

    expect(result.section).toContain("caller: src/bar.ts:7");
    expect(result.tokens).toContain("caller: src/bar.ts:7");
  });
});
