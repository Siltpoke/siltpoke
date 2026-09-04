// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { type ResolveAnchorResult, resolveAnchorContext } from "../chat/anchor-context";
import { type ResolveCritiqueResult, resolveCritiqueContext } from "../chat/critique-context";
import { openIndex } from "../chat/fts5-index";
import { recoverIndex } from "../chat/recovery";
import { loadTracesRetentionConfig } from "../config/traces-retention-config";
import { makeDefaultSourceProvider } from "../explain/providers";
import { handleStopHook as defaultHandleStopHook } from "../hooks/handle-stop";
import { siltpokeRoot } from "../installer/paths";
import { ensureFactKinds } from "../memory/ensure-fact-kinds";
import { extractDurableFacts } from "../memory/extract-facts";
import { GLOBAL_ONLY, type ProjectScope, readMemory, writeMemory } from "../memory/memory";
import { migrateFactsToGlobal } from "../memory/migrate-facts-to-global";
import { runRetention } from "../observability/retention";
import { type QuizSessionState, readQuizState, writeQuizState } from "../quiz/index";
import { deriveModuleGraph } from "../repo-graph/module-graph";
import { isValidProjHash, resolveRepoByHash } from "../repo-graph/repo-registry";
import { readGraph } from "../repo-graph/store";
import type { HookEvent } from "../router/router";
import { loadBudgetConfig } from "../state/budget-config";
import { loadQuietHoursConfig } from "../state/quiet-hours";
import { loadDailyRollup } from "../state/usage";
import { atomicWrite } from "../utils/atomic-write";
import { acquireLock, type LockHandle, LockHeldError, releaseLock } from "../utils/process-lock";
// mountSettingsRoutes import dropped 2026-08-06 with its mount (see the note below).
import { mountChatWebRoutes } from "../web/routes/chat";
import { mountCriticRoutes } from "../web/routes/critic";
import { mountFewShotRoutes } from "../web/routes/few-shot";
import { mountHomeRoutes } from "../web/routes/home";
import { mountMemoryRoutes } from "../web/routes/memory";
import { setNavAvailability } from "../web/routes/nav";
import { mountPreferenceLogRoutes } from "../web/routes/preference-log";
import { loadDefaultRegistry, mountPreviewRoutes } from "../web/routes/preview";
import { mountRepoGraphWebRoutes } from "../web/routes/repo-graph";
import { mountRepoMemoryRoutes } from "../web/routes/repo-memory";
import { mountRubricRoutes } from "../web/routes/rubric";
import { ensureClientBundle, mountStaticRoutes } from "../web/routes/static";
import { mountTimelineRoutes } from "../web/routes/timeline";
import { mountTraceWebRoutes } from "../web/routes/traces";
import { hostAllowlistMiddleware } from "./host-guard";
import { startDecayTick } from "./petTick";
import { mountBrainRoutes } from "./routes/brain";
import { mountBrainHealthRoute } from "./routes/brain-health";
import { type BudgetSignal, type ChatAnchorRef, mountChatRoutes, type QuietHoursSignal } from "./routes/chat";
import { evaluateChatSendGate } from "./routes/chat-send-gate";
import { mountCritiqueRoutes } from "./routes/critique.tsx";
import { mountDaemonHealthRoute } from "./routes/daemon-health";
import { mountDashboardRoutes } from "./routes/dashboard";
import { mountExplainRoutes } from "./routes/explain.tsx";
import { mountFactsRoutes } from "./routes/facts";
import { mountFeedbackRoutes } from "./routes/feedback";
import { mountFewShotApiRoutes } from "./routes/few-shot";
import { mountFsRoutes } from "./routes/fs";
import { mountHooksRoute } from "./routes/hooks";
import { mountMemoryLogRoute } from "./routes/memory-log";
import { mountPreferenceLogApiRoutes } from "./routes/preference-log";
import { mountRepoGraphRoutes } from "./routes/repo-graph.tsx";
import { mountRepoMemoryApiRoutes } from "./routes/repo-memory";
import { mountRepoSummaryRoute } from "./routes/repo-summary";
import { mountRubricApiRoutes } from "./routes/rubric";
import { mountSeenRoutes } from "./routes/seen.tsx";
import { mountTracesRoutes as mountTracesApiRoutes } from "./routes/traces";
import { mountVersionRoute } from "./routes/version";
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
 * Thrown when `Bun.serve` fails with EADDRINUSE **and** a healthy siltpoked
 * daemon is already answering on the port. Signals "someone healthy already
 * owns :9876, step down cleanly" rather than a crash — the CLI entrypoint
 * catches this and exits 0 so launchd `KeepAlive` doesn't crash-flap the
 * newcomer against the incumbent.
 */
