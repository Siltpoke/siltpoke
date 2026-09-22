// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Spec 2026-09-14 §5.2: a sub-folder root with no tsconfig of its own uses the
 * nearest one above it, never beyond the enclosing repo. Targets are re-based
 * to the root, so one that leaves the root starts with `../`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAnchorMap, parentConfigRules } from "../../src/repo-graph/anchor-discovery";
import type { RepoGraph } from "../../src/repo-graph/types";

let tmp: string;
let repo: string;
let sub: string;
const emptyGraph: RepoGraph = { schemaVersion: 1, nodes: [], edges: [] };
const tsconfig = (paths: Record<string, string[]>) => JSON.stringify({ compilerOptions: { baseUrl: ".", paths } });

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sp-anchor-parent-")));
  repo = join(tmp, "repo");
  sub = join(repo, "TypeScript");
  mkdirSync(sub, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("parentConfigRules / discoverAnchorMap with a ceiling", () => {
  test("repo-level tsconfig: an alias into the root is re-based inside, one leaving it starts with ../", () => {
    writeFileSync(join(repo, "tsconfig.json"), tsconfig({ "@/*": ["TypeScript/src/*"], "@shared/*": ["shared/*"] }));
    const map = discoverAnchorMap(sub, emptyGraph, { ceiling: repo });
    expect(map.tsAliases).toEqual([
      { scopeDir: "", prefix: "@/", targets: ["src/"] },
      { scopeDir: "", prefix: "@shared/", targets: ["../shared/"] },
    ]);
  });

  test("the root has its own tsconfig → the parent is not consulted", () => {
    writeFileSync(join(repo, "tsconfig.json"), tsconfig({ "@shared/*": ["shared/*"] }));
    writeFileSync(join(sub, "tsconfig.json"), tsconfig({ "~/*": ["src/*"] }));
    const withCeiling = discoverAnchorMap(sub, emptyGraph, { ceiling: repo });
    expect(withCeiling).toEqual(discoverAnchorMap(sub, emptyGraph));
    expect(withCeiling.tsAliases.map((r) => r.prefix)).toEqual(["~/"]);
  });

  test("a config above the ceiling is never read", () => {
    writeFileSync(join(tmp, "tsconfig.json"), tsconfig({ "@x/*": ["x/*"] }));
    expect(parentConfigRules(sub, repo)).toEqual([]);
  });

  test("root === ceiling (a whole-repo index) → no walk-up", () => {
    writeFileSync(join(tmp, "tsconfig.json"), tsconfig({ "@x/*": ["x/*"] }));
    expect(parentConfigRules(repo, repo)).toEqual([]);
  });

  test("no ceiling → today's behavior, byte-identical", () => {
    writeFileSync(join(repo, "tsconfig.json"), tsconfig({ "@/*": ["TypeScript/src/*"] }));
    expect(discoverAnchorMap(sub, emptyGraph).tsAliases).toEqual([]);
  });

  test(
    "ceiling has a trailing slash — still finds the config sitting right at the ceiling",
    () => {
      writeFileSync(join(repo, "tsconfig.json"), tsconfig({ "@/*": ["TypeScript/src/*"] }));
      expect(parentConfigRules(sub, `${repo}/`)).toEqual(parentConfigRules(sub, repo));
      expect(parentConfigRules(sub, `${repo}/`)).toEqual([
        { scopeDir: "", prefix: "@/", targets: ["src/"] },
      ]);
    },
    2000,
  );

  test(
    "a doubled slash in root terminates and never reads a config above the ceiling",
    () => {
      // above the ceiling — must never be read, and must not make the walk-up spin
      writeFileSync(join(tmp, "tsconfig.json"), tsconfig({ "@x/*": ["x/*"] }));
      expect(parentConfigRules(`${repo}//TypeScript`, repo)).toEqual([]);
    },
    2000,
  );
});
