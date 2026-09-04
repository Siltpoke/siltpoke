// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchModel, archModelPath, archMetaPath } from "../../src/explain/arch-cache";
import { anchoredRepoRoot, foreignRepoRoot, cleanupArchRepoRoots } from "../_shared/arch-repo-root";

afterAll(cleanupArchRepoRoots);

const readFileSyncStr = (path: string) => readFileSync(path, "utf8");

const claim = (v: string, file = "x.ts") => ({ value: v, evidence: [{ file, line: 1 }] });

describe("readArchModel reconciles reviewer externals", () => {
  let dir: string;
  let root: string;
  const fp = "fp1", ts = "2026-07-25T00:00:00Z";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "arch-read-"));
    root = anchoredRepoRoot();
    const model = {
      boundary: "siltpoke",
      bands: [{ id: "external", label: claim("External"), order: 0, members: [] }],
      nodes: [
        { id: "brain", kind: "cont", title: claim("Brain"), band: claim("llm"), members: ["src/brain/x.ts"] },
        { id: "agy-ext", kind: "ext", title: claim("Antigravity CLI"), band: claim("external"),
          desc: claim("hl", "src/brain/providers/agy.ts") },
        { id: "codex-ext", kind: "ext", title: claim("Codex CLI"), band: claim("external") },
      ],
      edges: [],
    };
    const meta = { schemaVersion: 1, fingerprint: fp, graphIndexedTs: ts, costUsd: 1, groundedPct: 60,
      model: "m", generatedTs: ts, citedClaims: 6, totalClaims: 10 };
    writeFileSync(archModelPath(dir), JSON.stringify(model));
    writeFileSync(archMetaPath(dir), JSON.stringify(meta));
  });

  it("a legacy cache missing codebuddy/qoder gains them on read (no regenerate)", async () => {
    const res = await readArchModel(dir, fp, ts, root);
    expect(res).not.toBeNull();
    const fams = res!.model.nodes.filter((n: any) => n.provenance === "registry-declared").map((n: any) => n.externalFamily).sort();
    expect(fams).toEqual(["codebuddy", "qoder"]);
  });

  it("adjusts meta counts so the UI parity assertion holds", async () => {
    const res = await readArchModel(dir, fp, ts, root);
    expect(res!.meta.totalClaims!).toBeGreaterThan(10);
    expect(res!.meta.citedClaims).toBe(6);
    expect(res!.meta.groundedPct).toBe(Math.round((6 / res!.meta.totalClaims!) * 100));
  });

  it("legacy cache WITHOUT counts: injects nodes but does NOT clobber the model's groundedPct with 0", async () => {
    // Rewrite meta with no citedClaims/totalClaims but a real groundedPct on the doc.
    const model: any = JSON.parse(readFileSyncStr(archModelPath(dir)));
    model.groundedPct = 72;
    writeFileSync(archModelPath(dir), JSON.stringify(model));
    const meta = { schemaVersion: 1, fingerprint: fp, graphIndexedTs: ts, costUsd: 1, groundedPct: 72, model: "m", generatedTs: ts };
    writeFileSync(archMetaPath(dir), JSON.stringify(meta));
    const res = await readArchModel(dir, fp, ts, root);
    // nodes still injected:
    expect(res!.model.nodes.some((n: any) => n.externalFamily === "qoder")).toBe(true);
    // but the model's existing groundedPct is preserved, NOT overwritten to 0 (prior counts absent):
    expect(res!.model.groundedPct).toBe(72);
    expect(res!.meta.citedClaims).toBeUndefined(); // graceful-absent, not fabricated
  });

  it("already-reconciled cache: read is idempotent — no duplicate nodes, no count inflation", async () => {
    // First read reconciles + we persist that back, then read again.
    const first = await readArchModel(dir, fp, ts, root);
    writeFileSync(archModelPath(dir), JSON.stringify(first!.model));
    writeFileSync(archMetaPath(dir), JSON.stringify(first!.meta));
    const second = await readArchModel(dir, fp, ts, root);
    expect(second!.model.nodes.length).toBe(first!.model.nodes.length); // no dup inject
    expect(second!.meta.totalClaims).toBe(first!.meta.totalClaims);      // no inflation
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Repo scope. The injection premise ("parameterized spawn hides these families
// from the LLM") is true of siltpoke and of nothing else, but the pass was
// unscoped: measured 2026-08-21, 3 of the 5 cached models on this machine — a
// travel app, a Supabase app, a GitHub/Redis app — each carried all four review
// CLIs, cited to `src/brain/registry.ts`, a file none of them contains.
// ═════════════════════════════════════════════════════════════════════════════

const foreignFp = "fpF", foreignTs = "2026-08-21T00:00:00Z";

/** A foreign repo's cached doc: real externals of its own, plus (optionally)
 * the four review CLIs a pre-scope generate persisted into it. */
function foreignModel(withPollution: boolean) {
  const ev = [{ file: "src/brain/registry.ts", line: 92 }];
  const polluted = ["codex", "agy", "qoder", "codebuddy"].map((family) => ({
    id: `${family}-ext`,
    kind: "ext",
    title: { value: `${family} CLI`, evidence: ev },
    band: { value: "external", evidence: ev },
    desc: { value: "External review CLI (registry-declared; reachability unverified)", evidence: ev },
    externalFamily: family,
    provenance: "registry-declared",
  }));
  return {
    boundary: "some-travel-app",
    bands: [{ id: "external", label: claim("External"), order: 0, members: [] }],
    nodes: [
      { id: "api", kind: "cont", title: claim("API"), band: claim("core"), members: ["src/api/x.ts"] },
      { id: "amadeus-api", kind: "ext", title: claim("Amadeus Travel API"), band: claim("external") },
      ...(withPollution ? polluted : []),
    ],
    edges: [],
  };
}

function seedForeign(withPollution: boolean, metaOver: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "arch-read-foreign-"));
  writeFileSync(archModelPath(dir), JSON.stringify(foreignModel(withPollution)));
  writeFileSync(archMetaPath(dir), JSON.stringify({
    schemaVersion: 1, fingerprint: foreignFp, graphIndexedTs: foreignTs, costUsd: 1,
    groundedPct: 60, model: "m", generatedTs: foreignTs, citedClaims: 6, totalClaims: 30,
    ...metaOver,
  }));
  return dir;
}

const registryDeclared = (res: any) =>
  res!.model.nodes.filter((n: any) => n.provenance === "registry-declared");

describe("readArchModel scopes reviewer externals to the analyzed repo", () => {
  it("a repo WITHOUT the registry anchor gets no injected review CLIs", async () => {
    const dir = seedForeign(false);
    const res = await readArchModel(dir, foreignFp, foreignTs, foreignRepoRoot());
    expect(registryDeclared(res)).toEqual([]);
    // its own external is untouched — the scope narrows injection, not the model.
    expect(res!.model.nodes.some((n: any) => n.id === "amadeus-api")).toBe(true);
  });

  it("an ALREADY-polluted foreign cache is pruned on read (no paid re-generate)", async () => {
    // Narrowing the scope alone would not help: injection persists into
    // arch-model.json, so a pre-scope model keeps rendering the four forever.
    const dir = seedForeign(true);
    const res = await readArchModel(dir, foreignFp, foreignTs, foreignRepoRoot());
    expect(registryDeclared(res)).toEqual([]);
    expect(res!.model.nodes.map((n: any) => n.id).sort()).toEqual(["amadeus-api", "api"]);
  });

  it("pruning gives the denominator back — counts drop by exactly what was dropped", async () => {
    const dir = seedForeign(true);
    const res = await readArchModel(dir, foreignFp, foreignTs, foreignRepoRoot());
    // 4 nodes × (title + band + desc) = 12 inferred claims, 0 edges to drop.
    expect(res!.meta.totalClaims).toBe(30 - 12);
    expect(res!.meta.citedClaims).toBe(6); // pruned claims were all inferred
    expect(res!.meta.groundedPct).toBe(Math.round((6 / 18) * 100));
  });

  it("a meta whose counts predate the pruned claims DROPS them rather than inventing a denominator", async () => {
    // 8 total / 6 cited, but the doc carries 12 claims' worth of pollution the
    // meta never counted. Clamping the subtraction at citedClaims yields
    // `6/6 = 100% grounded` on a model that is mostly inferred — a confident
    // number invented out of an incoherent one. The counts must go ABSENT.
    const dir = seedForeign(true, { totalClaims: 8, citedClaims: 6 });
    const res = await readArchModel(dir, foreignFp, foreignTs, foreignRepoRoot());
    expect(res!.meta.totalClaims).toBeUndefined();
    expect(res!.meta.citedClaims).toBeUndefined();
    expect(res!.meta.groundedPct).not.toBe(100);
    // the nodes are still cleaned — only the arithmetic about them is unrecoverable
    expect(registryDeclared(res)).toEqual([]);
  });

  it("an UNRESOLVED repo root is a no-op — nothing injected, and nothing DELETED", async () => {
    // "I could not work out which repo this is" is not "this repo does not have
    // these". A model whose project_root is missing from meta.json must come
    // back exactly as it was found, or siltpoke's own cache silently loses its
    // four correct review-CLI nodes with no staleness signal and no regenerate.
    const dir = seedForeign(true);
    const res = await readArchModel(dir, foreignFp, foreignTs, null);
    expect(registryDeclared(res).map((n: any) => n.externalFamily).sort())
      .toEqual(["agy", "codebuddy", "codex", "qoder"]);
    expect(res!.meta.totalClaims).toBe(30); // untouched
  });

  it("a repo root that no longer exists on disk reads as UNRESOLVED, not as foreign", async () => {
    const gone = join(tmpdir(), "arch-root-that-was-deleted-12345");
    const dir = seedForeign(true);
    const res = await readArchModel(dir, foreignFp, foreignTs, gone);
    expect(registryDeclared(res).length).toBe(4);
  });

  it("prune spares llm-callsite nodes — a repo that really does call codex keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arch-read-callsite-"));
    writeFileSync(archModelPath(dir), JSON.stringify({
      boundary: "other-agent-repo",
      bands: [{ id: "external", label: claim("External"), order: 0, members: [] }],
      nodes: [
        { id: "runner", kind: "cont", title: claim("Runner"), band: claim("core"), members: ["src/runner.ts"] },
        { id: "codex-ext", kind: "ext", title: claim("Codex CLI"), band: claim("external"),
          externalFamily: "codex", provenance: "llm-callsite" },
      ],
      edges: [],
    }));
    writeFileSync(archMetaPath(dir), JSON.stringify({
      schemaVersion: 1, fingerprint: foreignFp, graphIndexedTs: foreignTs, costUsd: 1,
      groundedPct: 60, model: "m", generatedTs: foreignTs, citedClaims: 6, totalClaims: 10,
    }));
    const res = await readArchModel(dir, foreignFp, foreignTs, foreignRepoRoot());
    expect(res!.model.nodes.some((n: any) => n.id === "codex-ext")).toBe(true);
    expect(res!.meta.totalClaims).toBe(10); // nothing dropped → denominator unchanged
  });

  it("prune is idempotent — a second read changes nothing", async () => {
    const dir = seedForeign(true);
    const first = await readArchModel(dir, foreignFp, foreignTs, foreignRepoRoot());
    writeFileSync(archModelPath(dir), JSON.stringify(first!.model));
    writeFileSync(archMetaPath(dir), JSON.stringify(first!.meta));
    const second = await readArchModel(dir, foreignFp, foreignTs, foreignRepoRoot());
    expect(second!.model.nodes.length).toBe(first!.model.nodes.length);
    expect(second!.meta.totalClaims).toBe(first!.meta.totalClaims);
  });

  it("a null repoRoot fails closed on INJECTION — unverifiable citations are never invented", async () => {
    const dir = seedForeign(false);
    const res = await readArchModel(dir, foreignFp, foreignTs, null);
    expect(registryDeclared(res)).toEqual([]);
  });
});
