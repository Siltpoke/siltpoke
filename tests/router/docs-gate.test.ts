// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The docs gate's classifier (spec D7 / AC7-AC8).
 *
 * The assertions that matter most here are the NEGATIVE ones — "this must NOT
 * be classified as docs" — because that is the direction where a mistake is
 * silent. A file wrongly called docs is never reviewed and nothing says so.
 */
import { describe, expect, test } from "bun:test";
import { anyCodeChanged, isCode } from "../../src/router/docs-gate";

describe("isCode — prose and assets are not code", () => {
  test.each([
    "README.md",
    "docs/NOTES.md",
    "docs/specs/some-feature-design.md",
    "notes.txt",
    "CHANGELOG.markdown",
    "doc.rst",
    "guide.adoc",
    "LICENSE",
    "NOTICE",
    "assets/pet.png",
    "public/icon.svg",
    "fonts/inter.woff2",
  ])("%s is docs", (path) => {
    expect(isCode(path)).toBe(false);
  });
});

describe("isCode — everything the walker's language table covers", () => {
  test.each(["src/a.ts", "src/a.tsx", "src/a.js", "src/a.jsx", "scripts/a.py"])(
    "%s is code",
    (path) => {
      expect(isCode(path)).toBe(true);
    },
  );
});

describe("isCode — what the walker's table would have missed (R3)", () => {
  // Every one of these is a real tracked path shape in this repo, and every one
  // of them is `not code` under the literal D7 rule (SOURCE_EXT_TO_LANG is
  // ts|tsx|js|jsx|py and nothing else). A turn that touches only one of them is
  // a real change to how the project builds, ships, or gates itself.
  test.each([
    ".github/workflows/ci.yml",
    "docs/tracks.yaml",
    "scripts/close-gate.sh",
    ".claude/close-gate.json",
    ".claude-plugin/plugin.json",
    ".dependency-cruiser.cjs",
    "src/web/styles.css",
    "pyproject.toml",
    "Makefile",
    "Dockerfile",
    "CODEOWNERS",
    ".github/CODEOWNERS",
    "src/index.html",
    "query.sql",
    "main.go",
    "lib.rs",
  ])("%s is code", (path) => {
    expect(isCode(path)).toBe(true);
  });
});

describe("isCode — a binary that is EXECUTED is not an asset", () => {
  // These four are tracked in this repo. `.wasm` sat in the asset set beside
  // `.png` in the first version of this file, which meant a turn that swapped
  // one of them — a version bump, or a substituted binary — was filed
  // `docs_only` and never looked at, with the ledger naming the file nobody
  // reviewed. Found by review, not by this suite, which is why it is pinned.
  test.each([
    "dist/wasm/web-tree-sitter.wasm",
    "dist/wasm/tree-sitter-typescript.wasm",
    "src/critic/rubric/tier2/wasm/tree-sitter-python.wasm",
    "vendor/thing.wasm",
  ])("%s is code", (path) => {
    expect(isCode(path)).toBe(true);
  });

  test("the assets that are only DISPLAYED are still assets", () => {
    // The counterpart, so "make everything code" does not pass the test above.
    expect(isCode("assets/pet.png")).toBe(false);
    expect(isCode("fonts/inter.woff2")).toBe(false);
    expect(isCode("clip.mp4")).toBe(false);
  });
});

describe("isCode — AC8, a prompt is code even as markdown", () => {
  test.each([
    "prompts/system.md",
    "src/prompts/critic.md",
    "src/brain/Prompts/reviewer.md",
    "deep/nested/prompts/a/b/c.md",
    "src/critic/rubric.prompt.md",
    "docs/anything.PROMPT.MD",
  ])("%s is code", (path) => {
    expect(isCode(path)).toBe(true);
  });

  test("a directory merely CONTAINING the word prompts does not count", () => {
    // `prompts-archive` is a different directory than `prompts`. Matching on a
    // substring would make this a prompt, which is how a docs directory quietly
    // becomes un-skippable.
    expect(isCode("prompts-archive/old.md")).toBe(false);
  });

  test("the basename rule needs the full `.prompt.md`, not just `prompt`", () => {
    expect(isCode("docs/prompt.md")).toBe(false);
  });
});

describe("isCode — path shapes", () => {
  test("a dotfile's name is not its extension", () => {
    // `.gitignore` has one dot, at index 0. Reading "gitignore" as an extension
    // would make every dotfile its own unrecognised type.
    expect(isCode(".gitignore")).toBe(true);
    expect(isCode(".env.example")).toBe(true);
  });

  test("windows separators classify the same as posix ones", () => {
    expect(isCode("docs\\NOTES.md")).toBe(false);
    expect(isCode("src\\prompts\\critic.md")).toBe(true);
  });

  test("extension matching is case-insensitive", () => {
    expect(isCode("README.MD")).toBe(false);
    expect(isCode("photo.PNG")).toBe(false);
  });

  test("an empty path is not code; a malformed one falls to the safe side", () => {
    // No basename at all — there is nothing to classify, and answering `true`
    // would let a junk entry force a review on its own.
    expect(isCode("")).toBe(false);
    // A trailing separator leaves `docs` as the basename, which has no
    // extension and so resolves to code. That is the intended direction: a path
    // shape this function does not understand must not be the reason a real
    // change is skipped in silence.
    expect(isCode("docs/")).toBe(true);
  });
});

describe("anyCodeChanged", () => {
  test("one code file among many docs is enough to review", () => {
    expect(anyCodeChanged(["README.md", "docs/a.md", "src/x.ts"])).toBe(true);
  });

  test("all docs means no code changed", () => {
    expect(anyCodeChanged(["README.md", "docs/a.md", "notes.txt"])).toBe(false);
  });

  test("an empty list answers false, and the caller must not call that docs_only", () => {
    // Stated as a test because the distinction is the whole of AC9: the hook
    // reports `no_code_changes` for this case and `docs_only` for the one
    // above, and this function cannot tell them apart on its own.
    expect(anyCodeChanged([])).toBe(false);
  });
});
