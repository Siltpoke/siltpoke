// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `makeIndexLocationResolver` is the production wiring behind chat staleness
 * (`chat.ts`) — it fails open when the dep is missing or returns the wrong
 * thing, so nothing under
 * `tests/` importing the server's own closure meant a deleted or swapped
 * field would silently stop showing staleness while the suite stayed green
 * (final review, issue 1). This test builds a REAL sub-folder index (same
 * harness as tests/repo-graph/builder-root.test.ts) and drives the resolver
 * against it — no mocks.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeIndexLocationResolver } from "../../src/repo-graph/repo-registry";
import { runIndexBuild } from "../../src/repo-graph/builder";

let tmp: string;
let repo: string;
let sub: string;
let home: string;

function write(abs: string, content: string): void {
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-index-location-resolver-")));
  repo = join(tmp, "kata");
  sub = join(repo, "pkg", "src");
  home = join(tmp, "home");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(home, { recursive: true });
  write(join(sub, "a.ts"), "export const a = 1;\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("makeIndexLocationResolver", () => {
  test("resolves a sub-folder index to its OWN location, not the repo root's", async () => {
    const built = await runIndexBuild({ cwd: repo, root: sub, force: true, home });
    const repoBuild = await runIndexBuild({ cwd: repo, force: true, home });

    const resolver = makeIndexLocationResolver(home);
    const loc = await resolver(built.proj_hash);
    expect(loc).toEqual({ project_root: sub, storage_dir: built.storage_dir });
    expect(loc).not.toEqual({ project_root: repo, storage_dir: repoBuild.storage_dir });
  });

  test("unknown valid-shaped hash → null", async () => {
    const resolver = makeIndexLocationResolver(home);
    expect(await resolver("aaaaaaaaaaaa")).toBeNull();
  });

  test("malformed hash → null (refused before any path-join)", async () => {
    const resolver = makeIndexLocationResolver(home);
    expect(await resolver("../../x")).toBeNull();
  });
});
