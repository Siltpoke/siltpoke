/**
 * Defect [38] for runArchGenerate: the cost is only known after the money is
 * spent, so an over-cap model is KEPT and flagged, never discarded.
 * (Split out of arch-generate.test.ts; Brain mocked.)
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archModelPath } from "../../src/explain/arch-cache";
import type { BrainUsage } from "../../src/brain/brain";
import type { RepoGraph, RepoGraphMeta } from "../../src/repo-graph/types";
import { runArchGenerate, type ArchGenerateCtx } from "../../src/explain/arch-generate";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";

// ── fixtures ───────────────────────────────────────────────────────────────
function fixtureGraph(): RepoGraph {
  return {
    schemaVersion: 1,
    nodes: [
      { id: "file:src/brain/brain.ts:", type: "file", name: "brain.ts", path: "src/brain/brain.ts", lineRange: [1, 80] },
      {
        id: "function:src/brain/brain.ts:runBrain",
        type: "function",
        name: "runBrain",
        path: "src/brain/brain.ts",
        lineRange: [12, 40],
        signature: "export async function runBrain(o: BrainOpts): Promise<BrainCallResult>",
        doc: "spawn claude -p",
      },
      { id: "file:src/critic/run-critic.ts:", type: "file", name: "run-critic.ts", path: "src/critic/run-critic.ts", lineRange: [1, 80] },
      {
        id: "function:src/critic/run-critic.ts:runCritic",
        type: "function",
        name: "runCritic",
        path: "src/critic/run-critic.ts",
        lineRange: [12, 40],
        signature: "export async function runCritic(ctx: CriticCtx): Promise<Critique>",
      },
    ],
    edges: [
      {
        id: "file:src/critic/run-critic.ts:::imports::../brain/brain",
        type: "imports",
        source: "file:src/critic/run-critic.ts:",
        target: "../brain/brain",
        weight: 1,
      },
    ],
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
      files_walked: 2,
      files_cached: 0,
      parse_degraded: 0,
      skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      nodes: { file: 2, function: 2, class: 0, module: 0, symbol: 0 },
      edges: { imports: 1, calls: 0, contains: 0 },
    },
  };
}

const VALID_DOC: ArchModelDoc = {
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, order: 0, members: ["brain", "critic"] }],
  nodes: [
    { id: "brain", kind: "cont", title: { value: "Brain", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, drillTo: "brain" },
    { id: "critic", kind: "cont", title: { value: "Critic", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] }, drillTo: "critic" },
  ],
  edges: [{ source: "critic", target: "brain", verb: { value: "spawns claude -p", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] } }],
};

function ctxWith(dir: string, brain: ArchGenerateCtx["brainProvider"], over: Partial<ArchGenerateCtx> = {}): ArchGenerateCtx {
  return {
    graphStorageDir: dir,
    brainProvider: brain,
    loadOverlay: async () => null,
    sourceProvider: async () => null,
    ...over,
  };
}
function usage(cost: number): BrainUsage {
  return { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: cost };
}

async function tmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arch-"));
  await writeFile(join(dir, "graph.json"), JSON.stringify(fixtureGraph()));
  await writeFile(join(dir, "meta.json"), JSON.stringify(fixtureMeta(dir)));
  return dir;
}

describe("runArchGenerate — outcomes", () => {
  it("over hard cap → generated with the doc, flagged hardCapExceeded", async () => {
    const dir = await tmpRepo();
    const out = await runArchGenerate(
      ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: usage(5.0) }), { costHardCapUsd: 2.0 }),
    );
    if (out.kind !== "generated") throw new Error(`expected generated, got ${out.kind}`);
    expect(out.hardCapExceeded).toBe(true);
    expect(out.hardCapUsd).toBe(2.0);
    expect(out.costUsd).toBe(5.0);
    expect(out.doc.nodes.length).toBeGreaterThan(0);
  });

  it("under hard cap → hardCapExceeded false", async () => {
    const dir = await tmpRepo();
    const out = await runArchGenerate(
      ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: usage(1.0) }), { costHardCapUsd: 2.0 }),
    );
    if (out.kind !== "generated") throw new Error(`expected generated, got ${out.kind}`);
    expect(out.hardCapExceeded).toBe(false);
  });
});

describe("runArchGenerate — cache", () => {
  it("an over-cap model is cached, and the cache hit keeps the flag", async () => {
    const dir = await tmpRepo();
    let calls = 0;
    const brain = async () => { calls++; return { markdown: JSON.stringify(VALID_DOC), usage: usage(5.0) }; };
    const out = await runArchGenerate(ctxWith(dir, brain, { costHardCapUsd: 2.0 }));
    expect(out.kind).toBe("generated");
    expect(existsSync(archModelPath(dir))).toBe(true);
    const again = await runArchGenerate(ctxWith(dir, brain, { costHardCapUsd: 2.0 }));
    if (again.kind !== "generated") throw new Error(`expected generated, got ${again.kind}`);
    expect(again.fromCache).toBe(true);
    expect(again.hardCapExceeded).toBe(true);
    expect(calls).toBe(1);
  });
});
