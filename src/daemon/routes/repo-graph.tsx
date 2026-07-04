// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * `/repo-graph` daemon routes.
 *
 * Read-only structural JSON endpoints consumed by the cytoscape.js dashboard
 * island. Every shape matches `IMPLEMENTATION-data-contract.md` exactly so the
 * client (ported from the prototype) wires up without translation.
 *
 *   GET /api/repo-graph/repos                          RepoSummary[]
 *   GET /api/repo-graph/arch?repo=<id>                 ArchitectureProjection
 *   GET /api/repo-graph/files?repo=<id>&subdir=<s>     FileLevel
 *   GET /api/repo-graph/symbols?repo=<id>&subdir&file  SymbolLevel
 *   GET /api/repo-graph/search?repo=<id>&q=<query>     SearchHit[]
 *   GET /api/repo-graph/cache-state?target=<t>         (legacy; →/explain)
 *   GET /api/repo-graph/cascade?subdir=<s>             (legacy; →/explain)
 *
 * `repo` is a proj_hash; omitted ⇒ the repo for the daemon's cwd. All routes
 * resolve the active repo's storage dir + project_root, then read its
 * persisted structural index.
 *
 * Auth posture (P0 fix 2026-05-29): these are **unauthenticated** read-only
 * GETs returning purely structural data (file lists, symbol names/signatures,
 * import counts). The daemon binds 127.0.0.1 only; any local process reaching
 * these could already read the source on disk. The shared secret stays
 * required on genuinely sensitive routes (explain POST / facts / hooks).
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  cascadeStaleSubdir,
  deriveCacheState,
} from "../../explain/cache-lifecycle";
import {
  runExplain,
  type BrainProvider,
  type ExplainOutcome,
  type SourceProvider,
} from "../../explain/explain";
import { isPreSpawnError, makeArchBrainProvider, makeDefaultBrainProvider, makeDefaultSourceProvider } from "../../explain/providers";
import { ARCH_DEFAULT_MODEL, archCostFromUsage, archGenerateMayTruncate, estimateArchGenerate, runArchGenerate } from "../../explain/arch-generate";
import { parseUsageFromTail } from "../../explain/usage-tail";
import { computeFileFunctions, computeRepoFingerprint, readArchModel } from "../../explain/arch-cache";
import { cacheKey, readExplanation } from "../../explain/store";
import type { ExplainResult } from "../../explain/types";
import { parseArchitectureSection } from "../../repo-graph/architecture-parser";
import { parseFirstDocComment } from "../../repo-graph/doc-comment-parser";
import {
  type ArchitectureProjection,
  bucketIdOfPath,
  projectArchitecture,
} from "../../repo-graph/project-architecture";
import { resolveRepoGraphLocation } from "../../repo-graph/proj-hash";
import {
  enumerateRepos,
  isValidProjHash,
  removeRepoIndex,
  resolveRepoByHash,
  restorePreservedArchModel,
} from "../../repo-graph/repo-registry";
import { validateIndexPath } from "../../repo-graph/index-guard";
import { loadIndexConfig, resolveAllowRoots } from "../../config/index-config";
import { siltpokeRoot } from "../../installer/paths";
import { resolveArchTimeoutMs, TaskRegistry } from "../task-registry";
import { appendUsageEvent } from "../../state/usage";
import { isAuthorized } from "../auth";
import { streamSSE } from "hono/streaming";
import { buildSearchIndex, fuzzyMatch } from "../../repo-graph/search-index";
import { levenshteinSuggest, resolveTarget } from "../../repo-graph/query";
import { buildSymbolTable } from "../../repo-graph/symbol-table";
import { detectEntrypoints } from "../../repo-graph/detect-entrypoints";
import { computeCoverage } from "../../repo-graph/coverage";
import { tracePath } from "../../repo-graph/trace-path";
import {
  readFingerprints,
  readGraph,
  readMeta,
  readQueryIndex,
} from "../../repo-graph/store";
import type { RepoGraph, RepoGraphMeta, SiltpokeGraphNode } from "../../repo-graph/types";

/**
 * Runs the indexer subprocess for `POST /index`. Extracted + injectable
 * so tests drive the endpoint deterministically without a real spawn (the real
 * spawn is exercised by the live Playwright smoke). Returns the child's exit
 * status; the route owns validation, the one-at-a-time lock, and cleanup.
 */
export interface IndexRunArgs {
  /** Canonical, allow-root-validated dir (NEVER the raw user input). */
  realPath: string;
  projHash: string;
  home?: string;
  timeoutMs: number;
  /** Fired per source file as the child reports `--progress` NDJSON. */
  onProgress?: (done: number, total: number) => void;
  /** Abort → kill the child (cancel). */
  signal?: AbortSignal;
}
export interface IndexRunResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
}
export type IndexRunner = (args: IndexRunArgs) => Promise<IndexRunResult>;

const defaultIndexRunner: IndexRunner = async ({ realPath, home, timeoutMs, onProgress, signal }) => {
  // Arg-array spawn (no shell → no interpolation). The indexer takes its root
  // from cwd, so cwd = the validated realPath; SILTPOKE_HOME pins the child's
  // storage to the daemon's home. process.execPath = the bun binary. `--progress`
  // makes it emit `{"type":"progress","done","total"}` NDJSON we tail for SSE.
  const script = join(import.meta.dir, "../../cli/index-repo.ts");
  const env = { ...process.env, ...(home ? { SILTPOKE_HOME: home } : {}) } as Record<string, string>;
  const proc = Bun.spawn([process.execPath, script, "--progress"], {
    cwd: realPath,
    env,
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });

  let timedOut = false;
  let aborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    proc.kill();
  };
  signal?.addEventListener("abort", onAbort);

  // The timer + abort listener must stay live until the process exits (they own
  // the kill); the finally cleans both up no matter how we leave — including if
  // `proc.exited` itself rejects (review LOW: avoids a dangling timer/listener).
  try {
    // Tail stdout line-by-line; parse the progress NDJSON, ignore the rest (the
    // final human output lines fail JSON.parse and are skipped).
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.length === 0) continue;
          try {
            const ev = JSON.parse(line) as { type?: string; done?: number; total?: number };
            if (ev.type === "progress" && typeof ev.done === "number" && typeof ev.total === "number") {
              onProgress?.(ev.done, ev.total);
            }
          } catch {
            /* non-progress line (final output) — ignore */
          }
        }
      }
    } catch {
      /* stream error — fall through to exit code */
    }
    const exitCode = await proc.exited;
    return { exitCode, timedOut, aborted };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
};

export interface RepoGraphRouteDeps {
  cwd: string;
  /** Override siltpoke home dir (tests). */
  home?: string;
  /** Override the index subprocess runner (tests inject a deterministic stub). */
  indexRunner?: IndexRunner;
  /**
   * Accepted for call-site symmetry with the other route mounts, but ignored:
   * the repo-graph read routes are intentionally unauthenticated (see header).
   */
  secret?: string;
  /** Override the Brain provider for `POST /explain` (tests inject a stub). */
  explainBrainProvider?: BrainProvider;
  /** Override the source provider for `POST /explain` (tests inject a stub). */
  explainSourceProvider?: SourceProvider;
  /** Override the Brain provider for the architecture-model generate (tests). */
  archBrainProvider?: BrainProvider;
  /** Pre-created TaskRegistry to share with the daemon (for shutdown wiring).
   * When provided, the route uses it instead of creating its own. */
  taskRegistry?: TaskRegistry;
}

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

interface ActiveRepo {
  storage_dir: string;
  project_root: string;
}

/**
 * Resolve the active repo: `?repo=<proj_hash>` if present and known, else the
 * daemon's cwd. Returns null when the requested repo isn't indexed.
 */
async function resolveActiveRepo(
  repo: string | undefined,
  deps: RepoGraphRouteDeps,
): Promise<ActiveRepo | null> {
  if (repo) {
    const loc = await resolveRepoByHash(repo, { home: deps.home });
    if (!loc || !loc.project_root) return null;
    return { storage_dir: loc.storage_dir, project_root: loc.project_root };
  }
  const loc = resolveRepoGraphLocation(deps.cwd, { home: deps.home });
  return { storage_dir: loc.storage_dir, project_root: loc.project_root };
}

