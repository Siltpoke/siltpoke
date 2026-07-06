// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { Hono } from "hono";
import { type AnchorTarget, cheapNodeExists, type ResolveAnchorResult } from "../../chat/anchor-context";
import { deleteAnchorContext, readAnchorContext, writeAnchorContext } from "../../chat/anchor-store";
import { composeBaseSystemPrompt } from "../../chat/compose-base-context";
import {
  type ChatIndex,
  insertMessage,
  search,
} from "../../chat/fts5-index";
import {
  appendMessage,
  deleteSessionFile,
  readSession,
} from "../../chat/jsonl-store";
import { type PageContext, parsePageId, previewContext } from "../../chat/page-context";
import { RECALL_SURFACE_ENABLED, recallRelatedChats } from "../../chat/recall";
import { type RecapDeps, recapSession } from "../../chat/recap";
import { type ChatMessage, chatMessageSchema } from "../../chat/schema";
import {
  chatTitle,
  deleteChatSession,
  listChatSessions,
  placeholderSummary,
  reanchorChatSession,
  upsertChatSession,
} from "../../chat/sessions";
import type { Embedder } from "../../few-shot/embedder";
import { activeEpisodes } from "../../memory/episode";
import { buildEpisodeRecallBlock, selectRecallEpisodes } from "../../memory/episode-recall";
import { type ExtractedFact, extractDurableFacts } from "../../memory/extract-facts";
import type { ChatAnchor, CoreMemory } from "../../memory/memory";
import { newId } from "../../memory/memory";
import { buildUserContextBlock, readActiveFacts } from "../../memory/recall";
import { readFingerprints } from "../../repo-graph/store";
import { ledgerBrainCall } from "../../state/usage";
import {
  buildCaptureMarker,
  CAPTURE_HONESTY,
  type ChatCaptureResult,
  runChatCapture,
} from "./chat-capture-runner";
import {
  buildTranscript,
  formatSseEvent,
  type StreamChatOptions,
  type StreamErrorReason,
  type StreamEvent,
  type StreamUsage,
  streamChat,
} from "./chat-stream";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface ChatRouteDeps {
  homeBase: string;
  index: ChatIndex;
  /**
   * Test seam — when set, the route delegates streaming to this factory
   * instead of spawning `claude -p`. Receives the transcript & model.
   */
  streamFactory?: (
    opts: StreamChatOptions,
  ) => AsyncGenerator<StreamEvent, void, void>;
  /**
   * Resolve a viewed repo-graph node into Brain-ready anchor context.
   * Injected (the daemon binds it to `resolveAnchorContext` + the project's
   * graph storage); absent in tests that don't exercise anchoring. When absent,
   * the chat behaves exactly as before (free-text, no anchor).
   */
  resolveAnchor?: (anchor: ChatAnchorRef) => Promise<ResolveAnchorResult>;
  /**
   * Resolve a proj_hash to its graph storage directory. Used by both the
   * stale-fingerprint pre-flight check (reads fingerprints.json cheaply) and
   * the node_gone existence check (reads graph.json + findTargetNode,
   * avoiding the full resolveAnchor pipeline on every send for pinned
   * sessions). Absent → both checks skipped (test compat).
   */
  getGraphStorageDir?: (projHash: string) => Promise<string | null>;
  /**
   * Read the user-fact store so active facts can
   * be injected into the chat system prompt (so the pet "knows" the user). Mirrors
   * the /memory page's read path (resolveProjectRoot(daemon cwd) → the same store
   * the page shows). Absent → no facts injected (test compat / graceful degrade).
   */
  readMemory?: (homeBase: string) => Promise<CoreMemory | null>;
  /**
   * Episode recall — inject synthesized episode narratives into the
   * chat system prompt (rollback seam, siltpoke's optional-field idiom, NOT an
   * env flag). Defaults to ON in the live daemon; a mount can pass `false` to
   * disable (tests, rollback). Recall still no-ops when `readMemory` is absent
   * or the store has no fresh episodes (the gate abstains).
   */
  episodeRecallEnabled?: boolean;
  /**
   * Page-context chat — assembles a page-flavored system-prompt block from
   * `body.page` when no node anchor is resolved (node > page > none). Test
   * seam (mirrors `readMemory`); defaults to the real `assemblePageContext`
   * inside `composeBaseSystemPrompt` (src/chat/compose-base-context.ts).
   */
  assemblePageContext?: (
    pageId: string,
    pageDeps: { homeBase: string; readMemory?: (homeBase: string) => Promise<CoreMemory | null> },
  ) => Promise<PageContext | null>;
  /**
   * memory work (real-time chat capture) — persist a fact when the user
   * tells the pet "记住 X" in chat. Mirrors the optional `readMemory` signature
   * (same store the facts route writes to). Absent → capture disabled: no fact
   * is written AND the capture-honesty framing is NOT injected (back-compat —
   * a mount with neither readMemory nor writeMemory behaves exactly as before).
   */
  writeMemory?: (homeBase: string, memory: CoreMemory) => Promise<void>;
  /**
   * Conversational auto-capture (memory work) — distill durable user-facts
   * from a plain chat message (no explicit "记住" marker) via one ledgered Haiku
   * call. Injected so route tests stub it deterministically without spawning the
   * `claude` CLI; production defaults to the real `extractDurableFacts`. Only
   * called on the `!intent.hit` path AND after `looksLikeFactStatement` passes
   * (the cheap code pre-filter that gates the paid call — security rule).
   */
  extractFacts?: (
    message: string,
    deps: { homeBase: string; sessionId: string },
  ) => Promise<ExtractedFact[]>;
  /**
   * Injectable gate for budget + quiet-hours checks. Called at
   * the TOP of the pre-flight section for every chat send (pinned and general).
   * Returns:
   *   `{ blocked: "budget", used_pct }` — hard-stop reached; send blocked.
   *   `{ blocked: "quiet_hours" }` — quiet hours active; send blocked.
   *   `null` — neither condition met; send proceeds.
   *
   * Absent dep → null (fail-open: behave as today, never block). The real
   * implementation is wired in server.ts using loadBudgetConfig +
   * loadDailyRollup + evaluateBudget + loadQuietHoursConfig + isQuietHour.
   *
   * Soft budget (stage === "soft") does NOT block. The soft stage degrades the
   * Stop hook's trigger mode; chat sends are unaffected (intentional scope).
   */
  checkSendGate?: () => Promise<BudgetSignal | QuietHoursSignal | null>;
  now?: () => Date;
  /**
   * Test seam for the recall embedder. When set, passed
   * through to `recallRelatedChats` so tests can use a deterministic embedder
   * instead of the fastembed default. Production callers leave this unset.
   */
  recallEmbedder?: Embedder;
  /**
   * Test seam for the recap route's session
   * transcript read. Mirrors the module-level `readSession` import; production
   * leaves this unset (route falls back to the real `readSession`).
   */
  readSession?: (
    homeBase: string,
    sessionId: string,
  ) => Promise<{ role: string; content: string }[]>;
  /**
   * Test seam for `recapSession` (lazy per-chat recap, Haiku
   * summarization). Absent → real `recapSession` (src/chat/recap.ts).
   */
  recapSession?: (
    messages: { role: string; content: string }[],
    deps: RecapDeps,
  ) => Promise<string>;
}

