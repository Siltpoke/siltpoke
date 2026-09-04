/**
 * explain.ts orchestrator tests.
 *
 * Brain is injected via BrainProvider so tests are deterministic.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runExplain,
  type BrainProvider,
  type ExplainCtx,
  type SourceProvider,
} from "../../src/explain/explain";
import {
  writeGraph,
  writeMeta,
  writeQueryIndex,
} from "../../src/repo-graph/store";
import {
  emptyCounters,
  type RepoGraph,
  type RepoGraphMeta,
  type QueryIndex,
} from "../../src/repo-graph/types";

let cwd: string;
let storageDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "siltpoke-explain-"));
  storageDir = join(cwd, "repo-memory", "abc123def456");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

async function seedGraph(): Promise<{
  graph: RepoGraph;
  qi: QueryIndex;
  meta: RepoGraphMeta;
}> {
  const targetId = "function:src/cli/doctor.ts:runDoctor";
  const fileId = "file:src/cli/doctor.ts:";
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [
      {
        id: fileId,
        type: "file",
        name: "doctor.ts",
        path: "src/cli/doctor.ts",
        lineRange: [1, 200],
      },
      {
        id: targetId,
        type: "function",
        name: "runDoctor",
        path: "src/cli/doctor.ts",
        lineRange: [42, 87],
      },
      {
        id: "function:src/cli/doctor.ts:helper",
        type: "function",
        name: "helper",
        path: "src/cli/doctor.ts",
        lineRange: [10, 15],
      },
    ],
    edges: [
      {
        id: `${fileId}::contains::${targetId}`,
        source: fileId,
        target: targetId,
        type: "contains",
        weight: 1,
      },
    ],
  };
  const qi: QueryIndex = {
    schemaVersion: 1,
    name_to_node_ids: {
      runDoctor: [targetId],
      helper: ["function:src/cli/doctor.ts:helper"],
    },
    path_to_node_ids: {
      "src/cli/doctor.ts": [fileId, targetId, "function:src/cli/doctor.ts:helper"],
    },
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
  return { graph, qi, meta };
}

const SOURCE_FOR_RUN_DOCTOR =
  "export function runDoctor() {\n  return helper();\n}\n";

function mockSourceProvider(map: Map<string, string>): SourceProvider {
  return async (path) => map.get(path) ?? null;
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
    sourceProvider: mockSourceProvider(
      new Map([["src/cli/doctor.ts", SOURCE_FOR_RUN_DOCTOR]]),
    ),
    brainProvider: mockBrain(
      "# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87]. Calls helper.\n",
    ),
    now: () => new Date("2026-05-27T10:05:00.000Z"),
    ttyInteractive: false,
    ...overrides,
  };
}

describe("runExplain — happy path", () => {
  test("resolves target, calls Brain, writes explanation, scores evidence", async () => {
    await seedGraph();
    const outcome = await runExplain({ target: "runDoctor" }, makeCtx());
    expect(outcome.kind).toBe("explained");
    if (outcome.kind !== "explained") return;
    expect(outcome.result.meta.target_node_id).toBe(
      "function:src/cli/doctor.ts:runDoctor",
    );
    expect(outcome.result.meta.graph_indexed_ts).toBe(
      "2026-05-27T10:00:00.000Z",
    );
    expect(outcome.result.meta.evidence_score).toBe(1);
    expect(outcome.lowConfidence).toBe(false);
  });

  test("appends depth-hint footer when depth=1", async () => {
    await seedGraph();
    const outcome = await runExplain(
      { target: "runDoctor", depth: 1 },
      makeCtx(),
    );
    if (outcome.kind !== "explained") throw new Error("expected explained");
    expect(outcome.result.markdown).toMatch(/--depth 2/);
  });

  test("no footer when depth=2", async () => {
    await seedGraph();
    const outcome = await runExplain(
      { target: "runDoctor", depth: 2 },
      makeCtx(),
    );
    if (outcome.kind !== "explained") throw new Error("expected explained");
    expect(outcome.result.markdown).not.toMatch(/--depth 2/);
  });
});

describe("runExplain — cache", () => {
  test("second call returns cached without invoking Brain", async () => {
    await seedGraph();
    let calls = 0;
    const ctx = makeCtx({
      brainProvider: async () => {
        calls++;
        return {
          markdown: "# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87].\n",
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 100,
            output_tokens: 50,
            total_cost_usd: 0.001,
          },
        };
      },
    });
    await runExplain({ target: "runDoctor" }, ctx);
    const second = await runExplain({ target: "runDoctor" }, ctx);
    expect(calls).toBe(1);
    if (second.kind !== "explained") throw new Error("expected explained");
    expect(second.result.fromCache).toBe(true);
  });

  test("--force bypasses cache and re-invokes Brain", async () => {
    await seedGraph();
    let calls = 0;
    const ctx = makeCtx({
      brainProvider: async () => {
        calls++;
        return {
          markdown: "# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87].\n",
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 100,
            output_tokens: 50,
            total_cost_usd: 0.001,
          },
        };
      },
    });
    await runExplain({ target: "runDoctor" }, ctx);
    await runExplain({ target: "runDoctor", force: true }, ctx);
    expect(calls).toBe(2);
  });
});

describe("runExplain — usage ledger (cost-honesty batch A)", () => {
  function ledgerLines(base: string): Array<Record<string, unknown>> {
    const p = join(base, "usage-events.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  test("ledgers one explain event on a Brain miss when ledgerBasePath set", async () => {
    await seedGraph();
    const outcome = await runExplain(
      { target: "runDoctor", force: true },
      makeCtx({ ledgerBasePath: cwd }),
    );
    expect(outcome.kind).toBe("explained");
    const lines = ledgerLines(cwd);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      kind: "explain",
      basis: "real",
      total_cost_usd: 0.003,
      session_id: expect.any(String),
    });
  });

  test("uses ledgerSessionId when provided", async () => {
    await seedGraph();
    await runExplain(
      { target: "runDoctor", force: true },
      makeCtx({ ledgerBasePath: cwd, ledgerSessionId: "task-xyz" }),
    );
    expect(ledgerLines(cwd)[0].session_id).toBe("task-xyz");
  });

  test("does NOT ledger on a cache hit (no double-bill)", async () => {
    await seedGraph();
    const ctx = makeCtx({ ledgerBasePath: cwd });
    await runExplain({ target: "runDoctor", force: true }, ctx); // miss → 1
    expect(ledgerLines(cwd).length).toBe(1);
    const second = await runExplain({ target: "runDoctor" }, ctx); // hit
    if (second.kind !== "explained") throw new Error("expected explained");
    expect(second.result.fromCache).toBe(true);
    expect(ledgerLines(cwd).length).toBe(1); // unchanged
  });

  test("does NOT ledger when ledgerBasePath absent (back-compat)", async () => {
    await seedGraph();
    await runExplain({ target: "runDoctor", force: true }, makeCtx());
    expect(ledgerLines(cwd).length).toBe(0);
  });
});

describe("runExplain — pre-check + resolve failures", () => {
  test("missing graph storage dir → pre_check_failed", async () => {
    // intentionally do NOT seedGraph
    const outcome = await runExplain({ target: "runDoctor" }, makeCtx());
    expect(outcome.kind).toBe("pre_check_failed");
    if (outcome.kind !== "pre_check_failed") return;
    expect(outcome.message).toMatch(/Code Map/i);
  });

  test("ambiguous bare symbol → ambiguous outcome with candidates", async () => {
    await seedGraph();
    // add another `runDoctor` in a different file via direct seed override
    const targetId2 = "function:src/cli/other.ts:runDoctor";
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        {
          id: "function:src/cli/doctor.ts:runDoctor",
          type: "function",
          name: "runDoctor",
          path: "src/cli/doctor.ts",
          lineRange: [42, 87],
        },
        {
          id: targetId2,
          type: "function",
          name: "runDoctor",
          path: "src/cli/other.ts",
          lineRange: [10, 20],
        },
      ],
      edges: [],
    };
    const qi: QueryIndex = {
      schemaVersion: 1,
      name_to_node_ids: {
        runDoctor: [
          "function:src/cli/doctor.ts:runDoctor",
          targetId2,
        ],
      },
      path_to_node_ids: {},
    };
    await writeGraph(storageDir, graph);
    await writeQueryIndex(storageDir, qi);
    const outcome = await runExplain({ target: "runDoctor" }, makeCtx());
    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.candidates).toHaveLength(2);
  });

  test("target not found → not_found with suggestions", async () => {
    await seedGraph();
    const outcome = await runExplain({ target: "runDocter" }, makeCtx());
    expect(outcome.kind).toBe("not_found");
    if (outcome.kind !== "not_found") return;
    expect(outcome.suggestions).toContain("runDoctor");
  });
});

describe("runExplain — cost cap", () => {
  test("cost > hard cap → cost_cap_exceeded, no file written", async () => {
    await seedGraph();
    // Default hard cap is $0.10 (post-F29 raise); use 0.15 to trigger abort.
    const outcome = await runExplain(
      { target: "runDoctor" },
      makeCtx({
        brainProvider: mockBrain(
          "# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87].\n",
          0.15,
        ),
      }),
    );
    expect(outcome.kind).toBe("cost_cap_exceeded");
    if (outcome.kind !== "cost_cap_exceeded") return;
    expect(outcome.costUsd).toBe(0.15);
  });
});

describe("runExplain — low confidence", () => {
  test("evidence < 0.9 → explained with lowConfidence=true", async () => {
    await seedGraph();
    const ctx = makeCtx({
      brainProvider: mockBrain(
        "# x\n\nrefs [src/cli/doctor.ts:42] [src/fake.ts:1] [src/imaginary.ts:2]\n",
      ),
    });
    const outcome = await runExplain({ target: "runDoctor" }, ctx);
    if (outcome.kind !== "explained") throw new Error("expected explained");
    expect(outcome.lowConfidence).toBe(true);
    expect(outcome.result.meta.low_confidence).toBe(true);
    expect(outcome.result.meta.evidence_score).toBeLessThan(0.9);
  });
});