/** Read + parse the repo's CLAUDE.md §Architecture overlay (null if absent). */
async function loadOverlay(projectRoot: string) {
  const claudeMd = join(projectRoot, "CLAUDE.md");
  if (!existsSync(claudeMd)) return null;
  try {
    return parseArchitectureSection(await readFile(claudeMd, "utf8"));
  } catch {
    return null;
  }
}

// (deleted 2026-06-10) subdirIdOfPath — the third private path→bucket
// derivation ("segment after the root"); returned FILENAMES on top-level-file
// repos (plc `scripts/x.py` → "x.py") → 0-file drill targets. All bucket
// resolution now goes through the keyspace's own `bucketIdOfPath` /
// projection-path prefixes; the reverse-guard test pins this.

/** "src/explain/explain.ts" → "explain.ts". */
function basenameOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length ? segs[segs.length - 1]! : path;
}

function locOf(node: SiltpokeGraphNode): number {
  return Math.max(1, node.lineRange[1] - node.lineRange[0] + 1);
}

function humanizeAgo(iso: string | null, status: string): string {
  if (status === "indexing") return "indexing…";
  if (!iso) return "not indexed";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "indexed";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "indexed just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `indexed ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `indexed ${hrs}h ago`;
  return `indexed ${Math.floor(hrs / 24)}d ago`;
}

