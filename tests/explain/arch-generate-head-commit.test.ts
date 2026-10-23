// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `runArchGenerate` records HEAD (via `ctx.projectRoot`) into
 * `ArchModelMeta.headCommit` at generate time, so a later export can stamp
 * which commit an LLM-derived arch model was built from (spec §4,
 * 2026-09-26). Absent when `projectRoot` is omitted (legacy/CLI callers) —
 * readers must treat undefined as "not recorded", never infer a commit.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchModel } from "../../src/explain/arch-cache";
import { type ArchGenerateCtx, runArchGenerate } from "../../src/explain/arch-generate";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";
import type { RepoGraph, RepoGraphMeta, SiltpokeGraphNode } from "../../src/repo-graph/types";

// ── fixtures (mirrors tests/explain/arch-generate.test.ts) ──────────────────
function fileNode(path: string): SiltpokeGraphNode {
  return { id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, 80] };
}
function fnNode(path: string, name: string, signature: string): SiltpokeGraphNode {
  return { id: `function:${path}:${name}`, type: "function", name, path, lineRange: [12, 40], signature };
}

function fixtureGraph(): RepoGraph {
  return {
    schemaVersion: 1,
    nodes: [fileNode("src/a.ts"), fnNode("src/a.ts", "run", "export function run(): void")],
    edges: [],
  };
}

function fixtureMeta(root: string): RepoGraphMeta {
  return {
    schemaVersion: 1,
    project_root: root,
    proj_hash: "deadbeef0000",
    last_indexed_ts: "2026-06-03T00:00:00Z",
    build_duration_ms: 1,
    counters: {
      files_walked: 1,
      files_cached: 0,
      parse_degraded: 0,
      skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      nodes: { file: 1, function: 1, class: 0, module: 0, symbol: 0 },
      edges: { imports: 0, calls: 0, contains: 0 },
    },
  };
}

const VALID_DOC: ArchModelDoc = {
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: [{ file: "src/a.ts", line: 12 }] }, order: 0, members: ["a"] }],
  nodes: [
    { id: "a", kind: "cont", title: { value: "A", evidence: [{ file: "src/a.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/a.ts", line: 12 }] }, drillTo: "a" },
  ],
  edges: [],
};

async function tmpGraphStorage(root: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arch-head-"));
  await writeFile(join(dir, "graph.json"), JSON.stringify(fixtureGraph()));
  await writeFile(join(dir, "meta.json"), JSON.stringify(fixtureMeta(root)));
  return dir;
}

const git = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
async function tmpGitRepo(): Promise<{ dir: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), "arch-head-repo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.ts"), "export function run(): void {}\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "a");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

function ctxWith(dir: string, brain: ArchGenerateCtx["brainProvider"], over: Partial<ArchGenerateCtx> = {}): ArchGenerateCtx {
  return {
    graphStorageDir: dir,
    brainProvider: brain,
    loadOverlay: async () => null,
    sourceProvider: async () => null,
    ...over,
  };
}

describe("runArchGenerate — headCommit", () => {
  it("with projectRoot pointing at a git repo, the written cache meta records HEAD", async () => {
    const { dir: repo, head } = await tmpGitRepo();
    const storage = await tmpGraphStorage(repo);
    const out = await runArchGenerate(
      ctxWith(storage, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 5, output_tokens: 5, total_cost_usd: 0.1 } }), {
        projectRoot: repo,
      }),
    );
    expect(out.kind).toBe("generated");
    // fingerprint/graphIndexedTs args only gate the `stale` flag — meta is
    // returned either way, so any string is fine for this assertion.
    const cached = await readArchModel(storage, "", "", repo);
    expect(cached?.meta.headCommit).toBe(head);
  });

  it("[83] the Brain is told to run in projectRoot", async () => {
    const { dir: repo } = await tmpGitRepo();
    const storage = await tmpGraphStorage(repo);
    const seen: Array<string | undefined> = [];
    await runArchGenerate(
      ctxWith(
        storage,
        async (input) => {
          seen.push(input.cwd);
          return { markdown: JSON.stringify(VALID_DOC), usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 5, output_tokens: 5, total_cost_usd: 0.1 } };
        },
        { projectRoot: repo },
      ),
    );
    expect(seen).toEqual([repo]);
  });

  it("without projectRoot, headCommit is absent from the written cache meta", async () => {
    const { dir: repo } = await tmpGitRepo();
    const storage = await tmpGraphStorage(repo);
    const out = await runArchGenerate(
      ctxWith(storage, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 5, output_tokens: 5, total_cost_usd: 0.1 } })),
    );
    expect(out.kind).toBe("generated");
    const cached = await readArchModel(storage, "", "", repo);
    expect(cached && "headCommit" in cached.meta).toBe(false);
  });
});
