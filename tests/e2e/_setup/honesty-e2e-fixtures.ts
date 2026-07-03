/**
 * honesty-e2e-fixtures — shared seed/cleanup helpers for the honesty &
 * observability smoke (honesty-smoke.spec.ts) and its
 * screenshot companion (honesty-screenshots.spec.ts).
 *
 * Everything here writes into the SAME e2e SILTPOKE_HOME the playwright
 * webServer daemon reads per-request (`./.playwright-tmp/siltpoke`), so specs
 * can seed state at test time without restarting the daemon. Every seeder
 * returns / pairs with a restore so the shared home is left exactly as found
 * (verification-repo cleanup discipline — orphaned fixtures pollute the
 * repo dropdown and later runs).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  writeFingerprints,
  writeGraph,
  writeMeta,
  writeQueryIndex,
} from "../../../src/repo-graph/store";
import {
  emptyCounters,
  emptyFingerprints,
  emptyQueryIndex,
  type RepoGraph,
  type RepoGraphMeta,
  type SiltpokeGraphEdge,
  type SiltpokeGraphNode,
} from "../../../src/repo-graph/types";
import type { BrainHealth } from "../../../src/state/brain-health";

/** Same home the playwright.config webServer passes as SILTPOKE_HOME. */
export const E2E_HOME = join(process.cwd(), ".playwright-tmp", "siltpoke");

// ── generic swap-in / restore ────────────────────────────────────────────────

export type RestoreFn = () => Promise<void>;

/**
 * Write `content` at `path`, remembering whatever was there before.
 * The returned restore puts the original back (or deletes the file if it
 * did not exist). Safe to call the restore twice.
 */
export async function swapInFile(path: string, content: string): Promise<RestoreFn> {
  const hadOriginal = existsSync(path);
  const original = hadOriginal ? await readFile(path, "utf8") : null;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
  return async () => {
    if (original !== null) await writeFile(path, original, "utf8");
    else await rm(path, { force: true });
  };
}

// ── brain-health.json (health strip) ─────────────────────────────────────────

export const BRAIN_HEALTH_PATH = join(E2E_HOME, "brain-health.json");

/** The marker the strip must surface (also asserted in screenshots). */
export const UNHEALTHY_REASON = "MOCK-E2E: model overloaded - resource crunch";

/**
 * Seed an unhealthy record: consecutive_failures = 2 (the surfacing
 * threshold for non-permanent classes) with a fresh timestamp so the 24h
 * age-out never hides it. Returns a restore.
 */
export async function seedUnhealthyBrainHealth(): Promise<RestoreFn> {
  const now = new Date();
  const ts = now.toISOString();
  const health: BrainHealth = {
    schema_version: 1,
    last_attempt_ts: ts,
    last_success_ts: null,
    consecutive_failures: 2,
    last_failure: {
      class: "resource",
      exit_code: 1,
      stderr_excerpt: UNHEALTHY_REASON,
      ts,
      attempts: 1,
    },
    breaker: {
      class: "resource",
      opened_at: ts,
      next_eligible_at: new Date(now.getTime() + 60 * 60_000).toISOString(),
    },
    retry_budget: { date: ts.slice(0, 10), outer_retries_used: 0 },
  };
  return swapInFile(BRAIN_HEALTH_PATH, `${JSON.stringify(health, null, 2)}\n`);
}

/** Healthy precondition: no brain-health.json at all (fresh-install state). */
export async function removeBrainHealth(): Promise<void> {
  await rm(BRAIN_HEALTH_PATH, { force: true });
}

// ── brain-calls.jsonl (history rows) ─────────────────────────────────────────

export const BRAIN_CALLS_PATH = join(E2E_HOME, "brain-calls.jsonl");

/** Control row text that MUST render (anti-vacuous presence pair). */
export const VISIBLE_BUBBLE = "E2E-VISIBLE-BUBBLE";
/** Markers carried only by the suppressed rows — must NOT render. */
export const LEGACY_EMPTY_MARKER = "E2E-LEGACY-EMPTY-MARKER";
export const LEGACY_MISSING_MARKER = "E2E-LEGACY-MISSING-MARKER";

function brainCallRow(sessionId: string, brainOutput: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    cwd: "/tmp/e2e-history",
    duration_ms: 1000,
    brain_output: {
      mood: "happy",
      pose: "base",
      bubble_long: "",
      critique_for_claude: "",
      severity: "low",
      confidence: "high",
      ...brainOutput,
    },
    usage: { input_tokens: 1, output_tokens: 1, total_cost_usd: 0.001 },
    gating_decision: "high",
  });
}

/**
 * Seed three fired rows straight into the persisted log (the seam the
 * dashboard reads): one visible control, one empty-string bubble_short, one
 * with the field entirely missing — the two legacy shapes the dashboard filters out.
 */
