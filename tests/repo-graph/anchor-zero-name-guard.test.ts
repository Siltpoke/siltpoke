/**
 * Zero framework/dir/repo-name red line for the alias-edge resolver.
 *
 * The anchor discovery + tier-4 resolution must contain NO hardcoded framework,
 * directory-position, or repo-name literal — anchors are learned from the
 * project's own config + structure, never assumed. The guard greps the CODE
 * (comments stripped — a doc example like `react` is not a cheat) for quoted
 * forbidden literals and asserts none.
 *
 * Allowed (ecosystem/language conventions, NOT framework identity): tsconfig,
 * jsconfig, paths, baseUrl, compilerOptions, __init__ — these are the config
 * SCHEMA keys / language package markers the discovery legitimately reads.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = [
  // TS frameworks / bundlers + the Next-specific alias literal
  "next", "nextjs", "react", "vite", "webpack", "@/",
  // Python frameworks / dir-position assumptions
  "django", "flask", "manage", "backend", "frontend", "apps",
  // repo name (this project)
  "siltpoke",
];

// The new alias-edge surface: the discovery module + the resolver (tier-4 lives here).
const FILES = [
  "src/repo-graph/anchor-discovery.ts",
  "src/repo-graph/import-resolver.ts",
];

/** Strip block + line comments so doc examples don't trip the guard. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // line comments (avoid matching "://")
}

describe("alias-edge resolver — zero framework/dir/repo names in CODE", () => {
  for (const rel of FILES) {
    test(`${rel} code has no forbidden literal`, () => {
      const code = stripComments(
        readFileSync(join(import.meta.dir, "..", "..", rel), "utf8"),
      );
      const hits = FORBIDDEN.filter((n) =>
        new RegExp(`['"\`]${n}['"\`]`, "i").test(code),
      );
      expect(hits).toEqual([]);
    });
  }

  test("the allow-list tokens are deliberately NOT in the forbidden set", () => {
    for (const ok of ["tsconfig", "jsconfig", "paths", "baseUrl", "compilerOptions", "__init__"]) {
      expect(FORBIDDEN).not.toContain(ok);
    }
  });
});
