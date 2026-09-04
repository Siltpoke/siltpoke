// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * End-to-end entrypoint-detection fixtures: tiny REAL repos under
 * tests/fixtures/entrypoints/, indexed with the real builder
 * (`runIndexBuild`) and asserted through the real `detectEntrypoints`.
 *
 * This is the honest-signal net for generic (non-siltpoke) repos: a
 * positive control (bin-cli must be found) plus three adversarial
 * negatives (a wrong root must NOT be emitted). Every other unit test in
 * this directory hand-builds graph/queryIndex fixtures directly — this
 * file is the one place that proves the full walk → parse → extract →
 * detect pipeline agrees on a stranger repo it never saw during design.
 */
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { readGraph, readQueryIndex } from "../../src/repo-graph/store";
import { detectEntrypoints, type Entrypoint } from "../../src/repo-graph/detect-entrypoints";

const FIX = join(import.meta.dir, "../fixtures/entrypoints");

/**
 * Index one fixture repo into an ISOLATED temp `home` (never the real
 * ~/.siltpoke) and run real entrypoint detection against it.
 *
 * The fixture is first COPIED into a fresh tmpdir project root rather than
 * built directly against tests/fixtures/entrypoints/<name>: that path sits
 * inside siltpoke's own working tree, and `resolveProjectRoot()`
 * (src/memory/project.ts) walks UP from cwd looking for `.git` — landing on
 * siltpoke's OWN `.git` and indexing the whole ~700-file repo instead of
 * the tiny fixture (same gotcha documented in
 * tests/eval/repo-graph-state/ci-runner.test.ts). A tmp copy has no
 * ancestor `.git`, so resolution falls back to treating the copy itself as
 * the project root.
 *
 * `subPath` lets a fixture point the index root at a nested directory
 * (monorepo-pkg → packages/web) while still copying the whole fixture tree.
 */
async function detectFixture(name: string, subPath?: string): Promise<Entrypoint[]> {
  const projectRoot = mkdtempSync(join(tmpdir(), `ep-fixture-${name}-`));
  const home = mkdtempSync(join(tmpdir(), "ep-home-"));
  try {
    cpSync(join(FIX, name), projectRoot, { recursive: true });
    const root = subPath ? join(projectRoot, subPath) : projectRoot;
    const { storage_dir } = await runIndexBuild({ cwd: root, home, force: true });
    const graph = await readGraph(storage_dir);
    const queryIndex = await readQueryIndex(storage_dir);
    return detectEntrypoints(graph, queryIndex, root);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe("entrypoint fixtures — positive control", () => {
  test(
    "bin-cli finds exactly the declared bin entry, certain confidence",
    async () => {
      const eps = await detectFixture("bin-cli");
      expect(eps).toHaveLength(1);
      expect(eps).toMatchObject([{ id: "ep:bin:mytool", source: "bin", confidence: "certain", fn: "main" }]);
    },
    // First test in the file pays the one-time cold tree-sitter wasm load
    // (probes several candidate paths before landing one — see ast-loader.ts);
    // subsequent tests reuse the already-initialized parser and run in ms.
    // Observed cold-load time ranges from ~2s to ~60s under system load on
    // this machine — generous headroom here, not a real perf budget.
    60000,
  );
});

describe("entrypoint fixtures — framework + tier-1 root generalization", () => {
  test("next-app infers two distinct ep:fw:* entries from app-router conventions", async () => {
    const eps = await detectFixture("next-app");
    const fw = eps.filter((e) => e.source === "framework");
    expect(fw).toHaveLength(2);
    const ids = fw.map((e) => e.id).sort();
    expect(ids).toEqual(["ep:fw:app-api-health-route", "ep:fw:app-page"]);
    for (const e of fw) expect(e.confidence).toBe("inferred");
  });

  test("express-svc roots the framework entry at startApp, not the external listen call", async () => {
    const eps = await detectFixture("express-svc");
    const fw = eps.filter((e) => e.source === "framework");
    expect(fw).toHaveLength(1);
    expect(fw[0]).toMatchObject({ id: "ep:fw:index", fn: "startApp" });
    expect(eps.some((e) => e.fn === "listen")).toBe(false);
  });
});

describe("entrypoint fixtures — adversarial negatives", () => {
  test("dist-only-no-src drops the unresolvable bin (NEG #1)", async () => {
    const eps = await detectFixture("dist-only-no-src");
    expect(eps.some((e) => e.source === "bin")).toBe(false);
  });

  test("lib-with-tempting-main returns no generic entries — the exported `main` is never reached (NEG #2)", async () => {
    const eps = await detectFixture("lib-with-tempting-main");
    expect(eps.filter((e) => e.source !== "preset")).toHaveLength(0);
    expect(eps.some((e) => e.fn === "main")).toBe(false);
  });

  test("opaque-scripts skips framework-CLI / chained scripts — no ep:script:* entries (NEG #3)", async () => {
    const eps = await detectFixture("opaque-scripts");
    expect(eps.some((e) => e.source === "script")).toBe(false);
  });
});

describe("entrypoint fixtures — monorepo package scoping", () => {
  test("monorepo-pkg resolves the bin against the nested package manifest, not the workspace root", async () => {
    const eps = await detectFixture("monorepo-pkg", "packages/web");
    const bin = eps.filter((e) => e.source === "bin");
    expect(bin).toHaveLength(1);
    expect(bin[0]).toMatchObject({ id: "ep:bin:mytool", confidence: "certain", fn: "main" });
  });
});
