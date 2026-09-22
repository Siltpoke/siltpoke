// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The real chain: runIndexBuild → anchor discovery with a ceiling → outside
 * count in meta. Pure-function tests of either half cannot see whether the
 * builder actually wires them together (memory delivery-half-has-no-assertions).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { buildFileIndex, resolveImportTarget } from "../../src/repo-graph/import-resolver";
import { readGraph, readMeta } from "../../src/repo-graph/store";

let tmp: string;
let repo: string;
let sub: string;
let home: string;
const write = (abs: string, content: string) => {
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "sp-outside-")));
  repo = join(tmp, "kata");
  sub = join(repo, "TypeScript");
  home = join(tmp, "home");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(home);
  write(join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["shared/*"], "@/*": ["TypeScript/app/*"] } } }));
  write(join(sub, "app", "helper.ts"), "export const help = 1;\n");
  write(
    join(sub, "app", "main.ts"),
    [
      'import { u } from "../../shared/util";',
      'import { log } from "@shared/log";',
      'import { help } from "@/helper";',
      'import { gone } from "./missing";',
      "export const main = 1;",
      "",
    ].join("\n"),
  );
  write(join(sub, "py", "mod.py"), "from ...shared import x\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("index end: imports_outside_root", () => {
  test("a sub-folder index counts the three certain ones; the parent-tsconfig alias into the folder resolves", async () => {
    const r = await runIndexBuild({ cwd: repo, root: sub, home });
    const meta = await readMeta(r.storage_dir);
    expect(meta?.imports_outside_root?.count).toBe(3);
    expect(meta?.imports_outside_root?.examples.some((e) => e.includes("./missing"))).toBe(false);
    const graph = await readGraph(r.storage_dir);
    expect(resolveImportTarget("app/main.ts", "@/helper", buildFileIndex(graph), meta?.anchorMap)).toBe("app/helper.ts");
  });

  test("the whole-repo index of the same tree counts 0 (nothing leaves the repo)", async () => {
    const r = await runIndexBuild({ cwd: repo, home });
    expect((await readMeta(r.storage_dir))?.imports_outside_root).toEqual({ count: 0, examples: [] });
  });
});
