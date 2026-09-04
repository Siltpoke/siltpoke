/**
 * Acceptance test — output guard (arch-generate truncation advisory).
 *
 * Exercises the OBSERVABLE contract from outside, the way the running
 * daemon / dashboard would:
 *
 *   Pre-flight estimate — the SAME server-side derivation the `/arch/estimate`
 *        route runs (`estimateArchGenerate(ctx)` over a REAL on-disk graph
 *        storage dir → `archGenerateMayTruncate(est.estimate)`). The estimate
 *        is read off a graph written to disk, so the sharder runs for real.
 *        ANTI-VACUOUS: the budget-busting case first asserts the door opened —
 *        `truncatedSubdirCount > 0` proves real sharding happened — BEFORE
 *        asserting the warning fires. The fits-comfortably case proves the
 *        sharder did NOT trip (door closed) → no false-positive nag.
 *
 *   Non-blocking advisory — the advisory is NON-BLOCKING. Driven two ways:
 *        (a) DOM: mount the real island, fire the cache-present modal path with a
 *            `mayTruncate:true` estimate → the warning line shows in the modal AND
 *            confirming still fires the paid /arch/generate (the predicate's value
 *            does NOT gate the fire).
 *        (b) Static: the no-cache fire path never references `mayTruncate` at all,
 *            and the confirm gate is `confirmed` (user click), never the flag.
 *
 *   Terminal error label — errorMsg present on a terminal task → the rendered
 *        genLabel IS the real reason (errorMsg text), NOT the generic
 *        archTerminalLabel.
 *
 *   Success label — a successful generate → generic affordance label, no
 *        errorMsg text, no after-the-fact truncation warning (no regression).
 *
 * Contract (implementers):
 *   Pre-flight estimate / non-blocking advisory: /arch/estimate envelope carries
 *          `mayTruncate`; pure `archGenerateMayTruncate(est) = est.truncatedSubdirCount > 0`;
 *          advisory surfaced in island trigger paths, NEITHER path gates fire/confirm on it.
 *   Terminal error label / success label: island `pollArchTaskTerminal` →
 *          {status, errorMsg}; observeArchRun replaces the generic label with the
 *          real errorMsg when present; success → generic label unchanged.
 *
 * NOTE on file layout: the pre-flight-estimate tests (pure/server, Bun-native
 * fetch) and the terminal-label / DOM-driven-advisory tests (DOM via happy-dom
 * GlobalRegistrator) cannot share one process cleanly — registering the
 * DOM swaps globalThis.fetch (oven-sh/bun#8774). They are split into two sibling
 * acceptance files; this file owns the pre-flight-estimate tests + the
 * static-lens advisory check; the DOM-bound advisory/terminal-label tests
 * live in output-guard-ui.acceptance.test.ts (per-file DOM lifecycle).
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARCH_OUTPUT_CAP_TOKENS,
  archGenerateMayTruncate,
  type ArchGenerateCtx,
  estimateArchGenerate,
} from "../../src/explain/arch-generate";
import type { RepoGraph, RepoGraphMeta, SiltpokeGraphNode } from "../../src/repo-graph/types";

// ── Real on-disk graph fixtures (pre-flight estimate) ────────────────────────
// estimateArchGenerate reads graph.json + meta.json off graphStorageDir, then
// runs the SAME assembler/sharder the route uses. No hand-set token count: the
// truncation flag is whatever the real sharder produces for this graph.

function fileNode(path: string): SiltpokeGraphNode {
  return {
    id: `file:${path}:`,
    type: "file",
    name: path.split("/").pop() ?? path,
    path,
    lineRange: [1, 80],
  };
}
function fnNode(path: string, name: string, signature: string): SiltpokeGraphNode {
  return { id: `function:${path}:${name}`, type: "function", name, path, lineRange: [12, 40], signature };
}
function meta(root: string): RepoGraphMeta {
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
      edges: { imports: 0, calls: 0, contains: 0 },
    },
  };
}
// A verbose signature to drive byte pressure into the 200K window.
const LONG_SIG = `export function PAD(${"aVeryLongParameterName: SomeExtremelyLongGenericTypeName<WithTypeArguments, AndEvenMoreOfThem>, ".repeat(2)}): Promise<AnEquallyVerboseReturnTypeForPadding>`;

/** Budget-busting repo (claude-code shape) → forces the sharder to compress. */
function hugeGraph(): RepoGraph {
  const nodes: SiltpokeGraphNode[] = [];
  for (let f = 0; f < 10; f++) {
    const path = `src/huge/file${String(f).padStart(2, "0")}.ts`;
    nodes.push(fileNode(path));
    for (let i = 0; i < 400; i++) nodes.push(fnNode(path, `huge_${f}_${i}`, LONG_SIG));
  }
  for (let d = 0; d < 12; d++) {
    const path = `src/small${String(d).padStart(2, "0")}/mod.ts`;
    nodes.push(fileNode(path));
    for (let i = 0; i < 30; i++) nodes.push(fnNode(path, `s${d}_${i}`, LONG_SIG));
  }
  return { schemaVersion: 1, nodes, edges: [] };
}

/** Tiny repo whose whole context fits the window → no sharding. */
function tinyGraph(): RepoGraph {
  return {
    schemaVersion: 1,
    nodes: [fileNode("src/a/mod.ts"), fnNode("src/a/mod.ts", "foo", "export function foo(): void")],
    edges: [],
  };
}