export function mountRepoGraphRoutes(app: Hono, deps: RepoGraphRouteDeps): void {
  const { cwd, home } = deps;

  // One-at-a-time lock: a single index may run per daemon. `activeIndexHash`
  // is the in-flight build's proj_hash; `activeAbort` is its kill switch (cancel).
  // Module-per-mount closure state, reset in the SSE handler's finally.
  let activeIndexHash: string | null = null;
  let activeAbort: AbortController | null = null;

  // Long-task registry (止血): generate runs a 1–60 min `claude -p`. Before,
  // navigate-away orphaned the subprocess (invisible burn). Now each generate is
  // registered (visible in ~/.siltpoke/tasks.json) + cancellable; the request's
  // own disconnect signal cancels it (navigate away → SIGTERM the subprocess),
  // and POST /arch/cancel cancels manually. Shared across this mount's handlers.
  // Bug B: when the daemon provides a pre-created registry, reuse it — this lets
  // stopDaemon call stopWatchers() to prevent the poll timers from pinning the
  // event loop on shutdown.
  const taskRegistry = deps.taskRegistry ?? new TaskRegistry(home ?? siltpokeRoot());

  // ── POST /api/repo-graph/index ───────────────────────────────────────────
  // Spawn the indexer on a user-given path + stream progress over SSE.
  // Secret-gated (browser-reachable mutating + spawn endpoint, unlike the
  // read-only GETs); validates + canonicalizes; one-at-a-time; cleans
  // up any partial index on a non-clean OR cancelled end. Pre-stream failures
  // (auth / bad path / 409) return JSON with a real status; once validated, the
  // response is an SSE stream of started → progress* → done | error.
  app.post("/api/repo-graph/index", async (c) => {
    // Obligation 1: secret-gate. Fail CLOSED — no configured
    // secret ⇒ reject (isAuthorized("", …) is false), unlike the read GETs.
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, data: null, error: "unauthorized" }, 401);
    }
    let body: { path?: unknown };
    try {
      body = (await c.req.json()) as { path?: unknown };
    } catch {
      return c.json({ success: false, data: null, error: "invalid_json" }, 400);
    }
    const inputPath = typeof body.path === "string" ? body.path : "";
    const cfg = await loadIndexConfig(home ?? siltpokeRoot());
    const v = validateIndexPath(inputPath, { allowRoots: resolveAllowRoots(cfg) });
    if (!v.ok) return c.json({ success: false, data: null, error: v.reason }, 400);

    // One-at-a-time — refuse a second concurrent index (before streaming).
    if (activeIndexHash) {
      return c.json({ success: false, data: null, error: "index_in_progress", activeHash: activeIndexHash }, 409);
    }
    // Acquire the lock SYNCHRONOUSLY here (not inside the async SSE callback) so
    // two near-simultaneous POSTs can't both pass the 409 check above before
    // either sets it. The callback's finally is the normal release; the
    // try/catch below releases if streamSSE itself throws synchronously (before
    // the callback ever runs) — otherwise the lock would leak permanently.
    activeIndexHash = v.projHash;
    const ac = new AbortController();
    activeAbort = ac;
    try {
      return streamSSE(c, async (stream) => {
        try {
          // "started" carries the hash + name; the client shows "scanning…" until
          // the first "progress" arrives (total unknown during the eager walk).
          await stream.writeSSE({ event: "started", data: JSON.stringify({ hash: v.projHash, name: basenameOf(v.realPath) }) });
          const runner = deps.indexRunner ?? defaultIndexRunner;
          // Obligation 2: spawn on v.realPath (canonical,
          // allow-root-validated), NEVER the raw input — closes the TOCTOU window.
          const res = await runner({
            realPath: v.realPath,
            projHash: v.projHash,
            home,
            timeoutMs: cfg.timeoutMs,
            signal: ac.signal,
            onProgress: (done, total) => {
              void stream.writeSSE({ event: "progress", data: JSON.stringify({ done, total }) });
            },
          });
          // Any non-clean end (cancel / timeout / non-zero exit) may have left
          // meta.building:true + partial files → delete so no stuck "indexing".
          if (res.aborted) {
            await removeRepoIndex(v.projHash, { home });
            await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "cancelled" }) });
          } else if (res.timedOut || res.exitCode !== 0) {
            await removeRepoIndex(v.projHash, { home });
            await stream.writeSSE({ event: "error", data: JSON.stringify({ message: res.timedOut ? "timeout" : "index_failed" }) });
          } else {
            // A prior forget may have stashed this repo's PAID arch-model in
            // `.preserved/` — a successful index is the re-attach point.
            // Failure here is non-fatal: the model just stays preserved.
            await restorePreservedArchModel(v.projHash, { home }).catch(() => {});
            await stream.writeSSE({ event: "done", data: JSON.stringify({ hash: v.projHash }) });
          }
        } catch {
          await removeRepoIndex(v.projHash, { home }).catch(() => {});
          await stream.writeSSE({ event: "error", data: JSON.stringify({ message: "index_error" }) }).catch(() => {});
        } finally {
          activeIndexHash = null;
          activeAbort = null;
        }
      });
    } catch (err) {
      // streamSSE threw synchronously before the callback ran → release the lock
      // here (the callback's finally never executes in that case).
      activeIndexHash = null;
      activeAbort = null;
      throw err;
    }
  });

  // ── POST /api/repo-graph/index/cancel ────────────────────────────────────
  // Abort the in-flight index. The running SSE handler sees the abort → kills
  // the child → removeRepoIndex → emits an "error: cancelled" event, so a
  // cancelled build leaves no partial repo. No-op (cancelled:false) if nothing
  // matching is running.
  app.post("/api/repo-graph/index/cancel", async (c) => {
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, data: null, error: "unauthorized" }, 401);
    }
    let body: { hash?: unknown };
    try {
      body = (await c.req.json()) as { hash?: unknown };
    } catch {
      body = {};
    }
    const hash = typeof body.hash === "string" ? body.hash : "";
    const matches = activeIndexHash !== null && (hash === "" || hash === activeIndexHash);
    if (matches && activeAbort) {
      activeAbort.abort();
      return c.json({ success: true, data: { cancelled: true }, error: null });
    }
    return c.json({ success: true, data: { cancelled: false }, error: null });
  });

  // ── DELETE /api/repo-graph/repos/:hash (forget) ─────────────────────────
  // Forget a repo: delete its on-disk index via the shared removeRepoIndex
  // primitive. Secret-gated; hash-validated before any rm; refused while
  // an index runs (guardrail — don't delete out from under a build).
  app.delete("/api/repo-graph/repos/:hash", async (c) => {
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, data: null, error: "unauthorized" }, 401);
    }
    const hash = c.req.param("hash");
    if (!isValidProjHash(hash)) {
      return c.json({ success: false, data: null, error: "invalid_hash" }, 400);
    }
    if (activeIndexHash) {
      return c.json({ success: false, data: null, error: "index_in_progress" }, 409);
    }
    const removed = await removeRepoIndex(hash, { home });
    return c.json({ success: true, data: { removed }, error: null });
  });

  // ── GET /api/repo-graph/repos ───────────────────────────────────────────
  app.get("/api/repo-graph/repos", async (c) => {
    const entries = await enumerateRepos({ home });
    const summaries = await Promise.all(
      entries.map(async (e) => {
        const loc = await resolveRepoByHash(e.proj_hash, { home });
        const meta = loc ? await readMeta(loc.storage_dir) : null;
        const cn = meta?.counters.nodes;
        const state =
          e.status === "indexing" ? "indexing" : e.status === "ready" ? "ready" : "none";
        return {
          id: e.proj_hash,
          name: e.project_root ? basenameOf(e.project_root) : e.proj_hash,
          path: e.project_root ?? "",
          files: cn?.file ?? 0,
          symbols: cn ? cn.function + cn.class + cn.module + cn.symbol : 0,
          edges: meta?.counters.edges.imports ?? 0,
          lastIndexed: humanizeAgo(e.last_indexed_ts, e.status),
          lastIndexedTs: e.last_indexed_ts ?? "",
          state,
        };
      }),
    );
    return c.json({ success: true, data: { repos: summaries }, error: null });
  });

  // ── GET /api/repo-graph/arch ────────────────────────────────────────────
  app.get("/api/repo-graph/arch", async (c) => {
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const meta = await readMeta(active.storage_dir);
    if (!meta) return c.json({ success: false, error: "graph not found" }, 404);
    const graph = await readGraph(active.storage_dir);
    const overlay = await loadOverlay(active.project_root);
    const projection = projectArchitecture(graph, overlay, meta);
    return c.json({ success: true, data: projection, error: null });
  });

  // ── GET /api/repo-graph/arch/estimate ────────────────────────────────────
  // Pre-flight cost estimate. Read-only, NO Brain call → open like the other GETs.
  app.get("/api/repo-graph/arch/estimate", async (c) => {
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const est = await estimateArchGenerate({
      graphStorageDir: active.storage_dir,
      brainProvider: async () => {
        throw new Error("estimate must not call brain");
      },
      sourceProvider: async () => null,
      loadOverlay: () => loadOverlay(active.project_root),
    });
    if (!est.ok) return c.json({ success: false, error: est.message }, 422);
    // Derive the advisory truncation flag server-side from the SAME
    // pre-flight estimate (the input-side budget-pressure signal). The client
    // reads the boolean and surfaces an advisory line — it NEVER blocks.
    return c.json({
      success: true,
      data: { ...est.estimate, mayTruncate: archGenerateMayTruncate(est.estimate) },
      error: null,
    });
  });

  // ── POST /api/repo-graph/arch/generate ───────────────────────────────────
  // The one paid, browser-reachable, mutating route → secret-gated, fail CLOSED.
  app.post("/api/repo-graph/arch/generate", async (c) => {
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, error: "unauthorized" }, 401);
    }
    let body: { repo?: string; force?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body ok */
    }
    const active = await resolveActiveRepo(body.repo, deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);

    // 止血: register the run (visible + lock + cancellable) BEFORE spawning.
    // One generate at a time per daemon (mirrors the /index lock); a 2nd → 409.
    const controller = new AbortController();
    // Wall-clock 守卫: a run that outlives the ceiling is SIGKILL'd +
    // recorded crashed/cost-null. The disconnect-auto-cancel used to be today's
    // runaway 兜底; now that it's gone, this becomes the only bound on an
    // abandoned run.
    const task = taskRegistry.register(
      "arch_generate",
      body.repo ?? active.project_root,
      // The run is spawned detached (it gets a per-task result file below), so
      // mark it — daemon stop() spares detached in-flight children; they survive
      // to finish + write their file rather than being killed mid-paid-run.
      { controller, detached: true },
      { timeoutMs: resolveArchTimeoutMs() },
    );
    if (!task) {
      // Carry the active task's repo so the client can tell "attach to my own
      // repo's run" from "a DIFFERENT repo is generating" (no spinner there).
      const activeId = taskRegistry.activeTaskId();
      const activeRepo = activeId ? (taskRegistry.get(activeId)?.repo ?? null) : null;
      return c.json(
        { success: false, error: "generate_in_progress", activeTaskId: activeId, activeTaskRepo: activeRepo },
        409,
      );
    }
    // Detached flip: NO `c.req.raw.signal` disconnect listener — navigate
    // away no longer cancels. The run survives client disconnect, backstopped by
    // the wall-clock 守卫 (the sole runaway bound now) + reconnect; the
    // model lands in the result-cache (readArchModel) and the client fetches it
    // on reconnect. The LLM pass runs as a FLOATING promise with its OWN
    // try/catch — a rejection must never become an unhandledRejection that
    // crashes the long-lived daemon — recording finish/fail + the cost ledger
    // AFTER this handler has already returned `{taskId}`.
    //
    // Shared failure ledger — a run that reached the paid subprocess
    // and died (non-zero exit OR timeout-kill) still spent money; it must hit
    // the ledger. Prefer the REAL usage recovered from the error's stdout tail
    // (`basis: "tail_parsed"`); when the tail is truncated / unparseable,
    // ledger the recomputed pre-flight estimate flagged `basis: "estimated"`
    // (contingency). The whole body is wrapped — the ledger write must NEVER
    // throw back into the failure handler.
    const ledgerFailedRunUsage = async (message: string): Promise<void> => {
      try {
        const tail = parseUsageFromTail(message);
        const ledgerBase = home ?? siltpokeRoot();
        if (tail) {
          await appendUsageEvent(ledgerBase, {
            ts: new Date().toISOString(),
            kind: "arch_generate",
            session_id: task.id,
            input_tokens: tail.input_tokens,
            output_tokens: tail.output_tokens,
            cache_creation_input_tokens: tail.cache_creation_input_tokens,
            cache_read_input_tokens: tail.cache_read_input_tokens,
            // Review CF1 — a tail whose cost field was truncated away (tokens
            // survived, cost didn't) must not ledger null (summed as $0
            // downstream): derive it from the recovered tokens. This route
            // always runs the default model (no model param on the body).
            total_cost_usd: tail.total_cost_usd ?? archCostFromUsage(tail, ARCH_DEFAULT_MODEL),
            basis: "tail_parsed",
          });
        } else {
          // Cheap, NO Brain call — same construction as /arch/estimate.
          const est = await estimateArchGenerate({
            graphStorageDir: active.storage_dir,
            brainProvider: async () => {
              throw new Error("estimate must not call brain");
            },
            sourceProvider: async () => null,
            loadOverlay: () => loadOverlay(active.project_root),
          });
          if (est.ok) {
            await appendUsageEvent(ledgerBase, {
              ts: new Date().toISOString(),
              kind: "arch_generate",
              session_id: task.id,
              input_tokens: est.estimate.estInputTokens,
              output_tokens: est.estimate.estOutputTokens,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              total_cost_usd: est.estimate.estUsd,
              basis: "estimated",
            });
          }
        }
      } catch {
        // Honesty record lost, but the failure handler stays unharmed —
        // never let accounting break the daemon's error path.
      }
    };
    void (async () => {
      try {
        const outcome = await runArchGenerate({
          graphStorageDir: active.storage_dir,
          brainProvider: deps.archBrainProvider ?? makeArchBrainProvider(),
          sourceProvider: makeDefaultSourceProvider(active.project_root),
          loadOverlay: () => loadOverlay(active.project_root),
          force: body.force === true,
          signal: controller.signal,
          onSpawn: (proc) => taskRegistry.attachProc(task.id, proc),
          // Detached spawn + tee stdout to the per-task result file so this
          // paid run survives the daemon dying mid-flight (the file is the source
          // of truth; reconcile/scavenger recover it on the next daemon start).
          resultFilePath: taskRegistry.resultFilePathFor(task.id),
          // Thread the registry's startedTs so durationMs is computed from
          // the single source of truth (not a second Date.now() inside generate).
          taskStartedTs: task.startedTs,
        });
        // Honest cost: record the real spend whenever the Brain call actually
        // ran. Every outcome EXCEPT pre_check_failed carries a costUsd (the Brain
        // was billed) — cost_cap_exceeded / malformed / integrity_failed all
        // spent money even though their result was rejected. null is reserved for
        // runs that emitted no usage at all (cancelled/killed / pre-check).
        const finalCost = "costUsd" in outcome ? outcome.costUsd : null;
        // B-diag: persist errorMsg for paid-but-rejected outcomes so a $1.45
        // malformed run is diagnosable from the task record (not just the cost).
        // malformed carries output_tokens for parse-failure triage; prepend it.
        // The variable message is capped (the full output stays in the retained
        // .out result file) so tasks.json can never absorb an unbounded string.
        const cap = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);
        const finishErrorMsg: string | undefined =
          outcome.kind === "malformed"
            ? `malformed: ${cap(outcome.message)} [output_tokens:${outcome.usage.output_tokens}]`
            : outcome.kind === "integrity_failed"
              ? `integrity_failed: ${cap(outcome.message)}`
              : outcome.kind === "cost_cap_exceeded"
                ? `cost_cap_exceeded: hard_cap=$${outcome.hardCapUsd} actual=$${outcome.costUsd}`
                : undefined;
        taskRegistry.finish(task.id, { costUsd: finalCost, errorMsg: finishErrorMsg });
        // Record the run in the cost ledger so a paid generate is visible
        // to `rtk gain`. Record on ANY outcome that spent money THIS run; EXCLUDE
        // a `generated` cache hit ($0 re-serve → recording it fabricates spend).
        const spentUsage =
          outcome.kind === "generated"
            ? outcome.fromCache
              ? null
              : outcome.usage
            : outcome.kind === "cost_cap_exceeded" ||
                outcome.kind === "malformed" ||
                outcome.kind === "integrity_failed"
              ? outcome.usage
              : null;
        if (spentUsage) {
          await appendUsageEvent(home ?? siltpokeRoot(), {
            ts: new Date().toISOString(),
            kind: "arch_generate",
            // Not a Claude SDK session id (daemon route, not a Stop hook) — the
            // registry task id is the only stable correlation key for this run.
            session_id: task.id,
            input_tokens: spentUsage.input_tokens,
            output_tokens: spentUsage.output_tokens,
            cache_creation_input_tokens: spentUsage.cache_creation_input_tokens,
            cache_read_input_tokens: spentUsage.cache_read_input_tokens,
            // Review CF1 — `finalCost` is the orchestrator's costUsd: the SDK
            // total_cost_usd when present, else the token-derived figure —
            // never null-as-$0. (Non-null here: every spentUsage outcome
            // carries costUsd.)
            total_cost_usd: finalCost,
            // Review CF5 — when the SDK omitted total_cost_usd the figure
            // above is rate-table-derived; mark it so audits can tell the two
            // apart. SDK-reported costs keep the legacy absent-basis shape.
            ...(spentUsage.total_cost_usd === null
              ? { basis: "derived" as const }
              : {}),
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "unknown";
        // cancel()/timeoutKill() may have already set the terminal (status ≠
        // running) — the `status === running` guard prevents a double-complete /
        // a crashed→cancelled overwrite. Otherwise a real Brain failure → failed.
        if (controller.signal.aborted) {
          // The kill chain's terminal distinguishes WHY we were
          // aborted: killLive() writes it synchronously inside abort()'s frame,
          // before this catch's microtask runs. `crashed` = timeoutKill (the
          // wall-clock ceiling) — the run burned real money the WHOLE
          // time, the exact unledgered-runaway class this ledger exists for →
          // record it (real tail figures when the SIGTERM window flushed one,
          // else the estimate). `cancelled` = user-cancel — ambiguous spend,
          // deliberately unledgered (declared residual).
          const status = taskRegistry.get(task.id)?.status;
          if (status === "running") taskRegistry.cancel(task.id);
          if (status === "crashed") await ledgerFailedRunUsage(message);
        } else {
          taskRegistry.fail(task.id, message);
          // Review BF1 — pre-spawn failures: a Bun.spawn throw (claude binary
          // missing → ENOENT) or stdin-delivery failure means the run never
          // reached the paid subprocess — $0 spent. Their messages have no
          // parseable tail, so the estimate fallback would fabricate ~$1.5 of
          // phantom spend per retry. Detected structurally via the
          // PreSpawnError marker thrown at the providers.ts spawn site.
          if (isPreSpawnError(e)) return;
          // A run that REACHED the paid subprocess and exited non-zero
          // still spent money; it must hit the ledger (two real ~$2.5 burns
          // went unledgered).
          await ledgerFailedRunUsage(message);
        }
      }
    })().catch(() => {
      // Belt: the error-path registry write (cancel/fail → persist → atomicWrite)
      // can itself throw on a disk/permission failure, which would escape the
      // inner try/catch as an unhandledRejection on the long-lived daemon. The
      // in-memory terminal + lock release already ran (complete() nulls activeId
      // BEFORE persist), so only the tasks.json write was lost — reconciled to
      // `crashed` on restart. Swallow so the daemon never crashes on a floating run.
    });
    // Detached: return the task handle immediately (HTTP 202) — the client
    // reconnects to stream progress + fetch the cached result on done.
    return c.json({ success: true, taskId: task.id, status: "running" }, 202);
  });

  // ── POST /api/repo-graph/arch/cancel (止血) ──────────────────────────────
  // Manually cancel the running generate → AbortController.abort() (SIGTERM the
  // `claude -p` subprocess), escalating to SIGKILL if still alive after 5s. The
  // registry records `cancelled`; the subprocess actually dying is the acceptance bar.
  app.post("/api/repo-graph/arch/cancel", async (c) => {
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, error: "unauthorized" }, 401);
    }
    const id = taskRegistry.activeTaskId();
    if (!id) return c.json({ success: false, error: "no_active_task" }, 404);
    taskRegistry.cancel(id);
    return c.json({ success: true, data: { cancelledTaskId: id }, error: null });
  });

  // ── GET /api/repo-graph/arch/task (reconnect snapshot) ───────────────────
  // `latest()` NOT `current()`: current() goes null the instant a run ends, so a
  // client returning to the page couldn't tell "just finished" from "never ran".
  // latest() is the most-recently-started running-or-terminal record → the
  // reconnect snapshot. `startedAgoMs` feeds the 409 "started Xm ago" card.
  // Snapshot-first by construction: one full record, never a partial/mid-state.
  app.get("/api/repo-graph/arch/task", (c) => {
    // ?repo= filter: the registry is one-task-at-a-time ACROSS repos, so
    // latest() is global — without the filter every repo's page attaches to
    // whatever repo happens to be generating (cross-repo spinner bleed). No
    // param keeps the global behavior for callers that really want "anything
    // running on this daemon".
    const repo = c.req.query("repo");
    const latest = taskRegistry.latest() ?? null;
    // `repo === ""` (unindexed-cwd page sends ?repo=) intentionally filters
    // EVERYTHING out — no task record ever has repo "" — so an unindexed page
    // never attaches to anyone's run. Only a truly absent param means global.
    const rec = latest && repo !== undefined && latest.repo !== repo ? null : latest;
    const task = rec ? { ...rec, startedAgoMs: Date.now() - new Date(rec.startedTs).getTime() } : null;
    return c.json({ success: true, data: { task }, error: null });
  });

  // ── GET /api/repo-graph/arch/model (cached model fetch) ──────────────────
  // The detached generate no longer returns the model in its response; on
  // terminal=done the client fetches it here and renders in place (no reload →
  // keeps zoom/scroll). 404 when no model was cached (e.g. a malformed run wrote
  // none) — an honest "no result", not a spinner.
  app.get("/api/repo-graph/arch/model", async (c) => {
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const meta = await readMeta(active.storage_dir);
    if (!meta) return c.json({ success: false, error: "graph not found" }, 404);
    const fingerprints = await readFingerprints(active.storage_dir);
    const cached = await readArchModel(active.storage_dir, computeRepoFingerprint(fingerprints), meta.last_indexed_ts);
    if (!cached) return c.json({ success: false, error: "no_generated_model" }, 404);
    // Ship the per-member-file function counts with the
    // model so a post-generate in-place render badges correctly (no reload).
    const fileFunctions = computeFileFunctions(await readGraph(active.storage_dir), cached.model.nodes);
    return c.json({
      success: true,
      data: {
        model: cached.model,
        groundedPct: cached.meta.groundedPct,
        stale: cached.stale,
        costUsd: cached.meta.costUsd,
        fileFunctions,
        // Expose generatedTs + durationMs so the island's modal can show
        // age · duration · grounded% without a second round-trip.
        generatedTs: cached.meta.generatedTs,
        durationMs: cached.meta.durationMs,
        // Grounding counts — optional; absent on legacy caches predating this field.
        // Never default to 0 (honesty rule: no fabrication).
        citedClaims: cached.meta.citedClaims,
        totalClaims: cached.meta.totalClaims,
        topologyBlindClaims: cached.meta.topologyBlindClaims,
      },
      error: null,
    });
  });

  // ── GET /api/repo-graph/files ───────────────────────────────────────────
  // Drill 1: files in a subdir + intra-subdir import edges + 1-hop neighbors.
  app.get("/api/repo-graph/files", async (c) => {
    const subdir = c.req.query("subdir");
    if (!subdir) return c.json({ success: false, error: "subdir query param required" }, 400);
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const meta = await readMeta(active.storage_dir);
    if (!meta) return c.json({ success: false, error: "graph not found" }, 404);

    const graph = await readGraph(active.storage_dir);
    const overlay = await loadOverlay(active.project_root);
    const projection = projectArchitecture(graph, overlay, meta);
    const subId = subdir.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? subdir;
    const subdirMeta = projection.subdirs.find((s) => s.id === subId);

    // The island is id-keyed, so `subdir` may arrive as a bare bucket id
    // ("explain", no slash) rather than a full path prefix ("src/explain/").
    // Id resolution goes through the PROJECTION'S OWN bucket (its path prefix
    // IS the bucket definition — works for top-level `scripts/` repos exactly
    // like `src/<subdir>/` repos); path callers keep the prefix match.
    const idPrefix = subdirMeta?.path
      ? subdirMeta.path.endsWith("/")
        ? subdirMeta.path
        : `${subdirMeta.path}/`
      : null;
    const fileNodes = subdir.includes("/")
      ? graph.nodes.filter(
          (n) =>
            n.type === "file" &&
            n.path.startsWith(subdir.endsWith("/") ? subdir : `${subdir}/`),
        )
      : graph.nodes.filter(
          (n) => n.type === "file" && idPrefix !== null && n.path.startsWith(idPrefix),
        );
    const fingerprints = await readFingerprints(active.storage_dir);
    const symbolCountByPath = symbolCounts(graph);
    const functionCountByPath = functionCounts(graph);

    const files = await Promise.all(
      fileNodes.map(async (n) => {
        const absPath = join(active.project_root, n.path);
        let desc = "";
        let loc = locOf(n);
        if (existsSync(absPath)) {
          try {
            const src = await readFile(absPath, "utf8");
            desc = parseFirstDocComment(src);
            loc = src.split(/\r?\n/).length;
          } catch {
            /* fall back to lineRange length */
          }
        }
        const cs = await deriveCacheState(n.id, active.project_root, fingerprints);
        return {
          name: basenameOf(n.path),
          path: n.path,
          loc,
          symbols: symbolCountByPath.get(n.path) ?? 0,
          functions: functionCountByPath.get(n.path) ?? 0,
          desc,
          explainState: cacheStateToContract(cs.state),
        };
      }),
    );

    const filePathSet = new Set(fileNodes.map((n) => n.path));
    const fileBasenameByPath = new Map(fileNodes.map((n) => [n.path, basenameOf(n.path)]));
    const intraEdges = computeIntraEdges(graph, filePathSet, fileBasenameByPath);

    const neighbors = {
      inbound: projection.edges
        .filter((e) => e.target === subId)
        .map((e) => ({ id: e.source, weight: e.weight })),
      outbound: projection.edges
        .filter((e) => e.source === subId)
        .map((e) => ({ id: e.target, weight: e.weight })),
    };

    return c.json({
      success: true,
      data: {
        subdir: {
          id: subId,
          group: subdirMeta?.group ?? "",
          purpose: subdirMeta?.purpose ?? "",
          files: files.length,
        },
        files,
        intraEdges,
        neighbors,
      },
      error: null,
    });
  });

  // ── GET /api/repo-graph/symbols ─────────────────────────────────────────
  // Drill 2: symbols in a file + synthesized call edges (the base index has no real
  // `calls` edges yet — hub-from-entry synthesis, dashed).
  app.get("/api/repo-graph/symbols", async (c) => {
    const file = c.req.query("file");
    if (!file) return c.json({ success: false, error: "file query param required" }, 400);
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const meta = await readMeta(active.storage_dir);
    if (!meta) return c.json({ success: false, error: "graph not found" }, 404);

    const graph = await readGraph(active.storage_dir);
    const fileNode = graph.nodes.find((n) => n.type === "file" && n.path === file);
    if (!fileNode) return c.json({ success: false, error: "file not found in graph" }, 404);
    // Keyspace projection — the file's `subdir` contract field must be a real
    // bucket id, resolved by the keyspace itself (bucketIdOfPath), never a
    // path-shape guess.
    const projection = projectArchitecture(graph, await loadOverlay(active.project_root), meta);

    const symbolNodes = graph.nodes.filter((n) => n.type !== "file" && n.path === file);
    let desc = "";
    let loc = locOf(fileNode);
    const absPath = join(active.project_root, file);
    if (existsSync(absPath)) {
      try {
        const src = await readFile(absPath, "utf8");
        desc = parseFirstDocComment(src);
        loc = src.split(/\r?\n/).length;
      } catch {
        /* fall back */
      }
    }
    const fingerprints = await readFingerprints(active.storage_dir);
    const cs = await deriveCacheState(fileNode.id, active.project_root, fingerprints);

    const symbols = symbolNodes.map((n) => ({
      name: n.name,
      kind: n.type,
      line: n.lineRange[0],
      signature: n.signature ?? "",
      desc: "",
    }));

    // REAL intra-file call edges from the `calls` extraction
    // (the synthesized hub is gone). Keep only edges where both the caller and
    // the callee are symbols in THIS file, so the symbol-level view is coherent.
    const symbolNames = new Set(symbols.map((s) => s.name));
    const callEdges: Array<{ source: string; target: string }> = [];
    const seenCall = new Set<string>();
    for (const e of graph.edges) {
      if (e.type !== "calls") continue;
      const m = /^(?:function|class):([^:]+):(.+)$/.exec(e.source);
      if (!m || m[1] !== file) continue;
      const caller = m[2]!;
      if (!symbolNames.has(caller) || !symbolNames.has(e.target)) continue;
      const key = `${caller} ${e.target}`;
      if (seenCall.has(key)) continue;
      seenCall.add(key);
      callEdges.push({ source: caller, target: e.target });
    }

    return c.json({
      success: true,
      data: {
        file: {
          name: basenameOf(file),
          path: file,
          // keyspace bucket id ("" = no bucket claims it — honest-zero, never
          // a filename masquerading as a bucket).
          subdir: bucketIdOfPath(projection.subdirs, file) ?? "",
          loc,
          desc,
          explainState: cacheStateToContract(cs.state),
        },
        symbols,
        callEdges,
      },
      error: null,
    });
  });

  // ── GET /api/repo-graph/entrypoints ──────────────────────────────────────
  // Detected trace roots + the repo-level coverage gate.
  app.get("/api/repo-graph/entrypoints", async (c) => {
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const meta = await readMeta(active.storage_dir);
    if (!meta) return c.json({ success: false, error: "graph not found" }, 404);
    const graph = await readGraph(active.storage_dir);
    const queryIndex = await readQueryIndex(active.storage_dir);
    const entrypoints = detectEntrypoints(graph, queryIndex);
    // Compute live: a metric recalibration changed the metric (eligible
    // denominator), so any stored meta.coverage is the stale raw value. The
    // re-resolve is cheap for a local read endpoint.
    const coverage = computeCoverage(graph, queryIndex);
    return c.json({ success: true, data: { entrypoints, coverage }, error: null });
  });

  // ── GET /api/repo-graph/trace (trace from any node) ──────────────────────
  // A depth-limited call path from a root. `entry` is either a detected
  // entrypoint's id (preset, e.g. "cli" | "daemon" | "dash") OR any raw graph
  // node id (`kind:path:name`) — the latter is how "trace from here" / the
  // function-search picker root an arbitrary function or method. Default "cli".
  app.get("/api/repo-graph/trace", async (c) => {
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const meta = await readMeta(active.storage_dir);
    if (!meta) return c.json({ success: false, error: "graph not found" }, 404);
    const graph = await readGraph(active.storage_dir);
    const queryIndex = await readQueryIndex(active.storage_dir);
    const entrypoints = detectEntrypoints(graph, queryIndex);

    const entryParam = c.req.query("entry") ?? "cli";
    const role = entrypoints.find((e) => e.id === entryParam);
    let entryId: string | null = null;
    if (role) entryId = role.nodeId;
    else if (graph.nodes.some((n) => n.id === entryParam)) entryId = entryParam;
    if (!entryId) {
      return c.json({ success: false, error: `unknown entrypoint: ${entryParam}` }, 404);
    }

    let depth = parseInt(c.req.query("depth") ?? "6", 10);
    if (!Number.isFinite(depth)) depth = 6;
    depth = Math.max(1, Math.min(12, depth));

    const trace = tracePath(graph, queryIndex, entryId, {
      depth,
      entrypointIds: entrypoints.map((e) => e.nodeId),
    });
    return c.json({ success: true, data: trace, error: null });
  });

  // ── GET /api/repo-graph/trace/purpose ────────────────────────────────────
  // Cheap cache-state read for a trace node's grounded purpose. Returns the
  // cached one-sentence purpose + citation when warm, so the card loads it
  // instantly without re-generating; else { state: "none" }.
  app.get("/api/repo-graph/trace/purpose", async (c) => {
    const node = c.req.query("node");
    if (!node) return c.json({ success: false, error: "node query param required" }, 400);
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const graph = await readGraph(active.storage_dir);
    const queryIndex = await readQueryIndex(active.storage_dir);
    const resolution = resolveTarget(purposeResolveTarget(node), graph, buildSymbolTable(graph, queryIndex));
    if (resolution.kind !== "found") {
      return c.json({ success: true, data: { state: "none" }, error: null });
    }
    const resolvedId = resolution.node.nodeId;
    const fingerprints = await readFingerprints(active.storage_dir);
    const cs = await deriveCacheState(resolvedId, active.project_root, fingerprints);
    if (cacheStateToContract(cs.state) === "valid") {
      const cached = await readExplanation(active.project_root, cacheKey(resolvedId));
      if (cached) {
        return c.json(
          { success: true, data: { state: "cached", ...purposeOf(cached.markdown, graph, resolvedId) }, error: null },
          200,
        );
      }
    }
    return c.json({ success: true, data: { state: "none" }, error: null });
  });

  // ── POST /api/repo-graph/trace/purpose ───────────────────────────────────
  // Grounded one-sentence purpose for a trace node: reuses runExplain (reads
  // the function body → Brain → evidence guard → fingerprint-stamped cache).
  // Returns { text, cite, cached }. A Brain failure surfaces the REAL reason
  // and writes NO cache (runExplain only persists on a successful Brain call).
  app.post("/api/repo-graph/trace/purpose", async (c) => {
    let body: { node?: string; repo?: string; force?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body → 400 below */
    }
    const node = body.node;
    if (!node) return c.json({ success: false, error: "node required in body" }, 400);
    const active = await resolveActiveRepo(body.repo, deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);

    const graph = await readGraph(active.storage_dir);
    const queryIndex = await readQueryIndex(active.storage_dir);
    const target = purposeResolveTarget(node);
    const resolution = resolveTarget(target, graph, buildSymbolTable(graph, queryIndex));
    if (resolution.kind !== "found") {
      return c.json({ success: false, error: `node not resolvable: ${node}` }, 404);
    }
    const resolvedId = resolution.node.nodeId;
    const priorCache = await readExplanation(active.project_root, cacheKey(resolvedId));
    const fresh = body.force === true || priorCache === null;

    let outcome: ExplainOutcome;
    try {
      outcome = await runExplain(
        { target, force: body.force ?? false },
        {
          cwd: active.project_root,
          graphStorageDir: active.storage_dir,
          sourceProvider: deps.explainSourceProvider ?? makeDefaultSourceProvider(active.project_root),
          brainProvider: deps.explainBrainProvider ?? makeDefaultBrainProvider(),
          ledgerBasePath: home ?? siltpokeRoot(),
        },
      );
    } catch (e) {
      // Brain unavailable (e.g. `claude -p` non-zero / rate-limited). runExplain
      // persists only after a successful call, so nothing dirty was written.
      const reason = e instanceof Error ? e.message : "Brain unavailable";
      return c.json({ success: false, error: reason }, 422);
    }
    if (outcome.kind !== "explained") {
      return c.json({ success: false, error: explainOutcomeError(outcome) }, 422);
    }
    return c.json(
      { success: true, data: { ...purposeOf(outcome.result.markdown, graph, resolvedId), cached: !fresh }, error: null },
      200,
    );
  });

  // ── GET /api/repo-graph/search ──────────────────────────────────────────
  app.get("/api/repo-graph/search", async (c) => {
    const q = c.req.query("q");
    if (q === undefined || q === "") {
      return c.json({ success: false, error: "q query param required" }, 400);
    }
    let limit = parseInt(c.req.query("limit") ?? String(DEFAULT_LIMIT), 10);
    if (!Number.isFinite(limit)) limit = DEFAULT_LIMIT;
    limit = Math.max(1, Math.min(MAX_LIMIT, limit));

    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const meta = await readMeta(active.storage_dir);
    if (!meta) return c.json({ success: false, error: "graph not found" }, 404);

    const graph = await readGraph(active.storage_dir);
    const queryIndex = await readQueryIndex(active.storage_dir);
    const index = buildSearchIndex(graph, queryIndex);
    const matches = fuzzyMatch(q, index, limit);
    // Hits carry the KEYSPACE bucket id as the drill target ("" = unbucketed,
    // honest-zero) — the old segment heuristic shipped filenames as "buckets"
    // on top-level repos, breaking every search jump there.
    const projection = projectArchitecture(graph, await loadOverlay(active.project_root), meta);

    const hits = matches.map((m) => {
      if (m.type === "file") {
        return {
          kind: "file" as const,
          name: m.name,
          subdir: bucketIdOfPath(projection.subdirs, m.path) ?? "",
          file: basenameOf(m.path),
          // `path` is a superset of the contract — the frontend needs the full
          // (possibly nested) path to drill, which subdir+basename can't rebuild.
          path: m.path,
        };
      }
      return {
        kind: "symbol" as const,
        name: m.name,
        symbolKind: m.type,
        signature: nodeSignature(graph, m.node_id),
        subdir: bucketIdOfPath(projection.subdirs, m.path) ?? "",
        file: basenameOf(m.path),
        line: nodeLine(graph, m.node_id),
        path: m.path,
      };
    });

    // No matches → "did you mean" suggestions via Levenshtein over all names.
    const suggestions =
      hits.length === 0
        ? levenshteinSuggest(q, Array.from(index.byName.keys()), 5).map((name) => ({
            kind: "suggestion" as const,
            name,
          }))
        : [];

    return c.json({ success: true, data: { hits, suggestions }, error: null });
  });

  // ── GET /api/repo-graph/explain — cheap cache-state read ─────────────────
  app.get("/api/repo-graph/explain", async (c) => {
    const target = c.req.query("target");
    if (!target) return c.json({ success: false, error: "target query param required" }, 400);
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    // Resolve-then-key (cache-key-mismatch guard, same pattern as
    // /explain/result): runExplain WRITES under cacheKey(resolved_node_id), so
    // reading with the raw target silently misses for path/bare-symbol targets.
    const graph = await readGraph(active.storage_dir);
    const queryIndex = await readQueryIndex(active.storage_dir);
    const resolution = resolveTarget(target, graph, buildSymbolTable(graph, queryIndex));
    const resolvedId = resolution.kind === "found" ? resolution.node.nodeId : target;
    const fingerprints = await readFingerprints(active.storage_dir);
    const cs = await deriveCacheState(resolvedId, active.project_root, fingerprints);
    const file = fileFromNodeId(resolvedId);
    const fingerprint = file ? fingerprints.files[file]?.content_sha256 ?? "" : "";
    const cached = await readExplanation(active.project_root, cacheKey(resolvedId));
    return c.json({
      success: true,
      data: {
        state: cacheStateToContract(cs.state),
        fingerprint,
        cachedFingerprint: cached?.meta.source_fingerprint,
        cachedAt: cached?.meta.created_ts,
      },
      error: null,
    });
  });

  // ── POST /api/repo-graph/explain — run + cache, return the modal data ────
  app.post("/api/repo-graph/explain", async (c) => {
    let body: { target?: string; repo?: string; force?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body → 400 below */
    }
    const target = body.target;
    if (!target) return c.json({ success: false, error: "target required in body" }, 400);
    const active = await resolveActiveRepo(body.repo, deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);

    // Detached: the fresh-vs-cache flag (resolved-node-keyed readExplanation
    // pre-check) moved to the reconnect, where the response is built on fetch.
    // Detached, this handler returns {taskId} before runExplain finishes, so it
    // can't compute the response's `fresh` flag here.

    // Register the user-facing explain run in the same one-at-a-time
    // registry as generate (visible the moment it starts + cancellable +
    // cost-recorded). NOTE: the internal trace/purpose call (POST
    // /trace/purpose) is deliberately NOT registered — it's a fast grounding
    // call that must not be one-at-a-timed behind a long generate.
    const controller = new AbortController();
    // Wall-clock 守卫 (same ceiling as generate; explain is Haiku/seconds so
    // never approaches it — it's a runaway safety net, not an SLA).
    const task = taskRegistry.register(
      "explain",
      body.repo ?? active.project_root,
      { controller },
      { timeoutMs: resolveArchTimeoutMs() },
    );
    if (!task) {
      return c.json({ success: false, error: "task_in_progress", activeTaskId: taskRegistry.activeTaskId() }, 409);
    }
    // Detached flip (same shape as generate): no disconnect listener, run
    // the explain pass as a floating promise with its own try/catch, return
    // {taskId} immediately. The explanation lands in runExplain's cache
    // (readExplanation) and the reconnect fetches + builds the response.
    void (async () => {
      try {
        const outcome = await runExplain(
          { target, force: body.force ?? false },
          {
            cwd: active.project_root,
            graphStorageDir: active.storage_dir,
            sourceProvider: deps.explainSourceProvider ?? makeDefaultSourceProvider(active.project_root),
            brainProvider: deps.explainBrainProvider ?? makeDefaultBrainProvider(),
            signal: controller.signal,
            onSpawn: (proc) => taskRegistry.attachProc(task.id, proc),
            ledgerBasePath: home ?? siltpokeRoot(),
            ledgerSessionId: task.id,
          },
        );
        // Honest cost. `explained` (Brain ran) and `cost_cap_exceeded` both
        // spent → record the real number. The ledger event fires ONLY on a run
        // that spent money THIS call: a `result.fromCache` explained re-served a
        // prior result for $0 (the命门 — never fabricate fresh spend).
        const finalCost =
          outcome.kind === "explained"
            ? outcome.usage.total_cost_usd ?? null
            : outcome.kind === "cost_cap_exceeded"
              ? outcome.costUsd
              : null;
        taskRegistry.finish(task.id, { costUsd: finalCost });
        // Ledger row is now written inside runExplain (cost-honesty batch A,
        // gated on ledgerBasePath above, session_id = task.id) — single shared
        // writer across CLI + both daemon callers. No inline appendUsageEvent
        // here: that would double-bill the detached path.
      } catch (e) {
        if (controller.signal.aborted) {
          if (taskRegistry.get(task.id)?.status === "running") taskRegistry.cancel(task.id);
        } else {
          taskRegistry.fail(task.id, e instanceof Error ? e.message : "unknown");
        }
      }
    })().catch(() => {
      // Belt (same as generate): a disk-failure throw from the error-path
      // registry write must never become an unhandledRejection on the daemon.
    });
    return c.json({ success: true, taskId: task.id, status: "running" }, 202);
  });

  // ── GET /api/repo-graph/explain/result (cached explanation fetch) ─────────
  // The detached explain no longer builds the Explanation in its response;
  // on terminal=done the client fetches it here. Reads the cached explanation
  // (resolved-node-keyed, the same key runExplain writes under) + builds the
  // Explanation via buildExplanation (the retained function, wired back).
  // 404 when no cached explanation exists — an honest "no result".
  app.get("/api/repo-graph/explain/result", async (c) => {
    const target = c.req.query("target");
    if (!target) return c.json({ success: false, error: "target query param required" }, 400);
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const graph = await readGraph(active.storage_dir);
    const queryIndex = await readQueryIndex(active.storage_dir);
    const resolution = resolveTarget(target, graph, buildSymbolTable(graph, queryIndex));
    const resolvedKey = resolution.kind === "found" ? cacheKey(resolution.node.nodeId) : cacheKey(target);
    const cached = await readExplanation(active.project_root, resolvedKey);
    if (!cached) return c.json({ success: false, error: "no_explanation" }, 404);
    const meta = await readMeta(active.storage_dir);
    const overlay = await loadOverlay(active.project_root);
    const projection = meta ? projectArchitecture(graph, overlay, meta) : null;
    // `fresh` is a client-supplied hint (the tab that fired a fresh generate
    // passes fresh=true; a reconnecting tab can't know → defaults false).
    const fresh = c.req.query("fresh") === "true";
    return c.json({
      success: true,
      data: buildExplanation(cached, target, fresh, projection),
      error: null,
    });
  });

  // ── GET /api/repo-graph/cache-state (legacy; superseded by /explain) ──────
  app.get("/api/repo-graph/cache-state", async (c) => {
    const target = c.req.query("target");
    if (!target) return c.json({ success: false, error: "target query param required" }, 400);
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const fingerprints = await readFingerprints(active.storage_dir);
    const state = await deriveCacheState(target, active.project_root, fingerprints);
    return c.json({
      success: true,
      data: { target, state: state.state, reason: state.reason },
      error: null,
    });
  });

  // ── GET /api/repo-graph/cascade (legacy; reconciled to /explain) ─────────
  app.get("/api/repo-graph/cascade", async (c) => {
    const subdir = c.req.query("subdir");
    if (!subdir) return c.json({ success: false, error: "subdir query param required" }, 400);
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const fingerprints = await readFingerprints(active.storage_dir);
    const result = await cascadeStaleSubdir(subdir, active.project_root, fingerprints);
    return c.json({ success: true, data: { subdir, ...result }, error: null });
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Map a file path → count of its symbol nodes (non-"file" nodes share path). */
function symbolCounts(graph: RepoGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.type === "file") continue;
    counts.set(node.path, (counts.get(node.path) ?? 0) + 1);
  }
  return counts;
}