/**
 * JSON signals returned when the pre-flight gate blocks a send
 * (client detects via Content-Type: application/json vs event-stream). Order:
 * budget/quiet (checked first) → node_gone (TERMINAL) → stale (
 * user can freeze or continue).
 */

/** Daily budget hard-stop reached. Hard block only (soft budget
 * allows the send; it only degrades the Stop hook's trigger mode). */
export interface BudgetSignal {
  blocked: "budget";
  /** Percentage of the daily budget consumed (0–200). */
  used_pct: number;
}

/** Quiet hours are active; the user can retry once they end. */
export interface QuietHoursSignal {
  blocked: "quiet_hours";
}

export interface BlockedSignal {
  blocked: "stale";
  /** The fingerprint stored at pin time (what the transcript discussed). */
  pinned_fingerprint: string;
  /** The current fingerprint from the last index run (what the file is now). */
  current_fingerprint: string;
  /** ISO 8601 of when the conversation was pinned. */
  pinned_at: string;
  /** Human-readable anchor node name for the UI copy. */
  node_name: string;
  /**
   * V4 limitation: fingerprint is FILE-level only (content_sha256 per file).
   * A change to any sibling symbol in the same file also triggers this signal.
   * Per-node fingerprint is future work.
   */
  v4_file_level_only: true;
}

/** The pinned node no longer exists (renamed/removed on
 * re-index). TERMINAL: no override; only a new conversation moves forward. */
export interface NodeGoneSignal {
  blocked: "node_gone";
  /** Human-readable anchor node name for the UI copy. */
  node_name: string;
  /** ISO 8601 of when the conversation was pinned. */
  pinned_at: string;
}

/**
 * A node the client is viewing, scoped to the repo it belongs to. The target is
 * EITHER a canonical `node_id` (trace view) OR a `{name, path, node_type?}`
 * descriptor (symbol-drill view, whose render id isn't canonical — the backend
 * resolves it). See `AnchorTarget`.
 */
export type ChatAnchorRef = { proj_hash: string } & AnchorTarget;

interface ChatRequestBody {
  session_id?: string;
  message?: string;
  model?: string;
  /** The node the user is viewing; pins a NEW conversation to it. */
  anchor?: ChatAnchorRef;
  /**
   * Page-context chat — the PAGE the user is on (location.pathname), sent
   * per-message so an un-anchored chat can be grounded in it. Validated
   * (string, ≤128 chars, `^/[a-zA-Z0-9/_-]*$`); malformed → treated as no
   * page (empty) — the reply still streams, this is additive-only context.
   */
  page?: string;
  /**
   * User's resolution after the stale pre-flight signal.
   * "freeze": stream using the EXISTING frozen sidecar context (old code version).
   * "continue": re-resolve + overwrite the sidecar with fresh context, then stream.
   * Absent: pre-flight stale check runs normally (may block with a signal).
   */
  anchor_decision?: "freeze" | "continue";
}

interface SearchRequestBody {
  query?: string;
  limit?: number;
}

/** Terminal aggregate of one SSE turn — everything the persistence + ledger
 * branches need after the stream ends. */
interface StreamReduction {
  assistantText: string;
  assistantId: string;
  assistantModel: string;
  usage: StreamUsage;
  /** Presence-based ledger gate (never value-based): true only when a real
   * usage object came back — message_stop, or an error event carrying usage
   * that arrived before the process was killed. */
  sawUsage: boolean;
  sawStop: boolean;
  /** Non-null = the turn failed; `message` is already capped at 300 chars. */
  failure: { reason?: StreamErrorReason; message: string } | null;
}

interface ReduceStreamDeps {
  /** Enqueue a sanitized event on the SSE wire. May throw once the client
   * disconnects — the reducer guards EVERY emit (dead-wire latch) so state
   * reduction and the caller's persistence + ledger still run to completion. */
  emit: (ev: StreamEvent) => void;
  /** Sink for a failure's capped stderr tail (daemon log only — never the
   * wire, never the store). */
  logStderr: (reason: StreamErrorReason | undefined, tail: string) => void;
}

/**
 * Consumes the chat stream, forwarding wire-safe events via `deps.emit` and
 * reducing the terminal state for the route's persistence/ledger branches.
 * Never throws: a stream that throws (test seams / unexpected bugs) becomes
 * an unclassifiable failure (status only, no reason enum).
 */
