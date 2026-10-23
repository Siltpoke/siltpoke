/**
 * Defect [38] for runExplain: the money is already spent when the cost is
 * known, so an over-cap result is KEPT and flagged, never discarded.
 * (Split out of explain.test.ts; Brain injected via BrainProvider.)
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExplain, type BrainProvider, type ExplainCtx } from "../../src/explain/explain";
import { writeGraph, writeMeta, writeQueryIndex } from "../../src/repo-graph/store";
import { emptyCounters, type RepoGraph, type RepoGraphMeta, type QueryIndex } from "../../src/repo-graph/types";

let cwd: string;
let storageDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "siltpoke-explain-"));
  storageDir = join(cwd, "repo-memory", "abc123def456");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

async function seedGraph(): Promise<void> {
  const targetId = "function:src/cli/doctor.ts:runDoctor";
  const fileId = "file:src/cli/doctor.ts:";
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [
      { id: fileId, type: "file", name: "doctor.ts", path: "src/cli/doctor.ts", lineRange: [1, 200] },
      { id: targetId, type: "function", name: "runDoctor", path: "src/cli/doctor.ts", lineRange: [42, 87] },
      { id: "function:src/cli/doctor.ts:helper", type: "function", name: "helper", path: "src/cli/doctor.ts", lineRange: [10, 15] },
    ],
    edges: [{ id: `${fileId}::contains::${targetId}`, source: fileId, target: targetId, type: "contains", weight: 1 }],
  };
  const qi: QueryIndex = {
    schemaVersion: 1,
    name_to_node_ids: { runDoctor: [targetId], helper: ["function:src/cli/doctor.ts:helper"] },
    path_to_node_ids: { "src/cli/doctor.ts": [fileId, targetId, "function:src/cli/doctor.ts:helper"] },
  };
  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root: cwd,
    proj_hash: "abc123def456",
    last_indexed_ts: "2026-05-27T10:00:00.000Z",
    build_duration_ms: 1234,
    counters: emptyCounters(),
  };
  await writeGraph(storageDir, graph);
  await writeQueryIndex(storageDir, qi);
  await writeMeta(storageDir, meta);
}

function mockBrain(markdown: string, costUsd = 0.003): BrainProvider {
  return async () => ({
    markdown,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 1000,
      output_tokens: 300,
      total_cost_usd: costUsd,
    },
  });
}

function makeCtx(overrides: Partial<ExplainCtx> = {}): ExplainCtx {
  return {
    cwd,
    graphStorageDir: storageDir,
    sourceProvider: async (path) => (path === "src/cli/doctor.ts" ? "export function runDoctor() {\n  return helper();\n}\n" : null),
    brainProvider: mockBrain("# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87]. Calls helper.\n"),
    now: () => new Date("2026-05-27T10:05:00.000Z"),
    ttyInteractive: false,
    ...overrides,
  };
}

describe("runExplain — cost cap", () => {
  test("cost > hard cap → explained AND persisted, flagged hardCapExceeded", async () => {
    await seedGraph();
    // Default hard cap is $0.10; 0.15 is over it.
    const outcome = await runExplain(
      { target: "runDoctor" },
      makeCtx({
        brainProvider: mockBrain(
          "# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87].\n",
          0.15,
        ),
      }),
    );
    if (outcome.kind !== "explained") throw new Error(`expected explained, got ${outcome.kind}`);
    expect(outcome.hardCapExceeded).toBe(true);
    expect(outcome.hardCapUsd).toBe(0.1);
    expect(outcome.usage.total_cost_usd).toBe(0.15);
    expect(existsSync(outcome.result.mdPath)).toBe(true);
    expect(outcome.result.meta.brain_usage.total_cost_usd).toBe(0.15);
  });

  test("cost ≤ hard cap → hardCapExceeded false", async () => {
    await seedGraph();
    const outcome = await runExplain(
      { target: "runDoctor" },
      makeCtx({
        brainProvider: mockBrain("# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87].\n", 0.1),
      }),
    );
    if (outcome.kind !== "explained") throw new Error(`expected explained, got ${outcome.kind}`);
    expect(outcome.hardCapExceeded).toBe(false);
  });

  test("an over-cap cached explanation keeps its flag on the cache hit", async () => {
    await seedGraph();
    const brain = mockBrain("# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87].\n", 0.15);
    await runExplain({ target: "runDoctor" }, makeCtx({ brainProvider: brain }));
    const again = await runExplain({ target: "runDoctor" }, makeCtx({ brainProvider: brain }));
    if (again.kind !== "explained") throw new Error(`expected explained, got ${again.kind}`);
    expect(again.result.fromCache).toBe(true);
    expect(again.hardCapExceeded).toBe(true);
  });
});