/**
 * Per-file count of FUNCTION-type nodes (methods included — they are function
 * nodes). Mirrors `symbolCounts` but gated on `type === "function"` — the SAME
 * determination the `/symbols` endpoint exposes as `kind` (`kind: n.type`), so the
 * file-row "N fns" badge can never disagree with the function leaves the tree
 * expands (one notion of "function", not two — cf. the A/B shared-bucketer lesson).
 * Consume-time over the already-indexed graph; no schema change, no re-index.
 */
function functionCounts(graph: RepoGraph): Map<string, number> {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.type !== "function") continue;
    counts.set(node.path, (counts.get(node.path) ?? 0) + 1);
  }
  return counts;
}

/** Import edges between files that both live in the given subdir. */
function computeIntraEdges(
  graph: RepoGraph,
  filePaths: Set<string>,
  basenameByPath: Map<string, string>,
): Array<{ source: string; target: string }> {
  const out: Array<{ source: string; target: string }> = [];
  // `imports` edges target a raw import string, not a resolved node id,
  // so intra-subdir resolution is best-effort: only emit when the import string
  // resolves (by basename) to another file in this subdir. Endpoints are emitted
  // as full PATHS so the renderer can key file nodes uniquely (two same-basename
  // files no longer collide on one node id).
  for (const edge of graph.edges) {
    if (edge.type !== "imports") continue;
    const m = /^file:([^:]+):$/.exec(edge.source);
    if (!m) continue;
    const sourcePath = m[1]!;
    if (!filePaths.has(sourcePath)) continue;
    const targetBase = basenameOf(edge.target).replace(/\.(ts|tsx|js|jsx)$/, "");
    for (const [path, base] of basenameByPath) {
      if (path === sourcePath) continue;
      if (base.replace(/\.(ts|tsx|js|jsx)$/, "") === targetBase) {
        out.push({ source: sourcePath, target: path });
        break;
      }
    }
  }
  return out;
}