async function reduceStreamEvents(
  stream: AsyncIterable<StreamEvent>,
  init: { assistantId: string; assistantModel: string },
  deps: ReduceStreamDeps,
): Promise<StreamReduction> {
  let assistantText = "";
  let assistantId = init.assistantId;
  let assistantModel = init.assistantModel;
  let usage: StreamUsage = { input_tokens: 0, output_tokens: 0 };
  let sawUsage = false;
  let sawStop = false;
  let failure: { reason?: StreamErrorReason; message: string } | null = null;

  // Wire delivery is best-effort: once the client disconnects, every enqueue
  // throws ("Controller is already closed"). An emit failure is a WIRE
  // problem, never a turn-outcome problem — latch the dead wire, skip further
  // emits, and KEEP reducing so sawStop/usage/assistantText still finish (the
  // terminal batch can arrive after the disconnect; a completed, billed reply
  // must never be re-labelled a failure by a dead socket). Each event type
  // mutates state BEFORE its emit, so a throw can never lose the mutation.
  let wireClosed = false;
  const safeEmit = (ev: StreamEvent): void => {
    if (wireClosed) return;
    try {
      deps.emit(ev);
    } catch (err) {
      // Logged once so a non-disconnect emit failure stays diagnosable
      // (same swallow-with-debug discipline as killProc).
      // biome-ignore lint/suspicious/noConsole: debug-level by design — a latched wire is a benign race in the dominant (disconnect) case
      console.debug(
        `[chat-stream] wire closed mid-turn (${ev.type}): ${err instanceof Error ? err.message : String(err)}`,
      );
      wireClosed = true;
    }
  };

  try {
    for await (const ev of stream) {
      if (ev.type === "message_start") {
        if (ev.message_id) assistantId = ev.message_id;
        assistantModel = ev.model;
        continue;
      }
      if (ev.type === "content_block_delta") {
        assistantText += ev.text;
      }
      if (ev.type === "message_stop") {
        assistantText = ev.full_text || assistantText;
        usage = ev.usage;
        sawUsage = true;
        sawStop = true;
      }
      if (ev.type === "error") {
        failure = { reason: ev.reason, message: ev.error.slice(0, 300) };
        if (ev.usage) {
          usage = ev.usage;
          sawUsage = true;
        }
        // stderr goes to the daemon log ONLY — never the store, never the
        // SSE wire.
        if (ev.stderr_tail) deps.logStderr(ev.reason, ev.stderr_tail);
        // Re-emit sanitized: reason + short message, no stderr blob
        // (formatSseEvent also strips server-only fields — defense in depth).
        safeEmit({ type: "error", error: ev.error, reason: ev.reason });
        continue;
      }
      safeEmit(ev);
    }
  } catch (err) {
    // A stream that THROWS mid-iteration (emit failures never reach here —
    // safeEmit latches them) is an unclassifiable failure: record it with
    // status only (no reason enum) so the turn is excluded from future
    // context; the caller's shared persistence branch handles the rest.
    // The raw exception text goes to the DAEMON LOG only — the store and the
    // wire carry a generic message (same containment discipline as stderr:
    // raw internals never reach JSONL bytes or the SSE wire).
    const raw = err instanceof Error ? err.message : String(err);
    console.error(`[chat-stream] unexpected stream failure: ${raw.slice(0, 300)}`);
    failure = { message: "unexpected stream failure" };
    safeEmit({ type: "error", error: failure.message });
  }

  return { assistantText, assistantId, assistantModel, usage, sawUsage, sawStop, failure };
}

/** Runtime guard: a well-formed anchor = string proj_hash + a valid target
 * (string node_id, OR string name + string path). Keeps non-string/object
 * values from reaching resolveAnchor + downstream path joins. */
function isValidAnchorRef(a: unknown): a is ChatAnchorRef {
  if (typeof a !== "object" || a === null) return false;
  const o = a as Record<string, unknown>;
  if (typeof o.proj_hash !== "string") return false;
  if (typeof o.node_id === "string") return true;
  return typeof o.name === "string" && typeof o.path === "string";
}