/** Write a graph to a throwaway storage dir the way `/siltpoke-index` would. */
async function storageDirFor(graph: RepoGraph, slug: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `output-guard-${slug}-`));
  await writeFile(join(dir, "graph.json"), JSON.stringify(graph));
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta(dir)));
  return dir;
}

/** estimate ctx mirroring the route's: no brain (asserts it's never called), no
 *  source, no overlay. This is the exact shape repo-graph.tsx:455 builds. */
function estimateCtx(dir: string): ArchGenerateCtx {
  return {
    graphStorageDir: dir,
    brainProvider: async () => {
      throw new Error("estimate must not call brain");
    },
    sourceProvider: async () => null,
    loadOverlay: async () => null,
  };
}

/** The route's exact server-side derivation (repo-graph.tsx:455 + :469):
 *  estimate the real graph, then derive the advisory flag from it. */
async function routeMayTruncate(
  dir: string,
): Promise<{ mayTruncate: boolean; truncatedSubdirCount: number }> {
  const est = await estimateArchGenerate(estimateCtx(dir));
  if (!est.ok) throw new Error(`estimate failed: ${est.message}`);
  return {
    mayTruncate: archGenerateMayTruncate(est.estimate),
    truncatedSubdirCount: est.estimate.truncatedSubdirCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight estimate flags truncation on a budget-capped repo, off the
// REAL on-disk read the route does (non-vacuous: door opened first).
// ─────────────────────────────────────────────────────────────────────────────
describe("pre-flight truncation flag (real on-disk estimate, route derivation)", () => {
  test("budget-busting repo → sharding ACTUALLY happens (door open) → mayTruncate TRUE", async () => {
    const dir = await storageDirFor(hugeGraph(), "huge");
    const { mayTruncate, truncatedSubdirCount } = await routeMayTruncate(dir);

    // DOOR-OPENED PROOF: the real sharder had to compress ≥1 subdir to fit the
    // window. Without this, asserting the flag would be vacuous (a flag on a
    // hand-set number). This is the size-sensitive signal, measured off disk.
    expect(truncatedSubdirCount).toBeGreaterThan(0);
    // The advisory the route puts in the /arch/estimate envelope.
    expect(mayTruncate).toBe(true);
  });

  test("repo that fits comfortably → NO sharding (door closed) → mayTruncate FALSE", async () => {
    const dir = await storageDirFor(tinyGraph(), "tiny");
    const { mayTruncate, truncatedSubdirCount } = await routeMayTruncate(dir);

    // Door closed: the sharder never tripped → no false-positive nag (a
    // conservative stance: accept false negatives over crying wolf).
    expect(truncatedSubdirCount).toBe(0);
    expect(mayTruncate).toBe(false);
  });

  test("flag derivation is the pure predicate, anchored on the existing cap constant", () => {
    // Contingency 3 (single source of truth): no second magic threshold — the
    // predicate is truncatedSubdirCount>0; the cap constant is the documented
    // anchor for WHY budget pressure means cap-pegging.
    expect(ARCH_OUTPUT_CAP_TOKENS).toBe(32_000);
    expect(archGenerateMayTruncate({ truncatedSubdirCount: 0 })).toBe(false);
    expect(archGenerateMayTruncate({ truncatedSubdirCount: 1 })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The advisory is NON-BLOCKING (static lens: the trigger code never gates fire
// on mayTruncate). The DOM-driven proof (fire still happens with the flag
// on) lives in output-guard-ui.acceptance.test.ts; here we verify the SHAPE
// of the trigger paths so a future refactor that adds a gate is caught.
// ─────────────────────────────────────────────────────────────────────────────
describe("advisory never gates the generate-fire path (trigger-code shape)", () => {
  const ISLAND = join(import.meta.dir, "../../src/web/client/islands/repo-graph.ts");

  test("the no-cache direct-fire path fires WITHOUT ever reading mayTruncate", async () => {
    const src = await readFile(ISLAND, "utf8");
    // The no-cache arm: `if (!hasGeneratedNow) { void runArchGenerate(); return; }`
    const arm = src.match(/if \(!hasGeneratedNow\) \{[\s\S]*?return;\s*\}/);
    expect(arm, "no-cache direct-fire arm must exist").not.toBeNull();
    // It must fire generate and must NOT branch on the truncation flag.
    expect(arm?.[0]).toContain("runArchGenerate()");
    expect(arm?.[0] ?? "").not.toContain("mayTruncate");
  });

  test("the cache-present confirm gate is `confirmed` (user click), never mayTruncate", async () => {
    const src = await readFile(ISLAND, "utf8");
    // The only fire after the modal is guarded by the user's confirm, not the flag.
    expect(src).toMatch(/if \(confirmed\) \{\s*void runArchGenerate\(\);/);
    // Guard against a future regression that makes the confirm conditional on the
    // flag: there is no `if (mayTruncate) return` / `!mayTruncate` short-circuit
    // anywhere on the fire path.
    expect(src).not.toMatch(/if \(mayTruncate\)[^{]*\breturn\b/);
    expect(src).not.toMatch(/!mayTruncate[^)]*\)\s*return/);
    // mayTruncate is only ever consumed as advisory copy (appended to body lines /
    // the cost string) — assert its uses are the advisory surface, not control flow.
    // (Both call sites append ARCH_TRUNCATION_WARNING; neither alters confirmLabel.)
    expect(src).toContain("ARCH_TRUNCATION_WARNING");
  });
});