function nodeSignature(graph: RepoGraph, nodeId: string): string {
  return graph.nodes.find((n) => n.id === nodeId)?.signature ?? "";
}

function nodeLine(graph: RepoGraph, nodeId: string): number {
  return graph.nodes.find((n) => n.id === nodeId)?.lineRange[0] ?? 0;
}

/** CacheState enum → data-contract explainState string. */
function cacheStateToContract(state: string): "valid" | "stale" | "none" {
  if (state === "Cached") return "valid";
  if (state === "Stale") return "stale";
  return "none";
}

/** Extract the source file path embedded in a target node id / scope string. */
export function fileFromNodeId(target: string): string | null {
  const m = /^[^:]+:([^:]+):/.exec(target);
  if (m) return m[1]!;
  // bare path scope (no "kind:" prefix) — strip a trailing slash for subdirs.
  if (target.includes("/")) return target.replace(/\/+$/, "");
  return null;
}

/** Plain-language error for a non-"explained" runExplain outcome. */
function explainOutcomeError(outcome: ExplainOutcome): string {
  switch (outcome.kind) {
    case "not_found":
      return `Target not found: ${outcome.target}`;
    case "ambiguous":
      return "Target is ambiguous — qualify it (path or kind:name).";
    case "pre_check_failed":
      return outcome.message;
    case "cost_cap_exceeded":
      return `Explain aborted: cost cap exceeded ($${outcome.costUsd.toFixed(3)}).`;
    default:
      return "Explain failed.";
  }
}