export async function seedLegacyBrainCalls(): Promise<RestoreFn> {
  const lines = [
    brainCallRow("sess-e2e-legacy-empty", {
      bubble_short: "",
      bubble_long: LEGACY_EMPTY_MARKER,
    }),
    brainCallRow("sess-e2e-legacy-missing", {
      // bubble_short field entirely absent
      bubble_long: LEGACY_MISSING_MARKER,
    }),
    brainCallRow("sess-e2e-visible", { bubble_short: VISIBLE_BUBBLE }),
  ];
  return swapInFile(BRAIN_CALLS_PATH, `${lines.join("\n")}\n`);
}

// ── big repo-graph fixture (≈$ estimate > $1) ────────────────────────────────

/** Own proj_hash — never collides with the globalSetup fixture (a11ce0000001). */
export const BIG_FIXTURE_HASH = "b16e57000002";

const BIG_SUBDIRS = ["alpha", "beta", "gamma", "delta"] as const;
const FILES_PER_SUBDIR = 25;
const FNS_PER_FILE = 25;

/**
 * Build a graph big enough that the signatures-only arch context blows past
 * the >$1 estimate threshold: 4 subdirs × 25 files × 25 functions = 2,500
 * symbol lines at ~300 rendered chars each (~750K chars ≈ 260K est tokens,
 * water-filled down to the 160K context budget). At the cacheWrite1h-based
 * formula that pins estUsd ≈ $1.5 — comfortably > $1, fully deterministic,
 * zero Brain calls.
 */
function buildBigGraph(): RepoGraph {
  const nodes: SiltpokeGraphNode[] = [];
  const edges: SiltpokeGraphEdge[] = [];
  const sigTail =
    "opts: { retries: number; timeoutMs: number; traceId: string; onProgress: (pct: number) => void; " +
    "headers: Record<string, string>; abortSignal: AbortSignal | undefined }";
  for (const sub of BIG_SUBDIRS) {
    for (let f = 0; f < FILES_PER_SUBDIR; f++) {
      const path = `src/${sub}/${sub}-mod-${f}.ts`;
      nodes.push({
        id: `file:${path}:`,
        type: "file",
        name: `${sub}-mod-${f}.ts`,
        path,
        lineRange: [1, 400],
      });
      for (let i = 0; i < FNS_PER_FILE; i++) {
        const name = `handle${sub.charAt(0).toUpperCase()}${sub.slice(1)}Case${f}x${i}`;
        nodes.push({
          id: `function:${path}:${name}`,
          type: "function",
          name,
          path,
          lineRange: [i * 15 + 2, i * 15 + 14],
          signature: `(request: ${sub}Request${f}x${i}, ${sigTail}) => Promise<${sub}Result${f}x${i}>`,
          doc: `Resolves the ${sub} pipeline stage ${f}.${i} against the shared registry with bounded retries.`,
        });
      }
    }
  }
  // A few cross-subdir imports so the aggregated edge summary is non-empty.
  edges.push(
    { id: "e1", source: "file:src/alpha/alpha-mod-0.ts:", target: "../beta/beta-mod-0", type: "imports", weight: 1 },
    { id: "e2", source: "file:src/beta/beta-mod-0.ts:", target: "../gamma/gamma-mod-0", type: "imports", weight: 1 },
    { id: "e3", source: "file:src/gamma/gamma-mod-0.ts:", target: "../delta/delta-mod-0", type: "imports", weight: 1 },
  );
  return { schemaVersion: 1, nodes, edges };
}

/**
 * Seed the big fixture under its own proj_hash in the (per-request-read)
 * repo-memory store. `home` defaults to the e2e home; overridable so the
 * one-off sanity script can target a tmp dir.
 */
export async function seedBigEstimateFixture(
  opts: { home?: string } = {},
): Promise<{ storageDir: string; projectRoot: string }> {
  const home = opts.home ?? E2E_HOME;
  const storageDir = join(home, "repo-memory", BIG_FIXTURE_HASH);
  // No CLAUDE.md in the project root → degraded (subset) arch → the Generate
  // affordance + pre-flight ≈$ estimate render (authored repos hide it).
  const projectRoot = join(home, "..", "fixture-repo-big");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(storageDir, { recursive: true });

  const graph = buildBigGraph();
  const counters = emptyCounters();
  counters.nodes.file = BIG_SUBDIRS.length * FILES_PER_SUBDIR;
  counters.nodes.function = BIG_SUBDIRS.length * FILES_PER_SUBDIR * FNS_PER_FILE;
  counters.edges.imports = graph.edges.length;

  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root: projectRoot,
    proj_hash: BIG_FIXTURE_HASH,
    last_indexed_ts: new Date().toISOString(),
    build_duration_ms: 50,
    counters,
    building: false,
  };

  await writeGraph(storageDir, graph);
  await writeMeta(storageDir, meta);
  await writeQueryIndex(storageDir, emptyQueryIndex());
  await writeFingerprints(storageDir, emptyFingerprints());
  return { storageDir, projectRoot };
}

/** Remove the big fixture entirely (graph store + fake project root). */
export async function cleanupBigEstimateFixture(opts: { home?: string } = {}): Promise<void> {
  const home = opts.home ?? E2E_HOME;
  await rm(join(home, "repo-memory", BIG_FIXTURE_HASH), { recursive: true, force: true });
  await rm(join(home, "..", "fixture-repo-big"), { recursive: true, force: true });
}