export class DaemonAlreadyRunningError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`siltpoked already running on :${port}`);
    this.name = "DaemonAlreadyRunningError";
    this.port = port;
  }
}

/** True if a healthy siltpoked answers `/api/ping` with 2xx on the port. */
async function isPortHealthy(hostname: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${hostname}:${port}/api/ping`, {
      signal: AbortSignal.timeout(250),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** True if `err` is (or wraps) an EADDRINUSE port collision from `Bun.serve`. */
function isAddrInUse(err: unknown, port: number): boolean {
  if (port === 0) return false;
  // Bun surfaces the collision as `err.code === "EADDRINUSE"` with a message
  // like "Failed to start server. Is port N in use?" — match on either.
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  if (code === "EADDRINUSE") return true;
  return (
    err instanceof Error &&
    /EADDRINUSE|address already in use|is port .* in use/i.test(err.message)
  );
}

/**
 * EADDRINUSE safety net for `Bun.serve`. Eviction clears prior holders we know
 * about (via pid files), but a genuinely simultaneous race — or a live daemon
 * whose stale lock we just stole — can still lose the bind. Rather than let the
 * raw throw crash-flap the process under launchd `KeepAlive`, this tears down
 * the lock + pidfile we already grabbed, then returns the error to surface: a
 * typed `DaemonAlreadyRunningError` when a HEALTHY siltpoked already owns the
 * port (the CLI turns that into exit 0), otherwise the original error unchanged.
 */
async function resolveBindFailure(
  err: unknown,
  ctx: {
    lock: LockHandle;
    pidPath: string;
    hostname: string;
    port: number;
    chatIndex?: { close(): void };
    taskRegistry?: { stopWatchers(): void };
  },
): Promise<unknown> {
  // Tear down everything startDaemon opened before Bun.serve — the lock, the
  // pidfile, the FTS5 chat index handle, and the TaskRegistry watchers — so a
  // failed bind never leaks an fd or a poll interval. (In CLI use the process
  // exits right after, but tests call startDaemon in-process and hit this path.)
  releaseLock(ctx.lock);
  if (existsSync(ctx.pidPath)) {
    try { unlinkSync(ctx.pidPath); } catch { /* best effort */ }
  }
  try { ctx.chatIndex?.close(); } catch { /* best effort */ }
  try { ctx.taskRegistry?.stopWatchers(); } catch { /* best effort */ }
  if (isAddrInUse(err, ctx.port) && (await isPortHealthy(ctx.hostname, ctx.port))) {
    return new DaemonAlreadyRunningError(ctx.port);
  }
  return err;
}

/**
 * Helper — call before Bun.serve to evict any prior process still holding the
 * dashboard port, whether it was recorded in the current-generation
 * `siltpoked.pid` or the legacy `report.pid`. BOTH spawn paths (launchd
 * autostart + `/siltpoke-dashboard` detached) write `siltpoked.pid`, so a
 * restart must evict a prior holder from either file — evicting only
 * `report.pid` (the original PQ2 migration mitigation) let two live daemons
 * race to bind :9876, and the loser crash-flapped under `KeepAlive`.
 */
export async function evictPriorPortHolder(opts: {
  pidPath: string;
  hostname: string;
  port: number;
}): Promise<void> {
  const { pidPath, hostname, port } = opts;
  if (!existsSync(pidPath)) return;
  let priorPid: number;
  try {
    priorPid = Number(readFileSync(pidPath, "utf8").trim());
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
    `[siltpoked] evicting prior :${port} holder pid=${priorPid} (${basename(pidPath)})\n`,
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

/**
 * Resolve a viewed critique into critique context for the floating
 * chat. Scopes memory to the critique's project (proj_hash → project_root),
 * falling back to GLOBAL_ONLY when the repo isn't resolvable.
 *
 * Exported (rather than an inline closure) so the security-critical part —
 * the `proj_hash` format guard — is directly unit-testable with injected
 * deps, instead of only reachable through a full `startDaemon` boot. `ref`
 * is UNTRUSTED request input (it rode `POST /api/chat`'s `critique_anchor`
 * field through `isValidCritiqueAnchor`'s TYPE-only check): format-validate
 * `proj_hash` HERE, before it reaches `resolveRepoByHash`'s path join —
 * same `isValidProjHash` guard the node-anchor path relies on downstream,
 * applied explicitly on this seam rather than implicitly inherited. A
 * malformed hash resolves to `critique_not_found` (→ the route's honest
 * `critique_gone` signal) — it must never throw.
 */
export async function resolveCritiqueAnchorImpl(
  ref: { proj_hash: string; critique_id: string },
  deps: {
    homeBase: string;
    resolveRepoByHash: typeof resolveRepoByHash;
    resolveCritiqueContext: typeof resolveCritiqueContext;
    now?: () => Date;
  },
): Promise<ResolveCritiqueResult> {
  if (!isValidProjHash(ref.proj_hash)) {
    return { kind: "critique_not_found", critique_id: ref.critique_id };
  }
  const loc = await deps.resolveRepoByHash(ref.proj_hash, { home: deps.homeBase });
  const memScope: ProjectScope = loc?.project_root ?? GLOBAL_ONLY;
  return deps.resolveCritiqueContext({
    critiqueId: ref.critique_id,
    homeBase: deps.homeBase,
    memScope,
    now: (deps.now ?? (() => new Date()))(),
  });
}

/**
 * Acquire the daemon singleton lock, resolving the "already running" collision
 * out-of-line (keeps startDaemon's cyclomatic complexity in check). In
 * production both spawn paths (launchd autostart + /siltpoke-dashboard detached)
 * share the one ~/.siltpoke/siltpoked.lock, so a re-setup / restart while a
 * daemon is up hits acquireLock's LockHeldError BEFORE Bun.serve — this, not
 * EADDRINUSE, is the routine collision. Decide via the PORT, not the lock: if a
 * healthy siltpoked already answers, throw the typed DaemonAlreadyRunningError
 * (CLI → exit 0) instead of letting the raw LockHeldError crash-flap the
 * newcomer under launchd KeepAlive. If the lock is held but nobody healthy is
 * serving (a wedged holder), rethrow — acquireLock only reclaims a lock whose
 * owner pid is dead, so recovering a hung-but-alive holder is out of scope
 * (captured as deferred work).
 */
async function acquireDaemonLock(opts: {
  lockPath: string;
  hostname: string;
  port: number;
}): Promise<LockHandle> {
  try {
    return acquireLock(opts.lockPath, { version: "0.1.1", heartbeatMs: 30_000 });
  } catch (err) {
    if (
      err instanceof LockHeldError &&
      opts.port !== 0 &&
      (await isPortHealthy(opts.hostname, opts.port))
    ) {
      throw new DaemonAlreadyRunningError(opts.port);
    }
    throw err;
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const lock = await acquireDaemonLock({
    lockPath: opts.lockPath,
    hostname: opts.hostname,
    port: opts.port,
  });

  // Evict any prior process still holding the dashboard port BEFORE calling
  // Bun.serve. Skip when `port === 0`: ephemeral test ports never collide.
  // Check BOTH the current-gen siltpoked.pid (written by every `siltpoked
  // start`, i.e. both the launchd autostart and the /siltpoke-dashboard detached
  // spawn) AND the legacy report.pid — a prior holder can live in either.
  if (opts.port !== 0) {
    const legacyPidPath =
      opts.legacyPidPath ?? join(siltpokeRoot(), "report.pid");
    for (const pidPath of [opts.pidPath, legacyPidPath]) {
      await evictPriorPortHolder({
        pidPath,
        hostname: opts.hostname,
        port: opts.port,
      });
    }
  }

  mkdirSync(opts.markerDir, { recursive: true });
  atomicWrite(opts.pidPath, String(process.pid));

  const app = new Hono();

  // DNS-rebinding guard — mounted FIRST so it gates the whole surface
  // (every route below, including SSE). `boundPort` is a box because
  // `opts.port` may be `0` (ephemeral test port); it's filled in with the
  // real bound port once `Bun.serve()` resolves below, and the middleware
  // closure reads it fresh per-request via `getBoundPort`.
  let boundPort = opts.port;
  const getBoundPort = () => boundPort;
  app.use("*", hostAllowlistMiddleware(getBoundPort));

  // Response compression — mounted SECOND, so it never compresses a response
  // the rebinding guard already rejected, and so it wraps every route below.
  //
  // Measured on `/knowledge` (2026-08-11, 1007 indexed documents): one load
  // shipped 755 KB across three assets with zero `Content-Encoding`, and the
  // server itself was never the cost (0.28s warm / 0.92s cold). gzip takes
  // that to ~160 KB: the SSR HTML alone goes 228 KB → 22 KB (90%), because
  // the page is mostly repeated `<a href=…>` rows whose long query strings
  // are exactly what a compressor eats for free. The client bundle goes
  // 499 KB → 134 KB and `tailwind.css` 22 KB → 4 KB.
  //
  // SSE is safe BY CONSTRUCTION, not by our own exclusion list: Hono gates on
  // `COMPRESSIBLE_CONTENT_TYPE_REGEX` (`hono/utils/compress`), whose `text/`
  // arm carries an explicit `(?!event-stream…)` negative lookahead — so the
  // chat stream (`routes/chat.ts`'s `text/event-stream`) never enters a
  // `CompressionStream` and never gets buffered into un-streamed chunks.
  // That claim is a live assertion, not a comment: see
  // `tests/daemon/compression.test.ts`, which drives a real SSE response
  // through this middleware and fails if it ever comes back encoded.
  //
  // NO `threshold` is passed, and that is deliberate rather than an omission.
  // Hono's `threshold` option is gated on `Content-Length` being present
  // (`compress/index.js`: `contentLength && Number(contentLength) < threshold`)
  // and Hono never sets that header — measured, not assumed: `c.json()` and
  // `c.text()` both come back with `content-length: null`. So passing a
  // threshold would install a knob that can never fire: a dead guard shipping
  // with a comment claiming it works, which is the exact defect family
  // `docs/lessons.md` catalogs. Every compressible content type is therefore
  // compressed regardless of size.
  //
  // That is the right trade here anyway. The responses a size gate would have
  // spared are tiny JSON replies where gzip costs microseconds, while the ones
  // it might have caught by accident are the ones that matter most — e.g.
  // `/api/knowledge/facets` is 75 KB of JSON and carries no `Content-Length`
  // either. `tests/daemon/compression.test.ts` pins the real behaviour
  // (small responses ARE encoded) so nobody later "fixes" a test that was
  // describing a threshold that never ran.
  app.use("*", compress());

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
  // for test isolation) via siltpokeRoot(); falls back to ~/.siltpoke as the
  // production default. Pattern matches src/web/routes/home.tsx + src/cli/daemon.ts.
  const homeBase = opts.homeBase ?? siltpokeRoot();

  // One-time idempotent backfill of fact `kind` (style/profile)
  // so the Brain recall sees persisted tags. No-op once tagged; fail-open (a
  // backfill error must never block daemon start).
  await ensureFactKinds(homeBase).catch(() => {});

  // One-time idempotent sweep of stranded user-level facts (style/profile) from
  // per-project slices into the cwd-independent global store. Runs AFTER
  // ensureFactKinds so kinds are backfilled before this classifies for routing.
  // Write-only-if-changed; fail-open (a sweep error must never block start).
  await migrateFactsToGlobal(homeBase).catch(() => {});

  // Home (`src/web/routes/home.tsx`) owns GET /. The dashboard mount below
  // only registers the pet-action + config API (/api/ping, /api/action,
  // /api/config); its legacy GET /dashboard report page is retired.
  mountHomeRoutes(app, { homeBase, secret: opts.secret });

  mountDashboardRoutes(app, {
    homeBase,
    projectCwd: opts.projectCwd,
    secret: opts.secret,
  });

  const chatIndex = openIndex(homeBase);
  await recoverIndex(homeBase, chatIndex)
    .then((stats) => {
      // A refused orphan prune is a real operational state, not a detail: rows
      // for deleted sessions are STILL searchable, and the reason we refused is
      // that session listing looked untrustworthy. Silently dropping this stat
      // is how the original orphan drift stayed invisible for 33 sessions.
      if (stats.orphan_prune_skipped !== null) {
        process.stderr.write(
          `[siltpoked] chat-index orphan prune skipped (${stats.orphan_prune_skipped}) — ${(stats.orphan_ratio * 100).toFixed(1)}% of indexed rows have no session on disk and remain searchable; verify ${homeBase}/chats\n`,
        );
      }
    })
    .catch((err) => {
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
        message: "No indexed repo-graph for this project. Open Code Map and pick this repo to index it.",
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

  // Quiz mode (Task 4) — proj_hash → module graph (getGraphStorageDir →
  // readGraph → deriveModuleGraph); null when the project has never been
  // indexed, which the chat route surfaces as a `quiz_unavailable` blocked
  // signal rather than quizzing against an empty graph.
  const loadModuleGraph = async (projHash: string) => {
    const dir = await getGraphStorageDir(projHash);
    if (!dir) return null;
    const graph = await readGraph(dir);
    return deriveModuleGraph(graph);
  };

  // Quiz mode (Task 4) — read/write the per-session quiz sidecar
  // (chats/<id>.quiz.json), bound to this daemon's homeBase.
  const quizStore = {
    read: (id: string) => readQuizState(homeBase, id),
    write: (id: string, s: QuizSessionState) => writeQuizState(homeBase, id, s),
  };

  // T3: map an anchor's proj_hash → its project_root path so the chat send path
  // can scope memory reads/writes to the anchored repo instead of the daemon's
  // own cwd (`/` under launchd). null (no indexed repo / no meta) → the route
  // falls back to GLOBAL_ONLY.
  const resolveProjectRootByHash = async (projHash: string): Promise<string | null> => {
    const loc = await resolveRepoByHash(projHash, { home: homeBase });
    return loc?.project_root ?? null;
  };

  // Resolve a viewed critique into critique context for the floating
  // chat (see resolveCritiqueAnchorImpl for the proj_hash format-guard
  // discipline). Binds the exported, unit-tested impl to this daemon's
  // homeBase + the real resolveRepoByHash / resolveCritiqueContext.
  const resolveCritiqueAnchor = async (ref: {
    proj_hash: string;
    critique_id: string;
  }): Promise<ResolveCritiqueResult> =>
    resolveCritiqueAnchorImpl(ref, { homeBase, resolveRepoByHash, resolveCritiqueContext });

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
    secret: opts.secret,
    index: chatIndex,
    streamFactory: mockStreamFactory,
    resolveAnchor,
    resolveCritiqueAnchor,
    getGraphStorageDir,
    resolveProjectRootByHash,
    checkSendGate,
    // Quiz mode (Task 4).
    loadModuleGraph,
    quizStore,
    // Recall: inject active user-facts into the chat system prompt
    // (same store the /memory page reads).
    readMemory,
    // memory work — real-time chat capture: persist  facts told to
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


  // Settings — review-brain selector (Slice C). API + SSR screen share the one
  // brain.roles config the /siltpoke-brain command writes.
  mountBrainRoutes(app, { homeBase, secret: opts.secret });

  // Chat screen (SSE consumer; chat-stream island).
  mountChatWebRoutes(app, { secret: opts.secret });

  // Critic observability page (Brain hook telemetry).
  mountCriticRoutes(app, { homeBase, secret: opts.secret });

  // Merged History+Traces master/detail page.
  // Unlisted until the nav entries swap over + old-URL redirects are added.
  mountTimelineRoutes(app, { homeBase, secret: opts.secret });

  // Trace viewer: API + SSR routes.
  mountTracesApiRoutes(app, { homeBase });
  mountTraceWebRoutes(app, { homeBase, secret: opts.secret });

  // Critique permalink: API + SSR routes.
  mountCritiqueRoutes(app, { homeBase, secret: opts.secret });

  // /siltpoke-explain: JSON + SSR + SSE routes.
  // Explanations live in {project_root}/.siltpoke/explanations/ — per-project,
  // not global — so the route resolves the requesting project per request
  // (via homeBase) instead of the `cwd` frozen at daemon boot (which froze to
  // `/` under launchd). `cwd` is kept only as the last-resort fallback.
  mountExplainRoutes(app, { homeBase, cwd: process.cwd(), secret: opts.secret });

  // /repo-graph: subgraph + search JSON API.
  // SSR shell `GET /repo-graph` lives in src/web/routes/repo-graph;
  // this mount only registers the two `/api/repo-graph/*` JSON endpoints.
  // Bug B: create the TaskRegistry here so stopDaemon can call stopWatchers()
  // on it, preventing finalize-watcher poll timers from pinning the event loop.
  const taskRegistry = new TaskRegistry(homeBase);
  mountRepoGraphRoutes(app, { cwd: process.cwd(), secret: opts.secret, home: homeBase, taskRegistry });
  // /api/repo-graph/seen* -- watermark delta + advance/mark-all. Extracted to
  // its own mount (fast-follow after slice ③ landed; repo-graph.tsx was 2x
  // the 800-LOC hard cap) -- same `home`/`secret` deps as the mount above.
  mountSeenRoutes(app, { secret: opts.secret, home: homeBase });
  mountFsRoutes(app, { secret: opts.secret, home: homeBase });

  // Feedback route: POST /api/critiques/:id/feedback.
  // Secret-gated (daemon-hardening security audit, finding 3) — no live
  // caller exists today (superseded by POST /api/critique/:critique_id/feedback
  // in critic.tsx), gated fail-closed anyway.
  mountFeedbackRoutes(app, { secret: opts.secret });

  // Rubric / preference-log / few-shot / repo-memory API + SSR routes.
  mountRubricApiRoutes(app);
  mountPreferenceLogApiRoutes(app);
  mountFewShotApiRoutes(app);
  // homeBase: build must resolve its target project from the daemon's home,
  // never process.cwd() (which is "/" under launchd) — same fix as the
  // repo-graph mount below.
  mountRepoMemoryApiRoutes(app, { secret: opts.secret, homeBase });  // Brain health JSON for the dashboard ephemeral strip.
  mountBrainHealthRoute(app, { homeBase });
  // Daemon build-staleness signal for banner + doctor.
  mountDaemonHealthRoute(app);
  mountRubricRoutes(app, { secret: opts.secret });
  mountPreferenceLogRoutes(app, { secret: opts.secret });
  mountFewShotRoutes(app, { secret: opts.secret });
  mountRepoMemoryRoutes(app, { secret: opts.secret, homeBase });
  // /repo-graph SSR shell + Alpine island hydration.
  // `home: homeBase` — same fix as the API mount above: the resolver reads
  // per-request project state from the daemon's home, not the frozen cwd.
  mountRepoGraphWebRoutes(app, { cwd: process.cwd(), secret: opts.secret, home: homeBase });

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

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
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
  } catch (err) {
    // A failed bind is handled out-of-line (keeps startDaemon's cyclomatic
    // complexity in check): resolveBindFailure tears down the lock + pidfile
    // we already grabbed and returns the error to surface — a typed
    // DaemonAlreadyRunningError when a healthy incumbent owns the port, else
    // the original error unchanged.
    throw await resolveBindFailure(err, {
      lock,
      pidPath: opts.pidPath,
      hostname: opts.hostname,
      port: opts.port,
      chatIndex,
      taskRegistry,
    });
  }
  // Fill in the real bound port (opts.port may have been 0) for the
  // Host-allowlist middleware registered above.
  boundPort = server.port ?? boundPort;

  // Start background decay tick (10-min interval). Capture the
  // cleanup fn so stopDaemon can clearInterval it — leaving it live pinned the
  // event loop and made SIGTERM hang forever (zombie daemon).
  const stopDecay = startDecayTick({ homeBase });

  // Trace retention eviction — 30-day window by default, size cap OFF by
  // default, both set via the `traces` section of config.json.
  //
  // The sweep runs ONCE HERE, before the interval is armed. It used to be
  // interval-only, which meant the first eviction was due 24h after boot and
  // the countdown restarted on every daemon restart — so in practice it never
  // fired at all: measured 2026-08-23, `~/.siltpoke/traces` held span files 48
  // days old under a 30-day policy, plus 1.8 GB of spillover going back 94
  // days. A daemon that is restarted daily can never reach a daily deadline.
  //
  // Everything else here is a consequence of what happened the first time it
  // DID run, later that same day. The operator had set `retention_days: 120`
  // to hold a research corpus open and had never heard of the second key; the
  // size cap, defaulting to an unchosen 500 MB, evicted ~1.4 GB from inside
  // that window, and not one line was written about it. Hence:
  //
  //   - no `?? 500`. An escape valve does not fire on a number nobody picked;
  //     `max_storage_mb` is opt-in and age is the policy people reason about.
  //   - the armed policy is announced, so "is my config actually in effect"
  //     is answerable by looking instead of by trusting the file.
  //   - an eviction is always reported. Deleting a gigabyte in silence is how
  //     the loss went unnoticed until a code review found it.
  //   - the sweep can never take the daemon down: `existsSync` is true for a
  //     plain file and for an unreadable directory, so the read inside can
  //     still throw. `runRetention` swallows that itself; this catch is the
  //     second layer, because a boot-path throw here means no daemon, a stale
  //     lock + pidfile, and a launchd crash-flap.
  const tracesDir = join(homeBase, "traces");
  const retentionCfg = await loadTracesRetentionConfig(homeBase);
  const retentionOpts = {
    dir: tracesDir,
    retentionDays: retentionCfg.retention_days ?? 30,
    maxStorageMB: retentionCfg.max_storage_mb,
  };
  const capLabel =
    retentionOpts.maxStorageMB === undefined ? "off" : `${retentionOpts.maxStorageMB} MB`;
  console.error(
    `[siltpoke] trace retention armed: keep ${retentionOpts.retentionDays} days, size cap ${capLabel}`,
  );
  const sweepTraces = (): void => {
    try {
      const result = runRetention(retentionOpts);
      if (result.deletedFiles > 0) {
        const mb = (result.freedBytes / (1024 * 1024)).toFixed(1);
        console.error(
          `[siltpoke] trace retention: evicted ${result.deletedFiles} file(s), freed ${mb} MB from ${tracesDir}`,
        );
      }
    } catch (err) {
      console.error(`[siltpoke] trace retention failed (continuing): ${err}`);
    }
  };
  sweepTraces();
  const retentionTimer = setInterval(sweepTraces, 24 * 60 * 60 * 1000);

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