/**
 * A trace node id is the canonical graph id `kind:path:name`
 * (e.g. `function:src/x.ts:foo`); resolveTarget expects the `path:name` form.
 * Strip the kind prefix so the trace card's node id resolves. Non-matching
 * ids (e.g. the synthetic `unres:…` tail) pass through unchanged.
 */
function traceTargetForResolve(node: string): string {
  const m = /^(?:function|class|module|symbol):(.+):([^:]+)$/.exec(node);
  return m ? `${m[1]}:${m[2]}` : node;
}

/**
 * resolveTarget-friendly target for a trace node's grounded purpose. A normal
 * node resolves to itself; an UNRESOLVABLE tail (`unres:<parentId>:<callee>`)
 * resolves to its PARENT — static analysis can't link the dynamic call, but we
 * CAN read the parent's body to explain what that hop does. The parent id
 * is everything between `unres:` and the trailing `:<callee>` segment.
 */
function purposeResolveTarget(node: string): string {
  if (node.startsWith("unres:")) {
    const rest = node.slice("unres:".length);
    const lastColon = rest.lastIndexOf(":");
    const parentId = lastColon > 0 ? rest.slice(0, lastColon) : rest;
    return traceTargetForResolve(parentId);
  }
  return traceTargetForResolve(node);
}

