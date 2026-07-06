// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { Hono } from "hono";
import { mkdirSync, existsSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { acquireLock, releaseLock, type LockHandle } from "../utils/process-lock";
import { atomicWrite } from "../utils/atomic-write";
import { mountHooksRoute } from "./routes/hooks";
import { mountVersionRoute } from "./routes/version";
import { mountDashboardRoutes } from "./routes/dashboard";
import { mountChatRoutes, type ChatAnchorRef, type BudgetSignal, type QuietHoursSignal } from "./routes/chat";
import { resolveRepoByHash } from "../repo-graph/repo-registry";
import { makeDefaultSourceProvider } from "../explain/providers";
import { resolveAnchorContext, type ResolveAnchorResult } from "../chat/anchor-context";
import { mountFactsRoutes } from "./routes/facts";
import { mountMemoryLogRoute } from "./routes/memory-log";
import { readMemory, writeMemory } from "../memory/memory";
import { extractDurableFacts } from "../memory/extract-facts";
import { ensureFactKinds } from "../memory/ensure-fact-kinds";
import { mountStaticRoutes, ensureClientBundle } from "../web/routes/static";
import { mountPreviewRoutes, loadDefaultRegistry } from "../web/routes/preview";
import { mountHomeRoutes } from "../web/routes/home";
import { mountMemoryRoutes } from "../web/routes/memory";
import { mountRepoSummaryRoute } from "./routes/repo-summary";
import { mountChatWebRoutes } from "../web/routes/chat";
import { mountCriticRoutes } from "../web/routes/critic";
import { mountTimelineRoutes } from "../web/routes/timeline";
import { mountTracesRoutes as mountTracesApiRoutes } from "./routes/traces";
import { mountTraceWebRoutes } from "../web/routes/traces";
import { mountCritiqueRoutes } from "./routes/critique.tsx";
import { mountExplainRoutes } from "./routes/explain.tsx";
import { mountRepoGraphRoutes } from "./routes/repo-graph.tsx";
import { mountFsRoutes } from "./routes/fs";
import { mountFeedbackRoutes } from "./routes/feedback";
import { mountRubricApiRoutes } from "./routes/rubric";
import { mountPreferenceLogApiRoutes } from "./routes/preference-log";
import { mountFewShotApiRoutes } from "./routes/few-shot";
import { mountRepoMemoryApiRoutes } from "./routes/repo-memory";
import { mountBrainHealthRoute } from "./routes/brain-health";
import { mountDaemonHealthRoute } from "./routes/daemon-health";
import { mountRubricRoutes } from "../web/routes/rubric";
import { mountPreferenceLogRoutes } from "../web/routes/preference-log";
import { mountFewShotRoutes } from "../web/routes/few-shot";
import { mountRepoMemoryRoutes } from "../web/routes/repo-memory";
import { mountRepoGraphWebRoutes } from "../web/routes/repo-graph";
import { openIndex } from "../chat/fts5-index";
import { recoverIndex } from "../chat/recovery";
import { loadBudgetConfig } from "../state/budget-config";
import { loadQuietHoursConfig } from "../state/quiet-hours";
import { loadDailyRollup } from "../state/usage";
import { evaluateChatSendGate } from "./routes/chat-send-gate";
import { handleStopHook as defaultHandleStopHook } from "../hooks/handle-stop";
import type { HookEvent } from "../router/router";
import { startDecayTick } from "./petTick";
import { runRetention } from "../observability/retention";
import { TaskRegistry } from "./task-registry";

export interface DaemonOptions {
  port: number;
  hostname: string;
  lockPath: string;
  pidPath: string;
  markerDir: string;
  secret: string;
  homeBase?: string;
  projectCwd?: string;
  handleStopHook?: (event: HookEvent) => Promise<unknown>;
  /**
   * Path to the legacy `report.pid` file. When set and the file
   * exists, startDaemon will SIGTERM the holder before binding the port to
   * avoid EADDRINUSE during the migration. Defaults to
   * `~/.siltpoke/report.pid`. Eviction is skipped when `port === 0`
   * (ephemeral test ports never collide with the legacy server).
   */
  legacyPidPath?: string;
  /**
   * Injectable process-exit fn for the SIGTERM/SIGINT shutdown handler.
   * Defaults to `process.exit`. Tests pass a spy so the signal path can be
   * exercised without killing the test runner.
   */
  exit?: (code: number) => never | void;
}

export interface DaemonHandle {
  server: ReturnType<typeof Bun.serve>;
  lock: LockHandle;
  pidPath: string;
  chatIndex?: { close(): void };
  /**
   * Cleanup fn returned by `startDecayTick` (clearIntervals the pet-decay
   * timer). Captured so `stopDaemon` can cancel it — previously discarded,
   * which left the timer pinning the event loop on shutdown.
   */
  stopDecay: () => void;
  /** Handle for the 24h trace-retention interval, cleared on shutdown. */
  retentionTimer: ReturnType<typeof setInterval>;
  /**
   * Bug B: the shared TaskRegistry for the daemon's generate/arch routes.
   * stopDaemon calls stopWatchers() so the finalize-watcher poll intervals
   * cannot pin the event loop after the daemon shuts down.
   */
  taskRegistry?: { stopWatchers(): void };
}

/**
 * Helper — call before Bun.serve to evict any legacy process still
 * holding the dashboard port. Mitigates the migration race documented in
 * the PQ2 risk register: if a user has the old `report.ts` server running
 * on :9876 when they upgrade and start siltpoked, the daemon's `Bun.serve`
 * would otherwise throw EADDRINUSE.
 */
export async function evictPriorPortHolder(opts: {
  legacyPidPath: string;
  hostname: string;
  port: number;
}): Promise<void> {
  const { legacyPidPath, hostname, port } = opts;
  if (!existsSync(legacyPidPath)) return;
  let priorPid: number;
  try {
    priorPid = Number(readFileSync(legacyPidPath, "utf8").trim());
  } catch {
    return;
  }
  if (!Number.isFinite(priorPid) || priorPid <= 0) return;

  // Liveness check.
  let alive = false;
  try {
    process.kill(priorPid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (!alive) return;

  // Don't SIGTERM ourselves (defensive).
  if (priorPid === process.pid) return;

  process.stderr.write(
    `[siltpoked] evicting prior :${port} holder pid=${priorPid} (legacy report.pid)\n`,
  );
  try {
    process.kill(priorPid, "SIGTERM");
  } catch {
    // Already dead between liveness check and SIGTERM — fine.
  }

  // Poll until the port is free or we hit the deadline.
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${hostname}:${port}/api/ping`, {
        signal: AbortSignal.timeout(50),
      });
      if (!r.ok) break;
    } catch {
      // ECONNREFUSED → port free.
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const lock = acquireLock(opts.lockPath, {
    version: "0.1.1",
    heartbeatMs: 30_000,
  });

  // Evict any legacy process still holding the dashboard port BEFORE
  // calling Bun.serve. Skip when `port === 0`: ephemeral test ports never
  // collide with the legacy server.
  if (opts.port !== 0) {
    const legacyPidPath =
      opts.legacyPidPath ?? join(homedir(), ".siltpoke", "report.pid");
    await evictPriorPortHolder({
      legacyPidPath,
      hostname: opts.hostname,
      port: opts.port,
    });
  }

  mkdirSync(opts.markerDir, { recursive: true });
  atomicWrite(opts.pidPath, String(process.pid));

  const app = new Hono();
  const handleStopHook =
    opts.handleStopHook ?? ((e: HookEvent) => defaultHandleStopHook(e));
  mountHooksRoute(app, {
    markerDir: opts.markerDir,
    secret: opts.secret,
    handleStopHook,
  });
  mountVersionRoute(app);
  // homeBase resolution order: caller-supplied opts.homeBase wins; otherwise
  // honor SILTPOKE_HOME env (e.g. Playwright sets `.playwright-tmp/siltpoke`
  // for test isolation); fall back to ~/.siltpoke as the production default.
  // Pattern matches src/web/routes/home.tsx + src/cli/daemon.ts.
  const homeBase =
    opts.homeBase ??
    process.env.SILTPOKE_HOME ??
    join(process.env.HOME ?? "", ".siltpoke");

  // One-time idempotent backfill of fact `kind` (style/profile)
  // so the Brain recall sees persisted tags. No-op once tagged; fail-open (a
  // backfill error must never block daemon start).
  await ensureFactKinds(homeBase).catch(() => {});

  // Home (`src/web/routes/home.tsx`) owns GET /. The dashboard mount below
  // only registers the pet-action + config API (/api/ping, /api/action,
  // /api/config); its legacy GET /dashboard report page is retired.
  mountHomeRoutes(app, { homeBase });

  mountDashboardRoutes(app, {
    homeBase,
    projectCwd: opts.projectCwd,
  });

  const chatIndex = openIndex(homeBase);
  await recoverIndex(homeBase, chatIndex).catch((err) => {
    process.stderr.write(
      `[siltpoked] chat-index recovery failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
  // Test seam: when SILTPOKE_TEST_MOCK_STREAM=1 the chat route bypasses the
  // real `claude -p` subprocess and returns a canned SSE reply. This lets
  // Playwright e2e tests run without a live ANTHROPIC_API_KEY.
  const mockStreamFactory =
    process.env.SILTPOKE_TEST_MOCK_STREAM === "1"
      ? async function* fakeStream() {
          yield { type: "message_start" as const, message_id: "test-id", model: "mock" };
          yield { type: "content_block_delta" as const, text: "Mock reply from test daemon." };
          yield {
            type: "message_stop" as const,
            usage: { input_tokens: 1, output_tokens: 5 },
            full_text: "Mock reply from test daemon.",
          };
        }
      : undefined;
  // Resolve a viewed repo-graph node (scoped to its project by
  // proj_hash) into Brain-ready anchor context for the floating chat. Maps
  // proj_hash → on-disk graph storage + a project-rooted source provider, then
  // delegates to the pure resolver. no_graph when the repo isn't indexed.
  const resolveAnchor = async (anchor: ChatAnchorRef): Promise<ResolveAnchorResult> => {
    const loc = await resolveRepoByHash(anchor.proj_hash, { home: homeBase });
    if (!loc || !loc.project_root) {
      return {
        kind: "no_graph",
        message: "No indexed repo-graph for this project. Run `/siltpoke-index` first.",
      };
    }
    // strip proj_hash → the AnchorTarget (node_id OR {name, path, node_type})
    const { proj_hash: _ph, ...target } = anchor;
    return resolveAnchorContext({
      target,
      graphStorageDir: loc.storage_dir,
      sourceProvider: makeDefaultSourceProvider(loc.project_root),
    });
  };
  // Cheaply map proj_hash → fingerprints.json storage dir.
  // Used by the stale-fingerprint pre-flight check in the chat route.
  const getGraphStorageDir = async (projHash: string): Promise<string | null> => {
    const loc = await resolveRepoByHash(projHash, { home: homeBase });
    return loc?.storage_dir ?? null;
  };

  // Budget + quiet-hours gate for chat sends.
  // Checks budget (hard-stop only) and quiet-hours on every send. Returns
  // a blocked signal or null (pass). Fail-open: any error → null (no block).
  // The caller (chat route) also wraps in try/catch as a belt-and-suspenders
  // fail-open guard, so an error here is doubly safe.
  const checkSendGate = async (): Promise<BudgetSignal | QuietHoursSignal | null> => {
    const nowDate = new Date();
    // Load the gate inputs from disk, then delegate to the pure (unit-tested)
    // evaluateChatSendGate so the production path IS the tested composition.
    const quietConfig = await loadQuietHoursConfig(homeBase);
    const budgetConfig = await loadBudgetConfig(homeBase);
    const rollup = await loadDailyRollup(homeBase, nowDate, budgetConfig.resetAtMinutes);
    return evaluateChatSendGate(budgetConfig, rollup, quietConfig, nowDate);
  };

  mountChatRoutes(app, {
    homeBase,
    index: chatIndex,
    streamFactory: mockStreamFactory,
    resolveAnchor,
    getGraphStorageDir,
    checkSendGate,
    // Recall: inject active user-facts into the chat system prompt
    // (same store the /memory page reads).
    readMemory,
    // memory work — real-time chat capture: persist "记住 X" facts told to
    // the pet in chat to the same store the facts route writes to.
    writeMemory,
    // Conversational auto-capture — distill durable user-facts from plain chat
    // (no explicit marker) via one ledgered Haiku call, gated by the code
    // pre-filter (looksLikeFactStatement) inside the route.
    extractFacts: extractDurableFacts,
  });

  // Facts HTTP API (list / approve / retire).
  // `parseFn` defaults to the real parseMemoryEdit inside the route;
  // `checkSendGate` reuses the chat composer's budget/quiet-hours gate so the
  // interactive /parse Brain call honors the same pause semantics.
  mountFactsRoutes(app, {
    homeBase,
    secret: opts.secret,
    readMemory,
    writeMemory,
    checkSendGate,
  });

  // Unified memory event stream.
  mountMemoryLogRoute(app, {
    homeBase,
    secret: opts.secret,
    readMemory,
  });

  // Memory timeline screen (SSR, real data).
  mountMemoryRoutes(app, { homeBase, secret: opts.secret });

  // Active-repos card — on-demand "what this repo is about" blurb (gated Brain call).
  mountRepoSummaryRoute(app, { home: homeBase, secret: opts.secret });

  // Chat screen (SSE consumer; chat-stream island).
  mountChatWebRoutes(app);

  // Critic observability page (Brain hook telemetry).
  mountCriticRoutes(app, { homeBase });

  // Merged History+Traces master/detail page.
  // Unlisted until the nav entries swap over + old-URL redirects are added.
  mountTimelineRoutes(app, { homeBase });

  // Trace viewer: API + SSR routes.
  mountTracesApiRoutes(app, { homeBase });
  mountTraceWebRoutes(app, { homeBase });

  // Critique permalink: API + SSR routes.
  mountCritiqueRoutes(app, { homeBase, secret: opts.secret });

  // /siltpoke-explain: JSON + SSR + SSE routes.
  // `cwd` is intentionally used here (not homeBase) since explanations
  // live in {cwd}/.siltpoke/explanations/ — they're per-project, not global.
  mountExplainRoutes(app, { cwd: process.cwd(), secret: opts.secret });

  // /repo-graph: subgraph + search JSON API.
  // SSR shell `GET /repo-graph` lives in src/web/routes/repo-graph;
  // this mount only registers the two `/api/repo-graph/*` JSON endpoints.
  // Bug B: create the TaskRegistry here so stopDaemon can call stopWatchers()
  // on it, preventing finalize-watcher poll timers from pinning the event loop.
  const taskRegistry = new TaskRegistry(homeBase);
  mountRepoGraphRoutes(app, { cwd: process.cwd(), secret: opts.secret, home: homeBase, taskRegistry });
  mountFsRoutes(app, { secret: opts.secret, home: homeBase });

  // Feedback route: POST /api/critiques/:id/feedback.
  mountFeedbackRoutes(app);

  // Rubric / preference-log / few-shot / repo-memory API + SSR routes.
  mountRubricApiRoutes(app);
  mountPreferenceLogApiRoutes(app);
  mountFewShotApiRoutes(app);
  mountRepoMemoryApiRoutes(app);
  // Brain health JSON for the dashboard ephemeral strip.
  mountBrainHealthRoute(app, { homeBase });
  // Daemon build-staleness signal for banner + doctor.
  mountDaemonHealthRoute(app);
  mountRubricRoutes(app);
  mountPreferenceLogRoutes(app);
  mountFewShotRoutes(app);
  mountRepoMemoryRoutes(app);

  // /repo-graph SSR shell + Alpine island hydration.
  mountRepoGraphWebRoutes(app, { cwd: process.cwd(), secret: opts.secret });

  // Web sub-app: static assets + dev preview (env-gated).
  // Build the client island bundle if it's missing (gitignored artifact — a
  // fresh clone/install ships without it, which would leave the dashboard
  // rendered-but-dead). Skip for ephemeral test daemons (port 0). Fails open.
  if (opts.port !== 0) {
    await ensureClientBundle();
  }
  mountStaticRoutes(app);
  const previewEnabled = process.env.SILTPOKE_ENV !== "production";
  const previewRegistry = previewEnabled
    ? await loadDefaultRegistry()
    : undefined;
  mountPreviewRoutes(app, { registry: previewRegistry });

  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    // Bun's default idleTimeout is 10s. Some endpoints still await an LLM
    // subprocess synchronously: the lazy Haiku narrative ~30-60s and the internal
    // POST /trace/purpose grounding call. (arch/generate + /explain are now
    // DETACHED — they return {taskId} in ms and run in a background promise, so
    // this timeout no longer bounds them; the wall-clock guard does.) 240s
    // (Bun's hard max is 255s) keeps the remaining synchronous LLM handlers alive.
    idleTimeout: 240,
    fetch: app.fetch,
  });

  // Start background decay tick (10-min interval). Capture the
  // cleanup fn so stopDaemon can clearInterval it — leaving it live pinned the
  // event loop and made SIGTERM hang forever (zombie daemon).
  const stopDecay = startDecayTick({ homeBase });

  // Daily trace retention eviction (30-day default, 500MB cap).
  const tracesDir = join(homeBase, "traces");
  const retentionTimer = setInterval(() => {
    runRetention({ dir: tracesDir, retentionDays: 30, maxStorageMB: 500 });
  }, 24 * 60 * 60 * 1000);

  const handle: DaemonHandle = {
    server,
    lock,
    pidPath: opts.pidPath,
    chatIndex,
    stopDecay,
    retentionTimer,
    taskRegistry,
  };

  // stopDaemon alone is exit-free (so unit tests can call it without killing
  // the test runner). The signal handler wraps it and forces process.exit so the
  // daemon actually terminates instead of lingering on stray timers.
  const shutdown = makeShutdownHandler(handle, opts.exit ?? process.exit);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return handle;
}

/**
 * Build the signal-handler closure: tear the daemon down via `stopDaemon`, then
 * force-exit. The `exit` fn is injectable for deterministic tests (default
 * `process.exit`). Extracted + exported so the SIGTERM path is unit-testable
 * without spawning a real process.
 */
export function makeShutdownHandler(
  handle: DaemonHandle,
  exit: (code: number) => never | void = process.exit,
): () => Promise<void> {
  return async () => {
    try {
      await stopDaemon(handle);
    } finally {
      exit(0);
    }
  };
}

export async function stopDaemon(handle: DaemonHandle): Promise<void> {
  // Cancel background timers FIRST so nothing pins the event loop.
  try { handle.stopDecay(); } catch { /* best effort */ }
  try { clearInterval(handle.retentionTimer); } catch { /* best effort */ }
  // Bug B: stop finalize-watcher poll intervals so they cannot pin the event loop.
  try { handle.taskRegistry?.stopWatchers(); } catch { /* best effort */ }
  handle.server.stop(true);
  if (handle.chatIndex) {
    try { handle.chatIndex.close(); } catch { /* best effort */ }
  }
  releaseLock(handle.lock);
  if (existsSync(handle.pidPath)) {
    try { unlinkSync(handle.pidPath); } catch { /* best effort */ }
  }
}
