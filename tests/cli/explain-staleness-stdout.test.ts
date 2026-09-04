// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Drives the REAL `runExplain` orchestrator → `formatHuman`/`formatExplained`
 * (what `runCli` writes to stdout) on a REAL repo-graph index (built via
 * `runIndexBuild`, same harness as `tests/cli/doctor-index-staleness.test.ts`).
 *
 * The dead-guard this suite exists to catch (R9): the explain flow has TWO
 * "explained" return paths — cache-hit and cache-miss. Attaching the staleness
 * verdict only on the miss path would make every cached explanation silently
 * drop the warning. The "cache HIT" test below fails if that regresses.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { formatHuman } from "../../src/cli/explain";
import type { BrainProvider, ExplainCtx, SourceProvider } from "../../src/explain/explain";
import { runExplain } from "../../src/explain/explain";
import * as indexHealth from "../../src/repo-graph/index-health";
import { resolveRepoGraphLocation } from "../../src/repo-graph/proj-hash";
import { runIndexBuild } from "../../src/repo-graph/builder";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function mockBrain(markdown = "# a\n\nExplanation body.\n"): BrainProvider {
  return async () => ({
    markdown,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 100,
      output_tokens: 50,
      total_cost_usd: 0.001,
    },
  });
}

function realSourceProvider(root: string): SourceProvider {
  return async (relPath) => {
    try {
      return await Bun.file(join(root, relPath)).text();
    } catch {
      return null;
    }
  };
}

/** Builds a real repo-graph index under its own temp `home`, writing `n`
 * numbered `.ts` files under `src/`. Returns everything a `runExplain` ctx
 * needs to point at that real index. */
async function buildIndexedRepo(fileCount: number): Promise<{
  home: string;
  repo: string;
  storageDir: string;
}> {
  const home = mkdtempSync(join(tmpdir(), "sp-home-"));
  const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
  dirs.push(home, repo);
  mkdirSync(join(repo, "src"));
  const names = ["a", "b", "c", "d", "e"].slice(0, fileCount);
  for (const n of names) {
    writeFileSync(join(repo, "src", `${n}.ts`), `export const ${n} = 1;\n`);
  }
  await runIndexBuild({ cwd: repo, force: true, home });
  const { storage_dir } = resolveRepoGraphLocation(repo, { home });
  return { home, repo, storageDir: storage_dir };
}

function ctxFor(repo: string, storageDir: string, home: string): ExplainCtx {
  return {
    cwd: repo,
    graphStorageDir: storageDir,
    sourceProvider: realSourceProvider(repo),
    brainProvider: mockBrain(),
    home,
  };
}

describe("explain CLI surfaces staleness in stdout (R9 dead-guard)", () => {
  test("miss path: stale repo (1/5 edited) → stdout contains the staleness warning", async () => {
    const { home, repo, storageDir } = await buildIndexedRepo(5);
    // Edit one of the five indexed files AFTER indexing → 1/5 = 20% wrong,
    // which meets the default staleness_warn_pct (0.2) → level "stale".
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 999;\n");

    const outcome = await runExplain(
      { target: "src/a.ts" },
      ctxFor(repo, storageDir, home),
    );
    expect(outcome.kind).toBe("explained");
    if (outcome.kind !== "explained") return;
    expect(outcome.result.fromCache).toBe(false);
    expect(outcome.staleness.level).not.toBe("fresh");

    const stdout = formatHuman(outcome);
    expect(stdout).toContain("out of date");
  });

  test("cache HIT path still carries the warning (the dead-guard test)", async () => {
    const { home, repo, storageDir } = await buildIndexedRepo(5);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 999;\n");

    const ctx = ctxFor(repo, storageDir, home);
    const first = await runExplain({ target: "src/a.ts" }, ctx);
    expect(first.kind).toBe("explained");
    if (first.kind !== "explained") return;
    expect(first.result.fromCache).toBe(false);

    // Second call, same target + no --force → served from cache.
    const second = await runExplain({ target: "src/a.ts" }, ctx);
    expect(second.kind).toBe("explained");
    if (second.kind !== "explained") return;
    expect(second.result.fromCache).toBe(true);
    expect(second.staleness.level).not.toBe("fresh");

    const stdout = formatHuman(second);
    expect(stdout).toContain("out of date");
  });

  test("fresh repo → stdout has NO staleness line (this surface's own negative)", async () => {
    const { home, repo, storageDir } = await buildIndexedRepo(3);
    // No edits after indexing — index reads as fresh.

    const outcome = await runExplain(
      { target: "src/a.ts" },
      ctxFor(repo, storageDir, home),
    );
    expect(outcome.kind).toBe("explained");
    if (outcome.kind !== "explained") return;
    expect(outcome.staleness.level).toBe("fresh");

    const stdout = formatHuman(outcome);
    expect(stdout).not.toContain("out of date");
    expect(stdout).not.toContain("drifted");
  });

  test("readIndexStaleness invoked at most once per runExplain call (R14 memoization)", async () => {
    const { home, repo, storageDir } = await buildIndexedRepo(5);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 999;\n");

    // Capture the REAL function before mocking — the mock factory below wraps
    // this exact reference, so the real staleness computation still runs.
    const realReadIndexStaleness = indexHealth.readIndexStaleness;
    let calls = 0;
    mock.module("../../src/repo-graph/index-health", () => ({
      computeStaleness: indexHealth.computeStaleness,
      readIndexStaleness: async (
        ...args: Parameters<typeof realReadIndexStaleness>
      ) => {
        calls++;
        return realReadIndexStaleness(...args);
      },
    }));
    try {
      const outcome = await runExplain(
        { target: "src/a.ts" },
        ctxFor(repo, storageDir, home),
      );
      expect(outcome.kind).toBe("explained");
      expect(calls).toBe(1);
    } finally {
      // Restore the real module so later tests/files aren't affected — Bun's
      // mock.module patches the shared module registry in place.
      mock.module("../../src/repo-graph/index-health", () => ({
        computeStaleness: indexHealth.computeStaleness,
        readIndexStaleness: realReadIndexStaleness,
      }));
    }
  });
});