/**
 * A trace node's grounded purpose: the explanation's lead paragraph + a
 * citation to the function's own location (the body we read to ground it).
 * Falls back to the first markdown citation if the node line is unknown.
 */
function purposeOf(
  markdown: string,
  graph: RepoGraph,
  nodeId: string,
): { text: string; cite: string } {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const cite = node
    ? `${node.path}:${node.lineRange[0]}`
    : (parseCitations(markdown)[0]?.ref ?? "");
  return { text: firstParagraph(markdown), cite };
}

/** First non-heading, non-empty paragraph of the explanation markdown. */
export function firstParagraph(md: string): string {
  const blocks = md.split(/\n{2,}/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block || block.startsWith("#") || block.startsWith("💡")) continue;
    return block.replace(/\s+/g, " ").trim();
  }
  return md.trim().split(/\n/)[0]?.trim() ?? "";
}

/** Parse `[path:line]` / `path:line` evidence refs out of the markdown. */
export function parseCitations(md: string): Array<{ ref: string; text: string }> {
  const out: Array<{ ref: string; text: string }> = [];
  const seen = new Set<string>();
  const re = /\[?([\w./-]+\.[A-Za-z]+):(\d+)\]?/g;
  let m: RegExpExecArray | null = re.exec(md);
  while (m !== null) {
    const ref = `${m[1]}:${m[2]}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      out.push({ ref, text: "" });
    }
    if (out.length >= 8) break;
    m = re.exec(md);
  }
  return out;
}

/** Cached explanation (ExplainResult) → data-contract `Explanation` (the modal
 * payload). Takes the bare `ExplainResult` (markdown + meta) — all this
 * needs — so both a fresh runExplain outcome AND a `readExplanation` cache read
 * (the reconnect path) can build it. (Was `Extract<ExplainOutcome,…>` previously.) */
function buildExplanation(
  result: ExplainResult,
  target: string,
  fresh: boolean,
  projection: ArchitectureProjection | null,
): Record<string, unknown> {
  const md = result.markdown;
  const file = fileFromNodeId(target) ?? target;
  // Keyspace bucket id; "" (no projection / unbucketed) matches no edges —
  // honest-empty depends/used, same as the old wrong-id behavior at worst.
  const subId = projection ? (bucketIdOfPath(projection.subdirs, file) ?? "") : "";
  const dependsOn = projection
    ? projection.edges.filter((e) => e.source === subId).map((e) => ({ id: e.target, weight: e.weight }))
    : [];
  const usedBy = projection
    ? projection.edges.filter((e) => e.target === subId).map((e) => ({ id: e.source, weight: e.weight }))
    : [];
  return {
    target,
    route: `/siltpoke-explain?target=${encodeURIComponent(target)}`,
    title: basenameOf(file),
    grounded: result.meta.evidence_score,
    fresh,
    lead: firstParagraph(md),
    dependsOn,
    usedBy,
    citations: parseCitations(md),
  };
}

/** Re-export for the SSR shell to bootstrap without a second request. */
export type { ArchitectureProjection };