export function mountChatRoutes(app: Hono, deps: ChatRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  // Conversational auto-capture extractor: real (ledgered Haiku) in production,
  // injectable stub in tests. Mirrors the `streamFactory ?? streamChat` seam.
  const extractFacts = deps.extractFacts ?? extractDurableFacts;
  // Lazy per-chat recap — real recapSession (ledgered Haiku) in
  // production, injectable stub in tests. Mirrors the `extractFacts` seam.
  const recapFn = deps.recapSession ?? recapSession;

  app.post("/api/chat", async (c) => {
    let body: ChatRequestBody;
    try {
      body = (await c.req.json()) as ChatRequestBody;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body.message || typeof body.message !== "string") {
      return c.json({ error: "missing_message" }, 400);
    }
    // Validate session_id BEFORE it touches the filesystem — it's a path
    // component in chats/<id>.jsonl + chats/<id>.anchor.json (security: an
    // unvalidated id like "../../x" would path-traverse out of chats/). Allow
    // only safe filename chars (alnum / dash / underscore) — this admits both
    // newId("s-xxxxxxxx") AND the client's crypto.randomUUID(), while rejecting
    // `.` and `/` so no traversal is possible. Absent/empty = fresh conversation.
    if (body.session_id !== undefined && !SESSION_ID_RE.test(body.session_id)) {
      return c.json({ error: "invalid_session_id" }, 400);
    }
    // Validate the anchor shape if present (string fields only — avoids object
    // coercion reaching resolveAnchor / path joins). proj_hash is format-checked
    // downstream by resolveRepoByHash's isValidProjHash guard. The target is
    // EITHER node_id OR {name, path} — reject if neither well-formed.
    if (body.anchor !== undefined && !isValidAnchorRef(body.anchor)) {
      return c.json({ error: "invalid_anchor" }, 400);
    }
    // Page-context chat: parsePageId validates + normalizes body.page (see
    // src/chat/page-context.ts); malformed → "" (no page, never blocks).
    const pageId = parsePageId(body.page);

    const sessionId = body.session_id ? body.session_id : newId("s");
    const isNewSession = !body.session_id;

    // Pin the conversation to the viewed node at CREATION (INV1).
    // Resolve once, freeze the context to a sidecar (cache / freeze),
    // and remember the metadata for the session record. Unresolved (no graph /
    // dead node) just skips pinning here — the pre-flight gate surfaces those states to the UI.
    let pinnedAnchorMeta: ChatAnchor | null = null;
    if (isNewSession && body.anchor && deps.resolveAnchor) {
      const resolved = await deps.resolveAnchor(body.anchor);
      if (resolved.kind === "resolved") {
        await writeAnchorContext(deps.homeBase, sessionId, resolved.context);
        pinnedAnchorMeta = {
          node_id: resolved.context.nodeId,
          proj_hash: body.anchor.proj_hash,
          node_name: resolved.context.nodeName,
          node_type: resolved.context.nodeType,
          fingerprint: resolved.context.fingerprint,
          pinned_at: now().toISOString(),
        };
      }
    }

    // ── Pre-flight gate (order: budget/quiet → node_gone → stale) ──
    // Reads the frozen sidecar BEFORE appending the user message; a block
    // returns a JSON signal without appending (INV2). INV2 also holds: nothing
    // below overwrites the sidecar with a newer fingerprint except the explicit
    // `anchor_decision: "continue"` branch.

    // ── budget + quiet-hours gate — FIRST, before ANY sidecar read.
    // Applies to all sends; a hard budget stop or active quiet hours returns a
    // JSON block signal without appending/streaming. Fail-open: absent dep or
    // any checkSendGate error → proceed unblocked. Soft budget does NOT block
    // (only degrades the Stop hook's trigger mode).
    if (deps.checkSendGate) {
      let gateSignal: BudgetSignal | QuietHoursSignal | null = null;
      try {
        gateSignal = await deps.checkSendGate();
      } catch {
        // Fail-open: gate error → treat as "no block".
      }
      if (gateSignal !== null) {
        return c.json(gateSignal, 200);
      }
    }
    // ── end budget/quiet gate ─────────────────────────────────────────────────────────

    let anchorCtx = await readAnchorContext(deps.homeBase, sessionId);

    // ── node_gone check — BEFORE stale check. For an existing
    // pinned session, verify the anchor node still exists via a CHEAP path
    // (graph.json + findTargetNode only — no subgraph/sources/prompt). Only
    // blocks on a definitive "not_found"; "no_graph" or absent dep fail-open
    // (can't determine → proceed). TERMINAL: if it fires, the stale check
    // below is skipped. Sessions are cached here and reused by the stale check
    // (avoids a double listChatSessions call per request).
    let cachedSessions: Awaited<ReturnType<typeof listChatSessions>> | null = null;
    if (anchorCtx !== null && !isNewSession && deps.getGraphStorageDir) {
      cachedSessions = await listChatSessions(deps.homeBase);
      const sessionAnchor = cachedSessions.find((s) => s.id === sessionId)?.anchor;
      if (sessionAnchor) {
        const storageDir = await deps.getGraphStorageDir(sessionAnchor.proj_hash);
        if (storageDir) {
          // The AnchorTarget uses node_id form (stored at pin time by upsertChatSession
          // from the server-resolved nodeId — same form findTargetNode consumes).
          const anchorTarget: AnchorTarget = { node_id: sessionAnchor.node_id };
          const existsResult = await cheapNodeExists(anchorTarget, storageDir);
          if (existsResult === "not_found") {
            // Node is definitively gone — terminal block.
            const signal: NodeGoneSignal = {
              blocked: "node_gone",
              node_name: sessionAnchor.node_name,
              pinned_at: sessionAnchor.pinned_at,
            };
            return c.json(signal, 200);
          }
          // "found" or "no_graph" → fall through (fail-open for no_graph).
          // Do NOT update anchorCtx here: the stale check below must compare
          // the FROZEN sidecar fingerprint (pin-time) against the current on-disk
          // fingerprint.
        }
        // No storageDir → fail-open (can't determine → do not block).
      }
    }
    // ── end node_gone check ───────────────────────────────────────────────

    // ── pre-flight gate (stale fingerprint) — only for EXISTING pinned
    // sessions (a brand-new session was just pinned above; its fingerprint is
    // current by construction).
    if (anchorCtx !== null && !isNewSession && deps.getGraphStorageDir) {
      const anchorDecision = body.anchor_decision;
      const pinnedFingerprint = anchorCtx.fingerprint;

      if (anchorDecision !== "freeze" && anchorDecision !== "continue") {
        // No decision yet — run the stale check.
        // Skip when pinnedFingerprint is null (file wasn't tracked at pin time).
        if (pinnedFingerprint !== null) {
          // Retrieve the session anchor to get proj_hash (the sidecar doesn't
          // store it — proj_hash lives in the session record in memory.json).
          // Reuse the sessions already loaded by the node_gone check above if
          // available (avoid double listChatSessions per request).
          const sessions = cachedSessions ?? await listChatSessions(deps.homeBase);
          const sessionAnchor = sessions.find((s) => s.id === sessionId)?.anchor;

          if (sessionAnchor?.proj_hash) {
            const storageDir = await deps.getGraphStorageDir(sessionAnchor.proj_hash);
            if (storageDir) {
              // Cheap read: fingerprints.json only (no graph, no sources, no AST).
              // V4 limitation: this is FILE-level only (`content_sha256` per file).
              // A change to any sibling symbol in the same file also triggers this
              // signal. Per-node fingerprint is future work.
              const fingerprints = await readFingerprints(storageDir);
              const currentFingerprint =
                fingerprints.files[anchorCtx.path]?.content_sha256 ?? null;

              if (currentFingerprint !== null && currentFingerprint !== pinnedFingerprint) {
                // File changed since pin time → block and return the JSON signal.
                // The user message is NOT appended (not answered — INV2).
                const signal: BlockedSignal = {
                  blocked: "stale",
                  pinned_fingerprint: pinnedFingerprint,
                  current_fingerprint: currentFingerprint,
                  pinned_at: sessionAnchor.pinned_at,
                  node_name: anchorCtx.nodeName,
                  v4_file_level_only: true,
                };
                return c.json(signal, 200);
              }
            }
          }
        }
      } else if (anchorDecision === "continue") {
        // Explicit user choice: re-resolve + overwrite the frozen sidecar.
        // INV2: this is the ONLY permitted re-derive path — it went through the
        // freeze/continue branch (the user explicitly chose "use new version").
        if (deps.resolveAnchor) {
          // Reuse cached sessions if available.
          const sessions = cachedSessions ?? await listChatSessions(deps.homeBase);
          const sessionAnchor = sessions.find((s) => s.id === sessionId)?.anchor;
          if (sessionAnchor) {
            // Reconstruct a ChatAnchorRef from the stored session anchor.
            const anchorRef: ChatAnchorRef = {
              proj_hash: sessionAnchor.proj_hash,
              node_id: sessionAnchor.node_id,
            };
            const resolved = await deps.resolveAnchor(anchorRef);
            if (resolved.kind === "resolved") {
              // Overwrite the sidecar with fresh context (explicit re-derive).
              await writeAnchorContext(deps.homeBase, sessionId, resolved.context);
              // Build updated anchor metadata (new fingerprint + pinned_at).
              const updatedAnchor: ChatAnchor = {
                node_id: resolved.context.nodeId,
                proj_hash: sessionAnchor.proj_hash,
                node_name: resolved.context.nodeName,
                node_type: resolved.context.nodeType,
                fingerprint: resolved.context.fingerprint,
                pinned_at: now().toISOString(),
              };
              // Update the session record so the new fingerprint is persisted.
              await reanchorChatSession(deps.homeBase, sessionId, updatedAnchor);
              // Refresh anchorCtx so the system prompt below uses the new bundle.
              anchorCtx = resolved.context;
            }
            // If resolution fails (no_graph / node_not_found), fall through and
            // stream with the existing frozen context — best-effort, not a hard
            // failure. The user chose to continue so we honour the intent.
          }
        }
      }
      // anchor_decision === "freeze" (or no decision but fingerprint unchanged):
      // fall through with existing anchorCtx unchanged — the transcript keeps
      // discussing the pinned version (freeze).
    }
    // ── end pre-flight gate (stale fingerprint) ───────────────────────────────────────────────

    const userMessage: ChatMessage = chatMessageSchema.parse({
      id: newId("m"),
      session_id: sessionId,
      role: "user",
      content: body.message,
      ts: now().toISOString(),
    });
    await appendMessage(deps.homeBase, sessionId, userMessage);
    insertMessage(deps.index, userMessage);

    // ── Real-time chat capture (memory work) ─────────────────────────────
    //
    // Capture (explicit "记住 X" OR a conversational fact statement) is detected +
    // persisted in runChatCapture BEFORE composing the system prompt, so this very
    // turn can truthfully acknowledge the save via the injected marker. Routing is
    // deterministic (no LLM — security rule); the write is best-effort and must
    // NEVER block or fail the reply (Contingency-2 → signal:null on any failure).
    //
    // Only attempted when BOTH readMemory + writeMemory are wired (production:
    // server.ts wires both). When capture is disabled the runner is skipped —
    // no marker, no honesty framing — so back-compat mounts behave as before.
    const captureEnabled = Boolean(deps.readMemory && deps.writeMemory);
    const cap: ChatCaptureResult = captureEnabled
      ? await runChatCapture(body.message, {
          // biome-ignore lint/style/noNonNullAssertion: captureEnabled guards both.
          readMemory: deps.readMemory!,
          // biome-ignore lint/style/noNonNullAssertion: captureEnabled guards both.
          writeMemory: deps.writeMemory!,
          extractFacts,
          homeBase: deps.homeBase,
          sessionId,
          nowIso: () => now().toISOString(),
        })
      : { signal: null, text: "" };
    // ── end real-time chat capture ───────────────────────────────────────────

    const history = await readSession(deps.homeBase, sessionId);
    const historyMinusLatest = history.slice(0, -1);
    const transcript = buildTranscript(historyMinusLatest, userMessage.content);

    // Inject the frozen anchor context (if this conversation is pinned) as the
    // system prompt — this is the no-feed point: the user never pasted the code.
    // anchorCtx is already read above (pre-flight gate); may have been refreshed
    // by the "continue" branch.
    //
    // Page-context chat: when there is NO resolved node anchor and the client
    // sent a valid `page`, ground the reply in the PAGE the user is on instead.
    // Precedence: node > page > none, extracted into composeBaseSystemPrompt
    // (src/chat/compose-base-context.ts) — see that module for the fail-open
    // try/catch (page assembly is additive context only, never blocks the reply).
    const baseSystemPrompt = await composeBaseSystemPrompt({
      anchorCtx,
      pageId,
      homeBase: deps.homeBase,
      readMemory: deps.readMemory,
      assemblePage: deps.assemblePageContext,
    });

    // Recall related past sessions and append their summaries
    // to the system prompt so the model can reference prior context. When the
    // corpus is empty or all matches are below threshold, recallBlock is "".
    // Fail-open: recall is additive context only — never block a send on error.
    //
    // RECALL_SURFACE_ENABLED = false: the recall CALL is skipped entirely (no embed/IO
    // cost). The recallRelatedChats function + route stay mounted but dormant.
    // Flip RECALL_SURFACE_ENABLED → true in src/chat/recall.ts to restore injection.
    let recallBlock = "";
    if (RECALL_SURFACE_ENABLED) {
      let recall: Awaited<ReturnType<typeof recallRelatedChats>> = { matches: [] };
      try {
        recall = await recallRelatedChats(userMessage.content, deps.homeBase, {
          currentSessionId: sessionId,
          embedder: deps.recallEmbedder,
        });
      } catch {
        // Silently degrade — embed/IO failure must not orphan a persisted message.
      }
      recallBlock = recall.matches.length
        ? `\n\nRELATED PAST CHATS (the user may be referring to these):\n${recall.matches
            .map((m) => `- ${m.summary}`)
            .join("\n")}`
        : "";
    }

    // Inject the active user-facts so the pet's
    // replies reflect what it knows about the user (language / explanation level /
    // personal warmth).
    //
    // Store resolution (DELIBERATE): user-facts are about the USER (concise answers / Alex / teal), not a
    // project, so we read the SAME store the /memory page shows — deps.readMemory →
    // resolveProjectRoot(daemon cwd). The daemon runs from the user's project, so
    // cwd is the right store. We deliberately do NOT key off an anchor's proj_hash:
    // a chat anchored to a different repo's graph node would resolve to that repo's
    // (likely empty) store and drop the user's real facts — worse, not better.
    // KNOWN LIMIT: a multi-project user / daemon launched elsewhere gets facts from
    // the daemon's project; the real fix is a global user-fact store (follow-up,
    // out of current scope). Fail-open + contingency: no readMemory / no store /
    // read error → no block (never guess a project from elsewhere).
    //
    // Episode recall — optional-field rollback seam (default ON), NOT
    // an env flag. Recalls synthesized episode narratives into the prompt; the
    // gate (selectRecallEpisodes) abstains on empty/stale corpus. Zero hot-path
    // cost: pure assembly over the SAME `mem` already read for facts — no second
    // read, no Brain call, no await beyond the existing readMemory.
    const episodeRecallEnabled = deps.episodeRecallEnabled !== false;
    let factsBlock = "";
    let episodeBlock = "";
    if (deps.readMemory) {
      try {
        const mem = await deps.readMemory(deps.homeBase);
        if (mem) {
          factsBlock = buildUserContextBlock(readActiveFacts(mem));
          if (episodeRecallEnabled) {
            const now = new Date();
            episodeBlock = buildEpisodeRecallBlock(
              selectRecallEpisodes(activeEpisodes(mem, now), now),
              now,
            );
          }
        }
      } catch {
        // Recall is additive context only — a read failure must never orphan a send.
      }
    }

    // Capture-honesty framing — injected whenever capture is wired (even on
    // a no-capture turn) so the model never hallucinates a save: the marker's
    // PRESENCE/ABSENCE is the signal, and the framing forbids claiming a save
    // without one. Gated on captureEnabled so legacy mounts inject nothing.
    const captureHonesty = captureEnabled ? CAPTURE_HONESTY : "";

    // Capture marker — present only when capture fired THIS turn; steers a
    // truthful ack from the same request that saved ("" when no capture fired).
    const captureMarker = buildCaptureMarker(cap.signal, cap.text);

    // Compose: anchor base + user-facts + capture-honesty framing + capture marker
    // joined by a blank line; the (dormant) recall block carries its own leading
    // separator. All empty → "" || undefined = undefined (nothing injected —
    // back-compat for capture-disabled mounts).
    const systemPrompt =
      ([baseSystemPrompt, factsBlock, episodeBlock, captureHonesty, captureMarker]
        .filter(Boolean)
        .join("\n\n") + recallBlock) ||
      undefined;

    const streamFactory = deps.streamFactory ?? streamChat;
    // One abort controller per request, two triggers, ONE
    // cancel path: (a) the SSE body's cancel() callback — fired when the
    // client aborts the fetch or the socket dies (Bun cancels the response
    // stream on disconnect); (b) the raw Request AbortSignal, when the
    // runtime propagates it. Either aborts streamChat's signal seam, which
    // kills the `claude -p` subprocess and stops yielding.
    const turnAbort = new AbortController();
    const reqSignal = c.req.raw.signal;
    const onReqAbort = () => turnAbort.abort();
    if (reqSignal.aborted) turnAbort.abort();
    else reqSignal.addEventListener("abort", onReqAbort, { once: true });
    const stream = streamFactory({
      transcript,
      model: body.model,
      systemPrompt,
      signal: turnAbort.signal,
    });

    const sseStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const emit = (ev: StreamEvent): void => {
          controller.enqueue(enc.encode(formatSseEvent(ev)));
        };
        emit({
          type: "message_start",
          message_id: "",
          model: body.model ?? "claude-sonnet-4-6",
        });

        const red = await reduceStreamEvents(
          stream,
          { assistantId: newId("m"), assistantModel: body.model ?? "claude-sonnet-4-6" },
          {
            emit,
            // launchd redirects the daemon's stderr to
            // ~/.siltpoke/logs/daemon.err, so console.error IS the daemon log.
            logStderr: (reason, tail) => {
              console.error(
                `[chat-stream] session=${sessionId} reason=${reason ?? "unclassified"} claude -p stderr (capped):\n${tail}`,
              );
            },
          },
        );
        let failure = red.failure;

        // Cancelled classification, checked BEFORE the defensive
        // empty_exit fallback AND before the success/failure persistence
        // branches: an aborted stream with no partial text would otherwise
        // misclassify as empty_exit, and one WITH partial deltas would fall
        // into the SUCCESS branch — persisting partial text as an ok turn
        // that re-enters future context. `!sawStop` is the F1-parity bound:
        // an abort that lands AFTER message_stop was reduced is a COMPLETE,
        // paid-for reply and stays an ok turn (a late disconnect never
        // discards a finished answer).
        const cancelled = turnAbort.signal.aborted && !red.sawStop;

        // Defensive twin of the client's empty-stream fallback: a stream that
        // ended with no stop, no error, and no text must not persist a silent
        // empty ok-turn. Skipped for cancelled turns — an abort is a user
        // action, not an empty_exit failure, and no error frame is emitted
        // for it (the client initiated it / nobody is listening).
        if (!cancelled && failure === null && !red.sawStop && red.assistantText.trim().length === 0) {
          failure = { reason: "empty_exit", message: "stream ended with no assistant text" };
          try {
            emit({ type: "error", error: failure.message, reason: "empty_exit" });
          } catch {
            // client disconnected — persistence below still runs
          }
        }

        // Persistence branches — cancelled beats failed beats success: an
        // abort can also surface as a reducer throw (enqueue on a cancelled
        // controller), and that must never re-classify a user stop as a
        // failure. Success keeps the lean pre-migration row shape (no status
        // field); failure persists an empty-content turn carrying the reason
        // enum + short message ONLY (already capped at 300 chars); cancelled
        // keeps whatever partial text existed — stored for honesty, never
        // displayed (islands render the quiet marker) and never re-fed
        // (filterContextHistory drops the row + its preceding user question).
        const assistantMsg: ChatMessage = chatMessageSchema.parse({
          id: red.assistantId,
          session_id: sessionId,
          role: "assistant",
          content: cancelled || failure === null ? red.assistantText : "",
          ts: now().toISOString(),
          model: red.assistantModel,
          // Cancelled/failed turns with no usage store tokens:null (honest);
          // success keeps today's shape, and pre-kill usage rides the row.
          tokens:
            (cancelled || failure !== null) && !red.sawUsage
              ? null
              : { input: red.usage.input_tokens, output: red.usage.output_tokens },
          ...(cancelled
            ? { status: "cancelled" }
            : failure !== null
              ? {
                  status: "failed",
                  ...(failure.reason ? { error_reason: failure.reason } : {}),
                  error_message: failure.message,
                }
              : {}),
        });
        await appendMessage(deps.homeBase, sessionId, assistantMsg);
        insertMessage(deps.index, assistantMsg);
        await upsertChatSession(
          deps.homeBase,
          sessionId,
          now(),
          2,
          pinnedAnchorMeta,
          isNewSession ? placeholderSummary(userMessage.content) : "",
        );

        // Honest ledger (cost-honesty batch A): a chat turn is a real paid
        // Brain call (no cache). Chat usage carries only token counts, so the
        // cost is derived from the model via computeCost. Gated on usage
        // PRESENCE: a killed/failed call with no usage ledgers nothing; usage
        // that arrived before a kill IS ledgered (it was paid for).
        if (red.sawUsage) {
          await ledgerBrainCall(deps.homeBase, {
            kind: "chat",
            session_id: sessionId,
            model: red.assistantModel,
            usage: {
              input_tokens: red.usage.input_tokens,
              output_tokens: red.usage.output_tokens,
            },
          });
        }

        // Per-request listener cleanup — the request may outlive this turn in
        // keep-alive runtimes; never leave a dangling abort listener on it.
        reqSignal.removeEventListener("abort", onReqAbort);

        try {
          controller.close();
        } catch {
          // already closed by a client disconnect — nothing left to do
        }
      },
      // The disconnect signal that ALWAYS fires: cancelling
      // the response body (client abort / tab close / socket death) invokes
      // this even when the runtime never aborts the raw Request signal.
      cancel() {
        turnAbort.abort();
      },
    });

    return new Response(sseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Siltpoke-Session-Id": sessionId,
      },
    });
  });

  // Semantic recall over past chat summaries.
  // GET /api/chat/recall?q=<text>[&session=<id>]
  //   200 → { matches: RecallMatch[] }
  //   400 → { error: "missing q" } when q is absent or empty
  app.get("/api/chat/recall", async (c) => {
    const q = c.req.query("q");
    if (!q || q.trim().length === 0) return c.json({ error: "missing q" }, 400);
    const session = c.req.query("session");
    const { matches } = await recallRelatedChats(q, deps.homeBase, {
      currentSessionId: session,
      embedder: deps.recallEmbedder, // test-only seam; undefined in prod → default embedder
    });
    return c.json({ matches });
  });

  // $0 transparency read: what the pet WOULD load for this page,
  // without ever calling Brain. Powers the chat-page context bar.
  app.get("/api/chat/context-preview", async (c) => {
    const pageId = parsePageId(c.req.query("page") ?? "") || "/";
    const preview = await previewContext(pageId, { homeBase: deps.homeBase, readMemory: deps.readMemory });
    return c.json({ page_label: preview.pageLabel, facts_count: preview.factsCount });
  });

  /**
   * Lazy per-chat recap — POST /api/chat/recap-recent. Replaces the
   * deterministic first-message placeholder with a real one-line Haiku recap
   * for up to 5 recent un-recapped sessions (summary_generated_at === null &&
   * message_count > 0), newest-first by ended_at ?? started_at. Runs lazily
   * (called on-open by the client), NOT on every chat turn.
   *
   * Reuses the existing budget/quiet-hours gate seam (checkSendGate) —
   * this is a paid loop (up to 5 Haiku calls), so it must respect the same
   * gate the send path does. A blocked gate short-circuits to `{recapped: []}`
   * BEFORE any read/paid-call/write (fail-open on a checkSendGate throw,
   * mirroring the /api/chat gate above).
   *
   * Absent readMemory/writeMemory, or no eligible targets → `{recapped: []}`.
   */
  app.post("/api/chat/recap-recent", async (c) => {
    if (deps.checkSendGate) {
      let gateSignal: BudgetSignal | QuietHoursSignal | null = null;
      try {
        gateSignal = await deps.checkSendGate();
      } catch {
        // Fail-open: gate error → treat as "no block" (mirrors /api/chat).
      }
      if (gateSignal !== null) {
        return c.json({ recapped: [] });
      }
    }
    if (!deps.readMemory || !deps.writeMemory) return c.json({ recapped: [] });
    // Optional `ids` scopes the recap to exactly the sessions the client is
    // showing (the Working-Memory panel's displayed cards) — so the sessions
    // that get recapped are the ones the user actually sees, not an
    // independently-picked newest-N that can diverge from the panel's own
    // selection. Keyed off PRESENCE of the array, not its length: a request
    // that sends `{ids: []}` (panel open with nothing displayed) means "scope
    // to nothing" → recap nothing, never the panel-agnostic set. Only an
    // absent/invalid body (old clients) falls back to the newest-5 default.
    let requestedIds: Set<string> | null = null;
    try {
      const body = (await c.req.json()) as { ids?: unknown } | null;
      if (body && Array.isArray(body.ids)) {
        requestedIds = new Set(
          body.ids.filter((x): x is string => typeof x === "string"),
        );
      }
    } catch {
      // No/invalid JSON body → panel-agnostic default below.
    }
    const mem = await deps.readMemory(deps.homeBase);
    if (!mem) return c.json({ recapped: [] });
    const targets = [...mem.chat_sessions]
      .filter((s) => s.summary_generated_at === null && s.message_count > 0)
      .filter((s) => requestedIds === null || requestedIds.has(s.id))
      .sort((a, b) => (b.ended_at ?? b.started_at).localeCompare(a.ended_at ?? a.started_at))
      .slice(0, 5);
    if (targets.length === 0) return c.json({ recapped: [] });

    const readSess = deps.readSession ?? readSession;
    const recapped: { id: string; summary: string }[] = [];
    const byId = new Map<string, string>();
    for (const s of targets) {
      const messages = await readSess(deps.homeBase, s.id);
      const recap = await recapFn(messages, { homeBase: deps.homeBase, sessionId: s.id });
      if (recap) {
        byId.set(s.id, recap);
        recapped.push({ id: s.id, summary: recap });
      }
    }
    if (recapped.length > 0) {
      const nowIso = now().toISOString();
      const updated: CoreMemory = {
        ...mem,
        chat_sessions: mem.chat_sessions.map((s) =>
          byId.has(s.id)
            ? { ...s, summary: byId.get(s.id) as string, summary_generated_at: nowIso }
            : s,
        ),
      };
      await deps.writeMemory(deps.homeBase, updated);
    }
    return c.json({ recapped });
  });

  app.post("/api/chat/search", async (c) => {
    let body: SearchRequestBody;
    try {
      body = (await c.req.json()) as SearchRequestBody;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!body.query || typeof body.query !== "string") {
      return c.json({ error: "missing_query" }, 400);
    }
    const limit = Math.min(
      Math.max(typeof body.limit === "number" ? body.limit : 20, 1),
      100,
    );
    const matches = search(deps.index, body.query, limit);
    return c.json({ matches });
  });

  app.get("/api/chat/sessions", async (c) =>
    c.json({ sessions: await listChatSessions(deps.homeBase) }),
  );

  app.get("/api/chat/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_RE.test(id)) return c.json({ error: "invalid_session_id" }, 400);
    const msgs = await readSession(deps.homeBase, id);
    // status/error fields pass through so the client can render failed /
    // cancelled turns honestly; plain ok rows keep the lean legacy shape.
    const messages = msgs
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role,
        text: m.content,
        ...(m.status !== undefined ? { status: m.status } : {}),
        ...(m.error_reason !== undefined ? { error_reason: m.error_reason } : {}),
        ...(m.error_message !== undefined ? { error_message: m.error_message } : {}),
      }));
    return c.json({ messages });
  });

  app.delete("/api/chat/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_RE.test(id)) return c.json({ error: "invalid_session_id" }, 400);
    await deleteChatSession(deps.homeBase, id);
    await deleteSessionFile(deps.homeBase, id);
    await deleteAnchorContext(deps.homeBase, id);
    return c.json({ ok: true });
  });

  /**
   * Re-anchor an existing conversation to a different node.
   * This is the ONLY path that mutates a session's anchor after creation (INV1).
   * On success: overwrites the anchor sidecar + updates session meta. The
   * conversation history (JSONL) is untouched.
   *
   * Body: ChatAnchorRef (same shape as POST /api/chat anchor field).
   * Response 200: { ok: true, anchor: ChatAnchor }
   * Response 404: { error: "node_not_found" } — node not found or no resolveAnchor
   * Response 404: { error: "session_not_found" } — session absent from memory.json
   * Response 400: invalid session_id or invalid anchor body
   */
  app.patch("/api/chat/sessions/:id/anchor", async (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_RE.test(id)) return c.json({ error: "invalid_session_id" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (!isValidAnchorRef(body)) {
      return c.json({ error: "invalid_anchor" }, 400);
    }

    if (!deps.resolveAnchor) {
      return c.json({ error: "node_not_found" }, 404);
    }

    const resolved = await deps.resolveAnchor(body);
    if (resolved.kind !== "resolved") {
      return c.json({ error: "node_not_found" }, 404);
    }

    const newAnchor: ChatAnchor = {
      node_id: resolved.context.nodeId,
      proj_hash: body.proj_hash,
      node_name: resolved.context.nodeName,
      node_type: resolved.context.nodeType,
      fingerprint: resolved.context.fingerprint,
      pinned_at: now().toISOString(),
    };

    // Check session existence BEFORE writing the sidecar — write-then-check
    // ordering would leave the sidecar diverged from memory.json on a 404.
    // reanchorChatSession returns false when the session isn't present.
    const updated = await reanchorChatSession(deps.homeBase, id, newAnchor);
    if (!updated) {
      // Session doesn't exist in memory.json — distinct from a node resolution
      // failure above (which returns node_not_found). Sidecar is intentionally
      // NOT written so the state stays consistent.
      return c.json({ error: "session_not_found" }, 404);
    }

    // Session confirmed to exist — overwrite the frozen sidecar with the new
    // node's context bundle. This is the ONLY anchor mutation after creation (INV1).
    await writeAnchorContext(deps.homeBase, id, resolved.context);

    return c.json({ ok: true, anchor: newAnchor });
  });
}

