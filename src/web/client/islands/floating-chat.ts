// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * floating-chat — desync CTA + re-anchor.
 *
 * A floating chat panel on every dashboard surface. Multi-conversation,
 * pinned-per-conversation: a NEW conversation captures the node the user is
 * viewing (the repo-graph bridge's `window.__siltpokeViewedNode`) and stays
 * pinned to it; switching context = the "+" button.
 *
 * When the current view ≠ the active conversation's anchor AND the
 * user sends a message, an inline two-option CTA fires. The CTA shows:
 *   (i)  "Re-anchor this chat to <Y>" — PATCHes the re-anchor endpoint, updates
 *         the local anchor state, then proceeds with the original send.
 *   (ii) "New chat about <Y>" — creates a new conversation pinned to <Y> and
 *         sends the message there.
 * The CTA fires ONLY on send-while-desynced. Navigation alone does NOT trigger it.
 * The system never auto-switches the anchor (INV1 is enforced).
 *
 * Plain UI by design (re-skinnable). The factory `makeFloatingChatData` is
 * exported for direct unit-testing — no Alpine runtime required (mirrors
 * chat-stream.ts). The window-global PULL bridge (no addEventListener)
 * deliberately sidesteps the hx-boost morph listener-drop pitfall.
 *
 * Feature: renderMarkdown — renders assistant replies as HTML from a minimal
 * Markdown subset (bold, italic, inline code, fenced code blocks, headings,
 * unordered + ordered lists, links, paragraphs). XSS-safe: HTML-escapes the
 * source text FIRST, then applies Markdown transforms. Any raw HTML/script in
 * the model text is therefore inert in the final output.
 *
 * Feature: maximize toggle — a `maximized` boolean on the island data drives
 * the panel into a large centered modal (fixed fullscreen overlay) or back to
 * the default bottom-right corner panel. Escape / backdrop click restore it.
 */
import {
  CHAT_ERROR_FALLBACK_COPY,
  CHAT_STOPPED_MARKER,
  chatErrorCopy,
  makeFailedEntry,
  parseErrorEvent,
} from "../lib/chat-error-copy";
import { parseSseChunk } from "../lib/sse-parse";

// ── Recall chip ──────────────────────────────────
//
// `RecallMatch` mirrors the shape returned by GET /api/chat/recall.
// Defined locally here — the server's recall.ts cannot be imported from the
// client bundle (different runtime, different module graph).
//
// Chip lifecycle:
//   - On openConversation(): reset dismissed/counter + fetchRecall(conv.title)
//     if the conversation has a known first-user-message.
//   - On send() success: increment _recallSendCount; re-fetch every 3 sends
//     using the latest user message as the query.
//   - Escape-hatch icon (data-recall-from-draft): recallFromDraft() resets the
//     dismissed flag and fetches with the current composer draft.
//   - dismissRecall(): sets _recallDismissed = true, hides chip until
//     the next openConversation() or recallFromDraft() call.
//
// Click delegation (hx-boost / morph anti-pitfall):
//   init() binds a SINGLE document-level "click" listener that reads
//   `e.target.closest("[data-recall-open]")`. This survives element recreation
//   via Alpine x-for AND hx-boost cloneNode+replaceChild morphing. Direct
//   per-element addEventListener would be silently dropped on morph.

export type RecallMatch = { session_id: string; summary: string; similarity: number };

// ── Markdown renderer ─────────────────────────────────────────────────────────
//
// XSS-SAFE contract (verified in tests):
//   1. HTML-escape the entire source string FIRST (& < > " → entities).
//   2. Apply Markdown transforms on the escaped string only.
//   3. Any raw HTML or script tag in the model output becomes visible text.
//
// The allowed link schemes are https? only; javascript: and others are dropped.
// No external library — this is a minimal subset intentionally kept small.

/** HTML-escape the four unsafe chars. Same algorithm as repo-graph-popovers:_escHtml. */
function _esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }) as Record<string, string>)[c]!,
  );
}

/**
 * Render a minimal Markdown subset to an HTML string.
 *
 * XSS contract: the input is HTML-escaped FIRST so any raw HTML in `src` is
 * inert. The subsequent transforms introduce ONLY the allowed element set.
 *
 * Supported subset:
 *   - Fenced code blocks (```…```) → <pre><code>
 *   - Inline `code` → <code>
 *   - **bold** / __bold__ → <strong>
 *   - *italic* / _italic_ → <em>
 *   - # Headings (#, ##, ###) → <h2>, <h3>, <h4> (shifted: h1→h2 to stay in
 *     hierarchy since the panel already has implicit h1 context)
 *   - Unordered lists (- / * / + at line start) → <ul><li>
 *   - Ordered lists (1. at line start) → <ol><li>
 *   - [text](url) links — https? only (javascript:/data: etc. are dropped)
 *   - Paragraphs (blank-line separated) + line breaks within a paragraph
 */
export function renderMarkdown(src: string): string {
  // Step 1: HTML-escape the raw source — MUST happen before any transforms.
  // After this, any < > & " in model output is encoded; transforms only
  // introduce tags we deliberately construct.
  let s = _esc(src);

  // Step 2: Extract fenced code blocks BEFORE inline transforms so their
  // content is not touched by bold/italic/link passes.
  // We use a placeholder strategy: replace each fenced block with a sentinel,
  // run inline transforms on the remaining text, then splice blocks back in.
  const blocks: string[] = [];
  s = s.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_match, _lang, code: string) => {
    const idx = blocks.length;
    // code is already HTML-escaped (done in step 1). Wrap as-is.
    blocks.push(`<pre class="fc-md-pre"><code class="fc-md-code">${code.trimEnd()}</code></pre>`);
    return `\x00BLOCK${idx}\x00`;
  });

  // Step 3: Process line by line for headings + list detection.
  // We assemble a list of "segments" (HTML strings) then join them.
  const lines = s.split("\n");
  const output: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeUl = () => { if (inUl) { output.push("</ul>"); inUl = false; } };
  const closeOl = () => { if (inOl) { output.push("</ol>"); inOl = false; } };

  for (const rawLine of lines) {
    // Headings (### / ## / #) — only at block start (fenced code already extracted)
    const hMatch = rawLine.match(/^(#{1,3})\s+(.*)/);
    if (hMatch) {
      closeUl(); closeOl();
      // Shift heading levels: # → h2, ## → h3, ### → h4
      const level = hMatch[1].length + 1;
      output.push(`<h${level} class="fc-md-h">${inlineTransforms(hMatch[2])}</h${level}>`);
      continue;
    }

    // Unordered list item (- / * / + followed by space)
    const ulMatch = rawLine.match(/^[\-\*\+] (.*)/);
    if (ulMatch) {
      closeOl();
      if (!inUl) { output.push("<ul class=\"fc-md-ul\">"); inUl = true; }
      output.push(`<li>${inlineTransforms(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list item (1. / 2. etc.)
    const olMatch = rawLine.match(/^\d+\.\s+(.*)/);
    if (olMatch) {
      closeUl();
      if (!inOl) { output.push("<ol class=\"fc-md-ol\">"); inOl = true; }
      output.push(`<li>${inlineTransforms(olMatch[1])}</li>`);
      continue;
    }

    // All other lines: close any open list, then emit with inline transforms
    closeUl(); closeOl();
    output.push(inlineTransforms(rawLine));
  }
  closeUl(); closeOl();

  // Step 4: Join lines. Blank lines become paragraph breaks; non-blank
  // consecutive lines get a <br> between them. We post-process the joined
  // string for paragraph wrapping.
  let joined = output.join("\n");

  // Wrap groups of non-heading/non-list lines separated by blank lines into <p>.
  // Split on double newlines to detect paragraph boundaries.
  joined = joined
    .split(/\n{2,}/)
    .map((para) => {
      const trimmed = para.trim();
      if (!trimmed) return "";
      // If the para is already a block element (pre/ul/ol/h2-h6), don't wrap.
      if (/^<(pre|ul|ol|li|h[2-6])[\s>]/.test(trimmed)) return trimmed;
      // If the para is a raw fenced-block placeholder (not yet spliced), don't wrap —
      // the placeholder will be replaced with a <pre> in step 5.
      if (/^\x00BLOCK\d+\x00$/.test(trimmed)) return trimmed;
      // Replace remaining single \n with <br> inside the paragraph.
      return `<p class="fc-md-p">${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  // Step 5: Splice fenced blocks back in.
  joined = joined.replace(/\x00BLOCK(\d+)\x00/g, (_m, idx: string) => blocks[parseInt(idx, 10)] ?? "");

  return joined;
}

/** Apply inline transforms: code, bold, italic, links. Order matters:
 *  inline code first (to prevent bold/italic matching inside backtick spans),
 *  then bold (before italic to prevent ** from being treated as two *),
 *  then italic, then links. */
function inlineTransforms(s: string): string {
  // Inline code (`…`) — protect content from further transforms
  // Use a sentinel so nested patterns don't touch the code content.
  const codes: string[] = [];
  let r = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    const idx = codes.length;
    codes.push(`<code class="fc-md-ic">${c}</code>`);
    return `\x00CODE${idx}\x00`;
  });

  // Bold: **text** or __text__
  r = r.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a?: string, b?: string) =>
    `<strong>${a ?? b ?? ""}</strong>`,
  );

  // Italic: *text* or _text_ (not preceded/followed by another * or _)
  r = r.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
    (_m, a?: string, b?: string) => `<em>${a ?? b ?? ""}</em>`,
  );

  // Links: [text](url) — allow https? only; drop javascript:/data: etc.
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
    const safe = /^https?:/i.test(url.trim());
    if (!safe) return `[${text}](${url})`; // render as inert text
    return `<a href="${url.trim()}" target="_blank" rel="noopener noreferrer" class="fc-md-a">${text}</a>`;
  });

  // Splice inline code back in.
  r = r.replace(/\x00CODE(\d+)\x00/g, (_m, idx: string) => codes[parseInt(idx, 10)] ?? "");

  return r;
}

/**
 * Starter-prompt chips — node-aware-but-generic opening prompts shown in the
 * EMPTY state of a fresh conversation (zero messages). Clicking one sends it
 * immediately via the normal send() path. Frozen list (exported for the UI +
 * tests). Caller-impact / "what breaks if I change this" is deferred out of
 * scope intentionally.
 */
export const STARTER_PROMPTS: readonly string[] = [
  "What does this do?",
  "Explain it like I'm new to this codebase",
  "Walk me through it step by step",
  "What are the key functions and how do they connect?",
] as const;

export interface ViewedNode {
  target: { node_id: string } | { name: string; path: string; node_type?: string };
  projHash: string;
  label: string;
}

interface ChatMsg {
  role: "user" | "assistant";
  /** For failed/cancelled entries this is the FIXED display copy, never "". */
  text: string;
  /** absent = normal turn; "failed" → error card; "cancelled" → quiet marker */
  status?: "failed" | "cancelled";
  /** classified reason (absent on route-catch failures — copy falls back) */
  error_reason?: string;
}

/** Wire shape of GET /api/chat/sessions/:id/messages rows. */
interface ServerChatMsg {
  role: "user" | "assistant";
  text: string;
  status?: string;
  error_reason?: string;
  error_message?: string;
}

/**
 * Map a persisted row to its display entry. Failed rows arrive with content
 * "" — the fixed reason copy replaces it so a blank bubble can never render.
 * Cancelled rows show the quiet stopped marker (partial content not displayed).
 * Legacy stores also hold status-less assistant rows with blank content —
 * those render the fallback failure card too (they carry no reason enum, so
 * none is invented). User rows are never remapped.
 */
function toDisplayMsg(m: ServerChatMsg): ChatMsg {
  if (m.status === "failed") {
    return {
      role: m.role,
      text: chatErrorCopy(m.error_reason),
      status: "failed",
      ...(m.error_reason ? { error_reason: m.error_reason } : {}),
    };
  }
  if (m.status === "cancelled") {
    return { role: m.role, text: CHAT_STOPPED_MARKER, status: "cancelled" };
  }
  if (m.role === "assistant" && m.text.trim() === "") {
    return makeFailedEntry();
  }
  return { role: m.role, text: m.text };
}

interface Conversation {
  /** client-local id (tab key) */
  id: string;
  /** server session id, set from the first response's X-Siltpoke-Session-Id */
  serverSessionId: string | null;
  /** the viewed node this conversation is pinned to (null = unpinned/general) */
  anchor: ViewedNode | null;
  /**
   * The server-authoritative anchor node_id for desync detection.
   * Set from the session list for rehydrated convs (where `anchor` is null by
   * structural invariant). For locally-created convs, derived from `anchor` on
   * first send success. null = no anchor (general chat).
   */
  anchorNodeId: string | null;
  /** short label for the tab (basename / symbol name) */
  label: string;
  /** path-qualified label for the 📍 bar (e.g. src/eval/run-eval.ts › runEval) */
  pin: string;
  /** node type for the tab badge (fn/file) */
  badge: string;
  /** history-dropdown title: the conversation's first user message (from the
   *  session list); falls back to `label` when absent (e.g. a new local conv). */
  title?: string;
  /** whether the anchor has been sent to the server yet (pin happens once) */
  pinSent: boolean;
  /** ISO timestamp this conversation was created — drives the history-list
   *  newest-first sort and the per-row "created" label. Server-reported
   *  (started_at) for rehydrated convs; set to now for locally-created ones.
   *  Optional: absent (older fixtures / pre-timestamp convs) sorts last. */
  createdAt?: string | null;
  messages: ChatMsg[];
  /** server-reported message count (informational, from session list; absent on locally-created convs) */
  count?: number;
  /**
   * Per-conversation terminal state. Set when the backend returns
   * `blocked: "node_gone"` or when returnToNode() returns false for a pinned conv.
   * Once set, the conversation is permanently read-only — no further sends.
   * `undefined` = not terminal (normal state); `null` would be structurally
   * ambiguous so we use `undefined` as the absent-sentinel.
   *
   * Persistence: this flag is RUNTIME ONLY (not written to storage). On reload,
   * the next send() will re-block with node_gone (the backend always re-checks) —
   * so the read-only behavior is guaranteed across reloads without persisting the
   * flag.
   */
  terminalCta?: TerminalCtaState | null;
}

/**
 * Terminal conversation state. When set on a Conversation, the
 * composer is permanently disabled and a read-only banner is shown.
 * The only forward action is to start a new conversation (the "+" path).
 */
export interface TerminalCtaState {
  /** Human-readable anchor node name (for the UI banner). */
  nodeName: string;
}

/**
 * Budget/quiet-hours block state. Set when the backend returns
 * `blocked: "budget"` or `blocked: "quiet_hours"`. Shows an informational
 * notice; the user can dismiss it. Unlike the stale and terminal CTAs, this is
 * NOT per-conversation — it is a session-level condition (draft restored on
 * dismiss so the user can retry when the block lifts).
 */
export interface BlockedCta {
  /** Which condition caused the block. */
  reason: "budget" | "quiet_hours";
  /** Human-readable message shown to the user. */
  message: string;
}

/**
 * Pending CTA state. When send() detects desync (viewed ≠ anchor),
 * it populates this instead of sending. The UI renders two buttons that call
 * resolveDesync("reanchor") or resolveDesync("new"). Cleared after choice.
 */
export interface DesyncCta {
  /** The node the user is currently viewing (the "new" target). */
  targetLabel: string;
  /** The ChatAnchorRef for the PATCH re-anchor endpoint. */
  targetRef: { proj_hash: string } & (
    | { node_id: string }
    | { name: string; path: string; node_type?: string }
  );
  /** The message the user tried to send (held for dispatch after choice). */
  pendingMessage: string;
}

/**
 * Stale-fingerprint CTA state. When send() receives a
 * `blocked: "stale"` JSON signal from the backend, it populates this
 * instead of continuing to stream. The UI renders two buttons:
 *   "freeze" — re-send with `anchor_decision: "freeze"` (keep old context).
 *   "continue" — re-send with `anchor_decision: "continue"` (use new version).
 * Cleared after choice.
 *
 * Limitation: the detection is FILE-level only — a change to any sibling
 * symbol in the same file also triggers this. Surfaced in the UI copy so the
 * user understands the granularity.
 */
export interface StaleCta {
  /** ISO 8601 of when the conversation was pinned. */
  pinnedAt: string;
  /** Human-readable anchor node name (for the UI copy). */
  nodeName: string;
  /** The message the user tried to send (re-sent after choice). */
  pendingMessage: string;
}

/**
 * Minimal shape of the Alpine `$refs` map this island reads. Alpine injects
 * `$refs` onto the data object at runtime; it is absent in factory tests (no
 * Alpine), so it is optional and every read is guarded. We only reference the
 * `scrollBody` ref (the message-body container).
 */
interface AlpineRefs {
  scrollBody?: { scrollTop: number; scrollHeight: number };
}

export interface FloatingChatData {
  open: boolean;
  historyOpen: boolean;
  /**
   * Alpine-injected magic property (runtime only). Absent in factory tests, so
   * optional and always read-guarded. Used by scrollToBottom() to reach the
   * message-body container.
   */
  $refs?: AlpineRefs;
  /**
   * Alpine-injected magic — schedules a callback after the next DOM flush.
   * Runtime only (absent in factory tests). send() uses it to scroll AFTER the
   * appended message has rendered. Guarded: when absent we skip the scroll
   * entirely (no DOM to scroll anyway).
   */
  $nextTick?: (cb: () => void) => void;
  /**
   * Feature: maximize toggle — when true, the panel expands into a large
   * centered modal overlay. When false (default), the panel sits in the
   * bottom-right corner. Only applies when `open` is true; the launcher
   * (collapsed state) is unaffected.
   */
  maximized: boolean;
  conversations: Conversation[];
  activeId: string | null;
  draft: string;
  streaming: boolean;
  /**
   * Streaming-scope fix — the id of the conversation whose request is currently
   * in flight. Set when send() begins, cleared when it ends (success OR error).
   * The typing-dots indicator gates on `streamingConvId === activeId` so a
   * conversation the user switches AWAY from (or a freshly-created one) does NOT
   * show another conversation's dots. `null` = nothing streaming.
   */
  streamingConvId: string | null;
  /**
   * Abort handle for the in-flight send()'s fetch. Non-null only
   * while a turn is streaming; stopStreaming() aborts it. The abort path
   * appends the quiet cancelled marker to the ORIGINATING conversation and
   * never sets error copy (a stop is a user action, not a failure).
   */
  abortController: AbortController | null;
  error: string | null;
  /**
   * When not null, the user hit send while the current view ≠ the
   * active conversation's anchor. The UI renders a two-option CTA. Cleared
   * after the user makes a choice or cancels.
   */
  desyncCta: DesyncCta | null;
  /**
   * Internal — set during resolveDesync("reanchor") so that the send() call
   * triggered from within that handler bypasses the desync-intercept check.
   * Avoids an infinite re-intercept loop when the PATCH fails and the conv is
   * still technically desynced. Never set for the "new" branch (the new conv's
   * anchorNodeId is null so desync cannot fire). Never visible to the UI.
   */
  _resolvingDesync: boolean;
  /**
   * When not null, the backend returned a `blocked: "stale"` signal
   * (the pinned file's fingerprint changed since pin time). The UI renders a
   * freeze-vs-continue CTA. Cleared after the user makes a choice.
   * The composer is locked while this is set (same pattern as desyncCta).
   */
  staleCta: StaleCta | null;
  /**
   * When not null, the backend returned a `blocked: "budget"` or
   * `blocked: "quiet_hours"` signal. The UI shows an informational notice the
   * user can dismiss. The composer is disabled while the notice is showing.
   * Draft is restored on dismiss so the user can retry when the block lifts.
   */
  blockedCta: BlockedCta | null;
  /**
   * Computed accessor — returns the active conversation's
   * `terminalCta` (or null when the active conv is non-terminal / absent).
   * The UI checks this to render the dead-anchor banner and disable the composer.
   * Stored per-conversation so switching convs restores a live composer.
   */
  readonly terminalCta: TerminalCtaState | null | undefined;
  /** REACTIVE mirror of the bridge global. The window global itself isn't
   * Alpine-reactive, so the UI (canAddContext / empty state) would go stale on
   * node-select; the bridge fires `siltpoke:viewed-changed` → syncViewed()
   * updates this → Alpine re-renders. */
  viewed: ViewedNode | null;
  _seq: number;
  getViewed: () => ViewedNode | null;
  onGraph: () => boolean;
  syncViewed(): void;
  init(): void;
  active(): Conversation | null;
  /** History-list view order: conversations newest-created first. A non-mutating
   *  copy so the tab strip (which renders `conversations` directly) keeps its
   *  own order. Convs without a createdAt sort last (stable otherwise). */
  sortedConversations(): Conversation[];
  /** Format a conversation's createdAt ISO string for the history row (short
   *  local date + time). "" when absent so the row simply omits it. */
  fmtCreated(iso: string | null | undefined): string;
  canAddContext(): boolean;
  /** Node-vs-page COPY selector only; the "+" button is never gated
   * on this (see canAddContext). */
  viewingNode(): boolean;
  /** True when the active conversation has a focusable anchor target AND
   * the graph focus bridge is mounted (i.e. we're on the /repo-graph page). */
  canReturnToNode(): boolean;
  /** Call the reverse bridge to jump the repo-graph island to the active
   * conversation's pinned anchor node. Returns the bridge's boolean (true =
   * found and focused, false = node not in current graph). No-op when
   * canReturnToNode() is false.
   * If the bridge returns false AND the conversation is pinned, marks the
   * conversation terminal (the node is gone from the graph). */
  returnToNode(): Promise<boolean>;
  toggle(): void;
  _collapsePanel(): void;
  toggleHistory(): void;
  newConversation(): void;
  setActive(id: string): void;
  send(anchorDecision?: "freeze" | "continue"): Promise<void>;
  /**
   * Abort the in-flight turn. The composer's send button
   * swaps to this stop affordance while `streaming`. No-op at idle.
   */
  stopStreaming(): void;
  /**
   * Dismiss the budget/quiet-hours blocked notice. Clears the
   * blockedCta so the user can edit the draft and retry once the block lifts.
   */
  dismissBlockedCta(): void;
  /**
   * Maximize/restore toggle — flips `maximized`. Called by the header button
   * and by the Escape key handler. When restoring, also closes the backdrop.
   */
  toggleMaximize(): void;
  /**
   * Auto-scroll the message-body container to the bottom so the latest message
   * + composer stay in view. Reads the `scrollBody` ref (Alpine injects `$refs`
   * onto the data object at runtime). DOM-safe: no-ops when `$refs` / the
   * element is absent (e.g. in factory tests, no Alpine, no DOM). The Alpine
   * call sites wrap this in `$nextTick` so the new message/markdown has rendered
   * before we measure `scrollHeight`. Works in both corner + maximized layouts
   * (same container element).
   */
  scrollToBottom(): void;
  /**
   * Internal — schedule scrollToBottom() after the next DOM flush via
   * `$nextTick`. No-op when `$nextTick` is absent (factory tests). Called by
   * send() after appending the user message and the assistant reply.
   */
  _deferScroll(): void;
  /**
   * Streaming-scope fix — true ONLY when the currently-streaming conversation is
   * the active one. The typing-dots indicator gates on this so a different /
   * freshly-created conversation never shows another conv's dots.
   */
  isActiveStreaming(): boolean;
  /**
   * Internal — immutably append a message to the conversation identified by
   * `convId` (NOT necessarily the active one). Used by send() so streamed
   * deltas + the final reply always land in the ORIGINATING conversation even
   * if the user switched conversations mid-stream. No-op if the id is gone.
   */
  _appendMsg(convId: string, msg: ChatMsg): void;
  /**
   * Internal — immutably patch fields on the conversation with id `convId`
   * (the originating conv). Keeps send()'s metadata writes (serverSessionId,
   * pinSent, title, anchorNodeId) id-routed so they survive mid-stream
   * conversation switches. No-op if the id is gone.
   */
  _patchConv(convId: string, patch: Partial<Conversation>): void;
  /**
   * Thin Alpine-callable wrapper around the module-level `renderMarkdown`.
   * Exposed on the data object so Alpine `x-html="renderMd(m.text)"` can
   * call it without importing the module function directly.
   */
  renderMd(text: string): string;
  /**
   * Starter-prompt chips list (exposed for the UI x-for + tests). Mirrors the
   * module-level STARTER_PROMPTS constant.
   */
  starterPrompts: readonly string[];
  /**
   * Whether the starter-prompt chips should show: true ONLY when there is an
   * active conversation with zero messages AND no CTA (desync/stale/terminal/
   * blocked) is pending. False otherwise (no conv / conv-with-messages / CTA).
   */
  showStarters(): boolean;
  /**
   * Click handler for a starter chip — sets the draft to `prompt` and sends it
   * via the normal send() path (all pre-flight gates / anchor logic / auto-
   * scroll apply). After it lands, the conversation has a message → chips hide.
   */
  sendStarter(prompt: string): Promise<void>;
  /** Dispatched when the user makes a desync CTA choice. */
  resolveDesync(choice: "reanchor" | "new"): Promise<void>;
  /** Internal helpers extracted from resolveDesync to reduce complexity. */
  _handleReanchor(cta: DesyncCta, conv: { id: string; serverSessionId: string | null }): Promise<void>;
  _handleNewConv(cta: DesyncCta): Promise<void>;
  /**
   * Dispatched when the user makes a stale CTA choice.
   * "freeze": re-send with `anchor_decision: "freeze"` (keep old version context).
   * "continue": re-send with `anchor_decision: "continue"` (use new version context).
   */
  resolveStale(choice: "freeze" | "continue"): Promise<void>;
  loadSessions(): Promise<void>;
  openConversation(id: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  // ── recall ────────────────────────────────────
  /**
   * Runtime surface gate — mirrors RECALL_SURFACE_ENABLED from SSR via the
   * `data-recall-enabled` attribute on the panel root. When false (default):
   * fetchRecall / toggleRecall are no-ops; no HTTP calls are made. The recall
   * mechanism code stays in the bundle; flip the flag to restore behaviour.
   */
  recallEnabled: boolean;
  /** Top 1-3 past chats returned by the last /api/chat/recall fetch. */
  recallMatches: RecallMatch[];
  /** True when the user explicitly dismissed recall (hidden until next
   *  openConversation() call or manual recallFromDraft()). */
  _recallDismissed: boolean;
  /** Counts successful sends in the current conversation — used to gate the
   *  debounced re-fetch (every 3rd send). Reset on openConversation(). */
  _recallSendCount: number;
  /** Whether the related-chats dropdown is open. Toggled by the 🔗 toolbar button. */
  recallOpen: boolean;
  /** Toggle the related-chats dropdown; closes historyOpen when opening (mutual exclusion). */
  toggleRecall(): void;
  /** True when recallMatches is non-empty and recall has NOT been dismissed. */
  showRecall(): boolean;
  /** Fetch recall for the given query + optional sessionId-to-exclude.
   *  Fail-open: errors clear matches silently. */
  fetchRecall(q: string, sessionId?: string | null): Promise<void>;
  /** User dismissed recall — hides it until the next open/escape-hatch. */
  dismissRecall(): void;
  /** Escape-hatch: reset dismissed + fetch recall with current draft text
   *  + open the dropdown so the user sees the refreshed results. */
  recallFromDraft(): Promise<void>;

  // ── context transparency bar ───────────────────────────────────
  /** Injectable current-pathname reader — defaults to `location.pathname`.
   *  Tests inject a fixed value; production reads the real browser location. */
  pageProvider: () => string;
  /** Last-fetched `/api/chat/context-preview` result, mapped from the
   *  snake_case wire shape (`page_label`/`facts_count`) to camelCase. `null`
   *  before the first successful fetch. */
  contextPreview: { pageLabel: string; factsCount: number } | null;
  /** Fetch `/api/chat/context-preview?page=<pageProvider()>` and store the
   *  mapped result. Fail-open: a non-ok response or a network error leaves
   *  `contextPreview` unchanged (the chip bar just doesn't update this cycle). */
  refreshContextPreview(): Promise<void>;
  /** Compose the transparency-bar chip values: the active conversation's
   *  pinned-node label (null when unanchored/no active conv), the last-fetched
   *  page label, and the last-fetched facts count. INTENDED: `facts` reflects
   *  the same value on every page — user-facts recall injects into every chat
   *  message regardless of the page being viewed, so this is not scoped by
   *  `node`/`page`. */
  contextChips(): { node: string | null; page: string; facts: number };
}

/** The bridge event repo-graph fires after writing window.__siltpokeViewedNode. */
export const VIEWED_CHANGED_EVENT = "siltpoke:viewed-changed";

/** Path-qualified label for the 📍 bar: the file's relative path, and for a
 * symbol the `path › name` so you see WHERE it lives, not just the basename. */
function pinLabel(v: ViewedNode): string {
  const t = v.target;
  if (!("path" in t)) return v.label; // node_id form (no path) → fall back
  if ("node_type" in t && t.node_type && t.node_type !== "file") {
    return `${t.path} › ${t.name}`;
  }
  return t.path;
}

function badgeFor(v: ViewedNode | null): string {
  if (!v) return "";
  const t = v.target;
  if ("node_type" in t && t.node_type) return t.node_type === "file" ? "file" : "fn";
  return "fn";
}

/** Read the repo-graph bridge global (the node the user is currently viewing). */
function readViewed(): ViewedNode | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __siltpokeViewedNode?: ViewedNode | null };
  return w.__siltpokeViewedNode ?? null;
}

/** Read the reverse bridge (repo-graph focus entry point). Returns null
 * when the /repo-graph island is not mounted (the user is on another page). */
function readFocusBridge(): ((target: ViewedNode["target"]) => Promise<boolean>) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __siltpokeFocusNode?: (target: ViewedNode["target"]) => Promise<boolean> };
  return typeof w.__siltpokeFocusNode === "function" ? w.__siltpokeFocusNode : null;
}

/** On the repo-graph surface? (its island root is present only there.)
 * NOTE: the root is `<div class="rg-host">` — a CLASS, not an id. Checking
 * `#rg-host` (id) was always null → "+" was always disabled — the real
 * root cause behind "still doesn't work". */
function onRepoGraph(): boolean {
  if (typeof document === "undefined") return false;
  return !!document.querySelector(".rg-host");
}

/**
 * Extract the node_id from a ViewedNode for desync comparison.
 * For node_id targets (trace view), that's direct.
 * For descriptor targets, the id isn't available client-side — we use a
 * canonical key of `${path}:${name}` to compare. This is safe because
 * the anchor is also stored as a descriptor-based server anchorNodeId only
 * if the client sent a descriptor (the server's node_id comes back via the
 * session anchor metadata). For desync detection we only need to know if the
 * user is looking at the SAME thing — a mismatch on either form → CTA.
 *
 * The real comparison is: if the viewed node's server node_id == conversation
 * anchorNodeId, they match. We can only know the server node_id when the
 * PATCH or create returned it (stored in anchorNodeId). So the FE comparison
 * is: anchorNodeId != null && viewedMatchesAnchor.
 *
 * For a locally-created conv that hasn't received a server reply yet
 * (anchorNodeId = null), we can't compare — treat as in-sync (no CTA).
 */
function viewedMatchesAnchor(viewed: ViewedNode, anchorNodeId: string): boolean {
  const t = viewed.target;
  if ("node_id" in t) {
    return t.node_id === anchorNodeId;
  }
  // Descriptor form — compare the path:name string to anchorNodeId.
  // The server stores `type:path:name` as the canonical node_id. We need
  // both the path AND the name to match exactly:
  //   - endsWith(`:${t.name}`) checks the name segment (colon-delimited, so
  //     "Fn" won't match "myFn" via suffix — `:myFn` ≠ `:Fn`).
  //   - includes(`:${t.path}:`) anchors the path between colons to prevent a
  //     prefix match: `src/foo` matching `src/fooBar.ts` is a false positive.
  //     With `:src/foo.ts:` the match is exact for the path
  //     segment (type:PATH:name — colon on both sides of path).
  return anchorNodeId.endsWith(`:${t.name}`) && anchorNodeId.includes(`:${t.path}:`);
}

/** Build the ChatAnchorRef from a ViewedNode for the PATCH re-anchor call. */
function anchorRefFrom(v: ViewedNode): { proj_hash: string } & (
  | { node_id: string }
  | { name: string; path: string; node_type?: string }
) {
  return { ...v.target, proj_hash: v.projHash };
}

/** Mirrors the server SESSION_ID_RE — safe filename chars only (no `.` or `/`).
 * Used client-side to guard the serverSessionId before interpolating it into
 * the PATCH URL (defense-in-depth; the server also validates). */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function makeFloatingChatData(
  fetchFn: typeof fetch = fetch,
  deps: {
    getViewed?: () => ViewedNode | null;
    onGraph?: () => boolean;
    /** Injectable for tests; defaults to reading window.__siltpokeFocusNode. */
    getFocusBridge?: () => ((target: ViewedNode["target"]) => Promise<boolean>) | null;
    /**
     * RECALL_SURFACE_ENABLED gate — inject `true` in tests that exercise the recall
     * mechanism. In production, init() reads the value from the SSR-rendered
     * `data-recall-enabled` attribute on the panel root (overrides this default).
     * Default: false (surface parked 2026-06-26).
     */
    recallEnabled?: boolean;
    /** Injectable current-pathname reader for tests; defaults to
     *  reading `location.pathname` (falls back to `"/"` when `location` is
     *  undefined, e.g. non-browser test environments). */
    pageProvider?: () => string;
  } = {},
): FloatingChatData {
  return {
    open: false,
    historyOpen: false,
    maximized: false,
    conversations: [],
    activeId: null,
    draft: "",
    streaming: false,
    streamingConvId: null,
    abortController: null,
    error: null,
    desyncCta: null,
    _resolvingDesync: false,
    staleCta: null,
    blockedCta: null,
    // ── recall state ────────────────────────────
    // recallEnabled is set from deps (tests) or overridden in init() from the
    // SSR-projected data-recall-enabled attribute on the panel root.
    recallEnabled: deps.recallEnabled ?? false,
    recallMatches: [] as RecallMatch[],
    _recallDismissed: false,
    _recallSendCount: 0,
    recallOpen: false,
    /** Computed: active conv's terminalCta, or null when not terminal. */
    get terminalCta(): TerminalCtaState | null | undefined {
      // `this` is the FloatingChatData object at runtime (Alpine's proxy / the
      // plain object in tests). Accessing `this.active()` works in both contexts.
      const conv = (this as FloatingChatData).active();
      return conv?.terminalCta ?? null;
    },
    viewed: null,
    _seq: 0,
    getViewed: deps.getViewed ?? readViewed,
    onGraph: deps.onGraph ?? onRepoGraph,
    // ── context transparency bar ─────────────────────────────────
    pageProvider: deps.pageProvider ?? (() => (typeof location !== "undefined" ? location.pathname : "/")),
    contextPreview: null,

    /** Pull the current bridge value into the reactive mirror. */
    syncViewed() {
      this.viewed = this.getViewed();
    },

    /** Alpine lifecycle — seed the mirror + subscribe to the bridge event so
     * selecting a node re-renders the (already-open) panel. The listener is on
     * window + this element is hx-preserved (init runs once), so it survives
     * hx-boost nav without the listener-drop pitfall. */
    init() {
      this.syncViewed();
      if (typeof document !== "undefined") {
        // Read the SSR-projected RECALL_SURFACE_ENABLED flag from the panel root.
        // Overrides the factory default so production Alpine reads the real value;
        // tests that don't mount a DOM element keep the deps.recallEnabled value.
        const panelEl = document.getElementById("siltpoke-floating-chat");
        if (panelEl) {
          (this as FloatingChatData).recallEnabled =
            panelEl.getAttribute("data-recall-enabled") === "1";
        }
      }
      if (typeof window !== "undefined") {
        window.addEventListener(VIEWED_CHANGED_EVENT, () => this.syncViewed());
        // Collapse the panel to the 💬 launcher when the user navigates to
        // another page. hx-preserve keeps the conversation alive across the
        // boost morph (one click on 💬 brings it back); we only tidy the panel
        // away. Bind to several nav signals so it fires regardless of htmx
        // version / nav style: a boosted request (sidebar links — collapses on
        // click, before the swap), browser back/forward (popstate), and the
        // history-push event (fallback). Gated on `boosted` so a non-nav htmx
        // request never collapses the panel. Once-bound (init runs once) on
        // body/window which survive the morph → no listener-drop pitfall.
        document.body.addEventListener("htmx:beforeRequest", (e: Event) => {
          const detail = (e as CustomEvent).detail as { boosted?: boolean } | undefined;
          if (detail?.boosted) this._collapsePanel();
        });
        document.body.addEventListener("htmx:pushedIntoHistory", () => this._collapsePanel());
        window.addEventListener("popstate", () => this._collapsePanel());
        // Escape key: restore maximized panel to corner, or close open dropdowns.
        window.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key !== "Escape") return;
          if (this.maximized) {
            this.maximized = false;
          } else if (this.historyOpen) {
            this.historyOpen = false;
          } else if ((this as FloatingChatData).recallOpen) {
            (this as FloatingChatData).recallOpen = false;
          }
        });

        // ── Recall delegation ────────────────
        // ONE document-level delegated click handler covers recall-related
        // interactions. This is the CRITICAL anti-pitfall: direct per-element
        // addEventListener would be silently dropped when hx-boost cloneNode-
        // replaces the dropdown's parent element on navigation. Document-level
        // delegation fires regardless of whether the target element was created
        // before or after the listener was added — even across cloneNode morph.
        //
        // Two targets, identified by data attributes:
        //   [data-recall-open]       — dropdown entry click → openConversation(sessionId)
        //   [data-recall-from-draft] — escape-hatch icon → recallFromDraft()
        //
        // Shared handler: called from both click and keydown so the body is never
        // duplicated. Returns true if a recall target was matched (used by keydown
        // to know whether to preventDefault for Space).
        const handleRecallTarget = (target: HTMLElement): boolean => {
          // When recall surface is disabled, these elements won't be rendered,
          // but guard here too so the delegated handler is always a no-op.
          if (!(this as FloatingChatData).recallEnabled) return false;
          const openEl = target.closest<HTMLElement>("[data-recall-open]");
          if (openEl) {
            const sessionId = openEl.getAttribute("data-recall-open");
            if (sessionId) {
              this.historyOpen = false;
              (this as FloatingChatData).recallOpen = false;
              void this.openConversation(sessionId);
            }
            return true;
          }
          const draftEl = target.closest("[data-recall-from-draft]");
          if (draftEl) {
            void this.recallFromDraft();
            return true;
          }
          return false;
        };

        document.addEventListener("click", (e: MouseEvent) => {
          handleRecallTarget(e.target as HTMLElement);
        });

        // Keyboard accessibility (a11y): chip entries are <div role="button"
        // tabindex="0"> which don't fire click on Enter/Space by default.
        // Mirror the click delegation exactly — same closest() targets, same
        // document-level pattern so it also survives hx-boost morph.
        document.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          const target = e.target as HTMLElement;
          const matched = handleRecallTarget(target);
          if (matched && e.key === " ") e.preventDefault(); // avoid page scroll
        });
      }
      void this.loadSessions();
    },

    active() {
      return this.conversations.find((c) => c.id === this.activeId) ?? null;
    },

    sortedConversations() {
      // Newest-created first. Non-mutating (slice) so the underlying array order
      // — and the tab strip that renders it — is untouched. Missing createdAt
      // sorts last. The server list already arrives sorted, but locally-created
      // convs are appended at the end, so re-sort the VIEW to keep newest on top.
      return [...this.conversations].sort((a, b) => {
        const av = a.createdAt ?? "";
        const bv = b.createdAt ?? "";
        if (av === bv) return 0;
        if (av === "") return 1;
        if (bv === "") return -1;
        return bv.localeCompare(av);
      });
    },

    fmtCreated(iso) {
      if (!iso) return "";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "";
      // Short, locale-aware: "Jun 23, 20:38" style — date + 24h time, no seconds.
      const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      return `${date} · ${time}`;
    },

    /** A chat can always be started, from any page: the current
     * page grounds it (deriveLabels(null) → "Chat" server-side), a viewed
     * node just enriches/pins it when present. Kept as a method (not inlined)
     * because several bindings reference it by name. */
    canAddContext() {
      return true;
    },

    /** True only on the repo-graph surface with a node in view.
     * Used SOLELY to pick node-vs-page COPY (placeholder/empty-state/titles);
     * never to gate the "+" button (see canAddContext above). */
    viewingNode() {
      return this.onGraph() && this.viewed !== null;
    },

    /** True when the active conversation has a focusable anchor AND the
     * graph focus bridge is mounted (we're on the /repo-graph page). The anchor
     * is taken from the anchor field (locally-created conv) OR anchorNodeId
     * (rehydrated conv that has a server-resolved node_id). Subdirs are not
     * anchorable (publishViewed publishes null for them), so a conv without an
     * anchor target = false. */
    canReturnToNode() {
      const conv = this.active();
      if (!conv) return false;
      const hasFocusTarget = conv.anchor !== null || conv.anchorNodeId !== null;
      if (!hasFocusTarget) return false;
      // Bridge only present when the repo-graph island is mounted.
      const bridge = (deps.getFocusBridge ?? readFocusBridge)();
      return bridge !== null;
    },

    /** Drives the repo-graph island to focus the active conversation's
     * pinned anchor node. No-op (returns false) if canReturnToNode() is false.
     * If the bridge returns false AND the conv is pinned (has an anchor),
     * mark the conversation terminal (node is gone from the current graph). */
    async returnToNode() {
      const conv = this.active();
      if (!conv) return false;
      const bridge = (deps.getFocusBridge ?? readFocusBridge)();
      if (!bridge) return false;
      // Prefer the local ViewedNode anchor (has full descriptor) over anchorNodeId
      // (only the server node_id — falls back to node_id form).
      const target: ViewedNode["target"] | null = conv.anchor
        ? conv.anchor.target
        : conv.anchorNodeId
        ? { node_id: conv.anchorNodeId }
        : null;
      if (!target) return false;
      const found = await bridge(target);
      if (!found) {
        // Bridge couldn't find the node — mark the conversation terminal.
        // Reaching here means target is non-null (we returned false above otherwise),
        // so conv.anchor !== null || conv.anchorNodeId !== null is always true here.
        // A general-chat conv (no anchor) never reaches this point (target is null →
        // returned false above). The isPinned guard is therefore redundant.
        this.conversations = this.conversations.map((c) =>
          c.id === conv.id
            ? { ...c, terminalCta: { nodeName: conv.label } }
            : c,
        );
      }
      return found;
    },

    toggle() {
      this.open = !this.open;
      // Closing always returns to corner layout — otherwise re-opening via the
      // launcher would resurrect the maximized modal the user just dismissed.
      if (!this.open) {
        this.maximized = false;
      } else {
        // Refresh the transparency-bar preview on open so it reflects
        // the page the user is currently viewing.
        void (this as FloatingChatData).refreshContextPreview();
      }
    },

    /** Tidy the panel away to the launcher on page navigation — keeps the
     * conversation alive (hx-preserve), just collapses the open/history/maximize
     * UI state. Bound to nav events in init(); exposed for direct testing. */
    _collapsePanel() {
      this.open = false;
      this.historyOpen = false;
      this.maximized = false;
      (this as FloatingChatData).recallOpen = false;
    },

    toggleHistory() {
      this.historyOpen = !this.historyOpen;
      // Mutual exclusion: opening history closes the recall dropdown.
      if (this.historyOpen) (this as FloatingChatData).recallOpen = false;
    },

    toggleRecall(): void {
      const self = this as FloatingChatData;
      // Surface parked: no-op when recall is disabled (flag controls visibility).
      if (!self.recallEnabled) return;
      self.recallOpen = !self.recallOpen;
      // Mutual exclusion: opening recall closes the history dropdown.
      if (self.recallOpen) self.historyOpen = false;
    },

    async loadSessions() {
      try {
        const res = await fetchFn("/api/chat/sessions");
        if (!res.ok) {
          this.error = `history load failed (HTTP ${res.status})`;
          return;
        }
        const { sessions } = (await res.json()) as {
          sessions: Array<{
            id: string;
            anchor: { node_id: string; node_name: string; node_type: string } | null;
            label: string;
            pin: string;
            badge: string;
            title: string;
            message_count: number;
            started_at: string;
          }>;
        };
        // Skip the overwrite if the user already started a local conversation while
        // the request was in flight (slow-network race) — their unsaved session
        // would be silently dropped by a wholesale replacement.
        const hasLocalConv = this.conversations.some((c) => c.serverSessionId === null);
        if (!hasLocalConv) {
          this.conversations = sessions.map((s) => ({
            id: s.id,
            serverSessionId: s.id,
            // anchor stays null for rehydrated convs: the server `s.anchor` is a
            // stored ChatAnchor ({node_id, proj_hash, node_name, ...}), NOT the
            // ViewedNode shape send() consumes — wrapping it (with projHash="")
            // would make a re-pin POST `{...ChatAnchor, proj_hash: ""}` → server
            // resolves against an empty proj_hash (silent wrong-repo). Rehydrated
            // convs are already pinned (pinSent: true) and must never re-pin, so
            // null makes that invariant structural. label/pin/badge come from the
            // list row separately, so the 📍 bar + tabs are unaffected.
            anchor: null,
            // Store the server anchor node_id for desync detection.
            // This is the ONLY field we need from the server anchor for the
            // send-while-desynced check.
            anchorNodeId: s.anchor?.node_id ?? null,
            label: s.label,
            pin: s.pin,
            badge: s.badge,
            title: s.title,
            pinSent: true,
            createdAt: s.started_at,
            messages: [],
            count: s.message_count,
          }));
          if (this.conversations.length > 0) await this.openConversation(this.conversations[0].id);
        }
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      }
    },

    async openConversation(id: string) {
      const conv = this.conversations.find((c) => c.id === id);
      if (!conv) return;
      // Clear any sticky history-load error so a transient failure banner doesn't
      // shadow a now-working conversation view.
      this.error = null;
      if (conv.messages.length === 0 && (conv.count ?? 0) > 0 && conv.serverSessionId) {
        try {
          const res = await fetchFn(`/api/chat/sessions/${conv.serverSessionId}/messages`);
          if (res.ok) {
            // Persisted failed/cancelled rows map to display entries here —
            // ingestion-time mapping so an empty-content failed row can never
            // reach the DOM as a blank assistant bubble.
            const fetched = ((await res.json()) as { messages: ServerChatMsg[] }).messages.map(
              toDisplayMsg,
            );
            // Immutable update so Alpine sees the array reference change and re-renders.
            this.conversations = this.conversations.map((c) =>
              c.id === id ? { ...c, messages: fetched } : c,
            );
          }
        } catch {
          /* keep empty; non-fatal */
        }
      }
      this.activeId = id;
      this.historyOpen = false;
      (this as FloatingChatData).recallOpen = false;
      // Auto-scroll: when opening/switching a conversation, land at the latest
      // message (deferred so the rehydrated messages have rendered first).
      this._deferScroll();

      // ── recall: reset state for this conversation + trigger initial fetch
      this._recallDismissed = false;
      this._recallSendCount = 0;
      this.recallMatches = [];
      // Use conv.title (first user message) as the query for the initial recall.
      // conv.title and conv.serverSessionId are not mutated by the messages-load
      // map above, so using the original `conv` ref is equivalent here.
      const recallQ = conv.title;
      if (recallQ) {
        void this.fetchRecall(recallQ, conv.serverSessionId ?? null);
      }
    },

    async deleteConversation(id: string) {
      const conv = this.conversations.find((c) => c.id === id);
      if (conv?.serverSessionId) {
        try {
          await fetchFn(`/api/chat/sessions/${conv.serverSessionId}`, { method: "DELETE" });
        } catch {
          /* still drop locally */
        }
      }
      const idx = this.conversations.findIndex((c) => c.id === id);
      this.conversations = this.conversations.filter((c) => c.id !== id);
      if (this.activeId === id) {
        const next = this.conversations[idx] ?? this.conversations[idx - 1] ?? null;
        this.activeId = next ? next.id : null;
        if (next) await this.openConversation(next.id);
      }
    },

    /** Start a new conversation: pinned to the currently-viewed node when on
     * the repo-graph with one in view, otherwise UN-ANCHORED — this
     * lets ANY page start a chat; the server grounds an anchor:null
     * conversation via deriveLabels(null) → "Chat". */
    newConversation() {
      this.syncViewed();
      const viewed = this.onGraph() ? this.viewed : null;
      const id = `c${++this._seq}`;
      const conv: Conversation = viewed
        ? {
            id,
            serverSessionId: null,
            anchor: viewed,
            anchorNodeId: null, // set on first successful send (server resolves)
            label: viewed.label,
            pin: pinLabel(viewed),
            badge: badgeFor(viewed),
            pinSent: false,
            createdAt: new Date().toISOString(),
            messages: [],
          }
        : {
            id,
            serverSessionId: null,
            anchor: null,
            anchorNodeId: null,
            label: "Chat",
            pin: "",
            badge: "",
            pinSent: true, // nothing to pin — send() must never try to pin a null anchor
            createdAt: new Date().toISOString(),
            messages: [],
          };
      this.conversations = [...this.conversations, conv];
      this.activeId = id;
    },

    setActive(id: string) {
      if (this.conversations.some((c) => c.id === id)) this.activeId = id;
    },

    // ── recall methods ──────────────────────────

    showRecall(): boolean {
      return (this as FloatingChatData).recallMatches.length > 0 &&
        !(this as FloatingChatData)._recallDismissed;
    },

    async fetchRecall(q: string, sessionId?: string | null): Promise<void> {
      // Surface parked: no HTTP call when recall is disabled (avoids wasted embed/IO).
      if (!(this as FloatingChatData).recallEnabled) return;
      const trimmed = q.trim();
      if (!trimmed) return;
      const params = new URLSearchParams({ q: trimmed });
      if (sessionId) params.set("session", sessionId);
      try {
        const res = await fetchFn(`/api/chat/recall?${params.toString()}`);
        if (!res.ok) {
          (this as FloatingChatData).recallMatches = [];
          return;
        }
        const { matches } = (await res.json()) as { matches: RecallMatch[] };
        // Cap at 3 matches (server may return more)
        (this as FloatingChatData).recallMatches = Array.isArray(matches) ? matches.slice(0, 3) : [];
      } catch {
        (this as FloatingChatData).recallMatches = [];
      }
    },

    dismissRecall(): void {
      (this as FloatingChatData)._recallDismissed = true;
    },

    async recallFromDraft(): Promise<void> {
      const q = (this as FloatingChatData).draft.trim();
      if (!q) return;
      // Reset dismissed so recall shows fresh results (explicit user action)
      (this as FloatingChatData)._recallDismissed = false;
      const conv = (this as FloatingChatData).active();
      await (this as FloatingChatData).fetchRecall(q, conv?.serverSessionId ?? null);
      // Open the dropdown so the user sees the refreshed results immediately.
      (this as FloatingChatData).recallOpen = true;
    },

    // ── end recall methods ────────────────────────────────────────────────────

    // ── context transparency bar ───────────────────────────────────
    async refreshContextPreview(): Promise<void> {
      const self = this as FloatingChatData;
      try {
        const page = self.pageProvider();
        const res = await fetchFn(`/api/chat/context-preview?page=${encodeURIComponent(page)}`);
        if (!res.ok) return; // fail-open — keep the last-known preview
        const data = (await res.json()) as { page_label?: string; facts_count?: number };
        self.contextPreview = {
          pageLabel: data.page_label ?? "",
          factsCount: data.facts_count ?? 0,
        };
      } catch {
        // fail-open — a network error just leaves the chip bar stale for
        // this cycle; the next open/send retries.
      }
    },

    contextChips() {
      const self = this as FloatingChatData;
      const conv = self.active();
      return {
        node: conv?.pin ?? null,
        page: self.contextPreview?.pageLabel ?? "",
        facts: self.contextPreview?.factsCount ?? 0,
      };
    },

    // ── end context transparency bar ────────────────────────────────────────

    async send(anchorDecision?: "freeze" | "continue") {
      const conv = this.active();
      const text = this.draft.trim();
      if (!conv || !text || this.streaming) return;

      // While the desync CTA is showing, the composer must be locked.
      if (this.desyncCta !== null) return;

      // While the stale CTA is showing, the composer must be locked.
      // The pending message is held in staleCta.pendingMessage; resolveStale() will
      // re-call send() with the appropriate anchor_decision after the user chooses.
      if (this.staleCta !== null) return;

      // While the blocked notice is showing, the composer must be
      // locked. The user dismisses it (which restores the draft) and retries.
      if (this.blockedCta !== null) return;

      // Terminal conversation (dead anchor) → permanently locked.
      // No override; the user must start a new conversation.
      if (conv.terminalCta != null) return;

      // Desync detection: fires ONLY on send, NOT on navigation.
      // Compare the current viewed node to the conversation's pinned anchor.
      // Skip if: no viewed node, no anchor, anchorNodeId unknown yet, OR we
      // are already executing within resolveDesync("reanchor") (bypass flag set
      // to prevent re-intercept when PATCH failed and conv is still desynced).
      const viewed = this.viewed;
      const desynced =
        !this._resolvingDesync &&
        viewed !== null &&
        conv.anchorNodeId !== null &&
        !viewedMatchesAnchor(viewed, conv.anchorNodeId);

      if (desynced) {
        // Intercept: don't send yet, show the CTA instead.
        this.desyncCta = {
          targetLabel: viewed.label,
          targetRef: anchorRefFrom(viewed),
          pendingMessage: text,
        };
        return;
      }

      // Streaming-scope fix — capture the ORIGINATING conversation id NOW. All
      // appends + metadata writes below route by this id, so switching/creating
      // a conversation mid-stream never misroutes the reply or shows its dots.
      const convId = conv.id;

      this._appendMsg(convId, { role: "user", text });
      this.draft = "";
      this.error = null;
      this.streaming = true;
      this.streamingConvId = convId;
      this.abortController = new AbortController();
      // Auto-scroll: land the just-sent user message + the streaming indicator
      // at the bottom (deferred to after the DOM renders them). Only scrolls the
      // active conv (scrollToBottom targets the single rendered scroll body).
      this._deferScroll();

      // The anchor rides ONLY the first request of a pinned conversation (the
      // server pins on conversation create; later turns reuse the frozen
      // context via session_id).
      // Every request carries the current page so the backend's
      // context-transparency preview (and future page-scoped recall) stays
      // aligned with what the user is looking at when they send.
      const body: Record<string, unknown> = { message: text, page: this.pageProvider() };
      if (conv.serverSessionId) body.session_id = conv.serverSessionId;
      if (conv.anchor && !conv.pinSent) {
        body.anchor = { ...conv.anchor.target, proj_hash: conv.anchor.projHash };
      }
      // Forward the anchor_decision when the user resolved a stale CTA.
      if (anchorDecision !== undefined) body.anchor_decision = anchorDecision;

      let buffer = "";
      // Set when the server sends a classified `error` event; the failure
      // renders as an in-transcript card in the ORIGINATING conversation.
      let streamFailure: { reason?: string } | null = null;
      try {
        const res = await fetchFn("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: this.abortController.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // Detect a JSON blocked signal vs a normal SSE stream.
        // The backend returns Content-Type: application/json for blocked signals,
        // and text/event-stream for normal streams.
        const ct = res.headers.get("content-type") ?? "";
        if (ct.startsWith("application/json")) {
          // Blocked signal — undo the optimistic user message render (id-routed
          // so it targets the ORIGINATING conv even after a mid-stream switch).
          this._patchConv(convId, {
            messages: (this.conversations.find((c) => c.id === convId)?.messages ?? []).slice(0, -1),
          });
          this.streaming = false;

          const signal = (await res.json()) as { blocked?: string; pinned_at?: string; node_name?: string; used_pct?: number };
          if (signal.blocked === "node_gone") {
            // Dead anchor — terminal state. No re-send possible.
            // Draft is NOT restored (no CTA to show; the user starts fresh).
            // Immutable update so Alpine sees the reference change and re-renders.
            this._patchConv(convId, { terminalCta: { nodeName: signal.node_name ?? conv.label } });
            return;
          }
          if (signal.blocked === "stale") {
            // Stale fingerprint — offer freeze vs continue.
            // Restore the draft so the user still sees what they typed.
            this.draft = text;
            this.staleCta = {
              pinnedAt: signal.pinned_at ?? "",
              nodeName: signal.node_name ?? conv.label,
              pendingMessage: text,
            };
            return;
          }
          if (signal.blocked === "budget") {
            // Daily budget hard-stop. Show dismissible notice.
            // Restore the draft so the user can retry once the budget resets.
            this.draft = text;
            this.blockedCta = {
              reason: "budget",
              message: "Daily budget reached — chat is paused until it resets.",
            };
            return;
          }
          if (signal.blocked === "quiet_hours") {
            // Quiet hours active. Show dismissible notice.
            // Restore the draft so the user can retry once quiet hours end.
            this.draft = text;
            this.blockedCta = {
              reason: "quiet_hours",
              message: "Quiet hours are on — chat is paused.",
            };
            return;
          }
          return;
        }

        if (!res.body) throw new Error("no response body");

        // Metadata writes — id-routed via _patchConv so they land on the
        // ORIGINATING conv (not the live active one) even after a mid-stream
        // switch. Build a single patch then apply once.
        const metaPatch: Partial<Conversation> = { pinSent: true };
        const sid = res.headers.get("X-Siltpoke-Session-Id");
        if (sid) metaPatch.serverSessionId = sid;
        // The first user message becomes the history-dropdown title (mirrors the
        // server's creation-only session.summary). Set it locally on the first
        // send so the title shows immediately, without waiting for a reload to
        // rehydrate it from the server. Guard → once only (first message).
        if (!conv.title) metaPatch.title = text;

        // After the first successful send of a pinned conv, the server has
        // resolved the anchor node_id. We need it for future desync detection.
        // The server sends it back via the anchor sidecar, but we don't read that
        // here. Instead: if the conv has a local ViewedNode anchor, derive
        // anchorNodeId from its node_id target (available for node_id form).
        // For descriptor targets, anchorNodeId stays null until re-anchor tells us.
        if (conv.anchorNodeId === null && conv.anchor) {
          const t = conv.anchor.target;
          if ("node_id" in t) metaPatch.anchorNodeId = t.node_id;
        }
        this._patchConv(convId, metaPatch);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const { events, remainder } = parseSseChunk(pending, decoder.decode(value, { stream: true }));
          pending = remainder;
          for (const ev of events) {
            if (ev.name === "content_block_delta") {
              try {
                const p = JSON.parse(ev.data) as { text?: string };
                if (p.text) buffer += p.text;
              } catch {
                /* partial JSON — not an error */
              }
            } else if (ev.name === "error") {
              // The raw server error string is never rendered — only the
              // classified reason maps (via fixed copy) to what the user sees.
              streamFailure = parseErrorEvent(ev.data);
            }
          }
        }
        if (streamFailure) {
          // Failed turn → id-routed in-transcript error card. Any partial
          // buffer is dropped (mirrors the server persisting content "").
          this._appendMsg(convId, makeFailedEntry(streamFailure.reason));
          if (this.activeId === convId) this._deferScroll();
        } else if (buffer.length > 0) {
          // Id-routed append — the reply lands in the ORIGINATING conv even if
          // the user switched conversations while the stream was in flight.
          this._appendMsg(convId, { role: "assistant", text: buffer });
          // Auto-scroll only when the originating conv is still the active one
          // (don't yank a different conv the user navigated to).
          if (this.activeId === convId) this._deferScroll();
          // ── recall debounce: re-fetch every 3 successful sends
          // Use the user's message (`text`) as the query for the re-run.
          this._recallSendCount += 1;
          if (this._recallSendCount % 3 === 0) {
            const liveConv = this.conversations.find((c) => c.id === convId);
            void this.fetchRecall(text, liveConv?.serverSessionId ?? null);
          }
        } else {
          // Defense: the server always classifies an empty stream as
          // empty_exit, but if the stream ends silently anyway, render the
          // same card — a sent message must never just vanish.
          this._appendMsg(convId, makeFailedEntry("empty_exit"));
          if (this.activeId === convId) this._deferScroll();
        }
      } catch (err) {
        // If the request failed before the server pinned (no session id yet),
        // allow a retry to carry the anchor again — otherwise the anchor would be
        // silently lost on a mid-stream drop. Read the LIVE conv
        // by id (the captured `conv` ref is stale after the immutable patches).
        const live = this.conversations.find((c) => c.id === convId);
        if (live && !live.serverSessionId) this._patchConv(convId, { pinSent: false });
        // An abort is a user action, not a failure — no error copy for it.
        // Transport-level failure (fetch throw / HTTP non-ok / no body) —
        // before any turn exists. Single error line, fixed fallback copy;
        // raw error internals are never shown.
        if (err instanceof Error) {
          if (err.name !== "AbortError") {
            this.error = CHAT_ERROR_FALLBACK_COPY;
          } else {
            // The stop renders as the quiet cancelled marker in
            // the ORIGINATING conversation; the partial buffer is dropped
            // (matches the server's cancelled-row render contract).
            this._appendMsg(convId, {
              role: "assistant",
              text: CHAT_STOPPED_MARKER,
              status: "cancelled",
            });
            if (this.activeId === convId) this._deferScroll();
          }
        } else {
          this.error = CHAT_ERROR_FALLBACK_COPY;
        }
      } finally {
        this.streaming = false;
        // Streaming-scope fix — clear the originating-conv marker (success OR
        // error) so the typing-dots gate (isActiveStreaming) goes false.
        this.streamingConvId = null;
        this.abortController = null;
      }
      // Refresh the transparency-bar preview after a send that
      // actually exchanged a message (success or network error). Deliberately
      // OUTSIDE the try/finally: the blocked-signal branches above (`return`
      // from within the try — node_gone/stale/budget/quiet_hours) skip this,
      // since those are gate rejections with no new reply to reflect yet; the
      // next non-blocked send (or panel reopen) refreshes it.
      await (this as FloatingChatData).refreshContextPreview();
    },

    /**
     * Resolve the desync CTA choice. Called by the UI buttons.
     *
     * "reanchor": PATCH /api/chat/sessions/:id/anchor with the new node ref →
     *   update local anchorNodeId → proceed with the pending message to the
     *   SAME conversation.
     *
     * "new": create a NEW conversation pinned to the CTA-captured node ref →
     *   send the pending message there.
     */
    async resolveDesync(choice: "reanchor" | "new") {
      const cta = this.desyncCta;
      if (!cta) return;
      const conv = this.active();
      if (!conv) {
        this.desyncCta = null;
        return;
      }
      this.desyncCta = null;

      if (choice === "reanchor") {
        await this._handleReanchor(cta, conv);
      } else {
        await this._handleNewConv(cta);
      }
    },

    /** Internal — "reanchor" branch of resolveDesync. */
    async _handleReanchor(cta: DesyncCta, conv: { id: string; serverSessionId: string | null }) {
      // PATCH the server anchor — INV1 enforcement: this is the ONLY write path.
      // Guard serverSessionId against SESSION_ID_RE before URL interpolation
      // (defense-in-depth — mirrors the server-side guard).
      if (conv.serverSessionId && SESSION_ID_RE.test(conv.serverSessionId)) {
        try {
          const patchRes = await fetchFn(
            `/api/chat/sessions/${conv.serverSessionId}/anchor`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(cta.targetRef),
            },
          );
          if (patchRes.ok) {
            const json = (await patchRes.json()) as { ok: boolean; anchor: { node_id: string } };
            if (json.ok) {
              // Update local anchor state so future desync checks work.
              this.conversations = this.conversations.map((c) =>
                c.id === conv.id
                  ? { ...c, anchorNodeId: json.anchor.node_id }
                  : c,
              );
            }
          }
        } catch {
          // PATCH failure is non-fatal — the send proceeds anyway (best-effort
          // re-anchor; the conversation history is preserved regardless).
        }
      }
      // Proceed with the original message to the same conversation.
      // Set the bypass flag so send() doesn't re-intercept (e.g. if PATCH
      // failed and the conv is technically still desynced).
      this.draft = cta.pendingMessage;
      this._resolvingDesync = true;
      try {
        await this.send();
      } finally {
        this._resolvingDesync = false;
      }
    },

    /** Internal — "new" branch of resolveDesync.
     *
     * Pins the new conversation to `cta.targetRef` (the node captured at CTA-fire
     * time), NOT to the live `this.viewed`. This ensures the button label
     * ("New chat about <Y>") and the actual anchor always agree, even if the user
     * navigated to a different node between the CTA appearing and clicking the button.
     */
    async _handleNewConv(cta: DesyncCta) {
      // Reconstruct a ViewedNode from the CTA's captured ref so the new conversation
      // is anchored to the node the CTA described, not whatever is live in `viewed`.
      // `targetRef` carries the exact anchor target (node_id or descriptor) + projHash.
      const { proj_hash: projHash, ...target } = cta.targetRef;
      const capturedNode: ViewedNode = {
        target: target as ViewedNode["target"],
        projHash,
        label: cta.targetLabel,
      };

      const id = `c${++this._seq}`;
      this.conversations = [
        ...this.conversations,
        {
          id,
          serverSessionId: null,
          anchor: capturedNode,
          anchorNodeId: null, // resolved server-side on first send
          label: capturedNode.label,
          pin: pinLabel(capturedNode),
          badge: badgeFor(capturedNode),
          pinSent: false,
          createdAt: new Date().toISOString(),
          messages: [],
        },
      ];
      this.activeId = id;
      this.draft = cta.pendingMessage;
      // The new conv's anchorNodeId is null until first send, so the desync guard
      // in send() cannot fire — no _resolvingDesync bypass needed.
      await this.send();
    },

    /**
     * Resolve the stale-fingerprint CTA choice. Called by the UI buttons.
     *
     * "freeze": re-send with `anchor_decision: "freeze"` → the backend streams using
     *   the EXISTING frozen sidecar context (old code version). The transcript keeps
     *   answering the original code. ("keep discussing as of <pinned_at>")
     *
     * "continue": re-send with `anchor_decision: "continue"` → the backend re-resolves
     *   the anchor, overwrites the frozen sidecar with fresh context, then streams.
     *   This is the ONLY permitted explicit re-derive (INV2 satisfied because it went
     *   through this branch). ("use the current version")
     *
     * Limitation: the stale detection is FILE-level only — a change to any sibling
     * symbol in the same file triggers this. The user should be aware they may be
     * "continuing" on a file that changed beyond just the pinned node.
     */
    async resolveStale(choice: "freeze" | "continue") {
      const cta = this.staleCta;
      if (!cta) return;
      this.staleCta = null;
      // Restore the draft + re-send with the chosen decision.
      // send() will carry `anchor_decision` in the request body.
      this.draft = cta.pendingMessage;
      await this.send(choice);
    },

    /**
     * Dismiss the budget/quiet-hours blocked notice.
     * Clears blockedCta so the composer re-enables. The draft is already
     * restored inside send() when the signal fires (consistent with staleCta).
     * The user can retry once the block lifts (budget resets / quiet hours end).
     */
    dismissBlockedCta() {
      this.blockedCta = null;
    },

    /**
     * Abort the in-flight turn. send()'s AbortError path owns
     * the state transition (marker append + streaming reset); this only fires
     * the signal. No-op when nothing is streaming (abortController null).
     */
    stopStreaming() {
      this.abortController?.abort();
    },

    /**
     * Maximize/restore toggle — flips `maximized` between true and false.
     * Called by the header expand button, the backdrop click, and the Escape
     * key handler in init(). Only meaningful when the panel is open.
     */
    toggleMaximize() {
      this.maximized = !this.maximized;
    },

    /**
     * Auto-scroll the message-body container to the bottom. DOM-safe: reads the
     * Alpine-injected `$refs.scrollBody` and no-ops when it's absent (factory
     * tests have no Alpine / no DOM). Call sites use `_deferScroll()` so the new
     * content has rendered before `scrollHeight` is measured.
     */
    scrollToBottom() {
      const el = this.$refs?.scrollBody;
      if (!el) return; // no DOM / no ref → safe no-op (tests, pre-mount)
      el.scrollTop = el.scrollHeight;
    },

    /**
     * Schedule a scroll-to-bottom after the next DOM flush. Guarded: when
     * `$nextTick` is absent (factory tests, no Alpine) this is a no-op — there
     * is no DOM to scroll. This is the trigger send() calls after appending a
     * message; the streaming-text effect is wired separately via x-effect.
     */
    _deferScroll() {
      this.$nextTick?.(() => this.scrollToBottom());
    },

    /**
     * Streaming-scope fix — true ONLY when the in-flight stream belongs to the
     * active conversation. The typing-dots indicator gates on this so switching
     * conversations mid-stream (or creating a new one) hides another conv's dots.
     */
    isActiveStreaming() {
      return this.streaming && this.streamingConvId !== null && this.streamingConvId === this.activeId;
    },

    /**
     * Streaming-scope fix — immutably append `msg` to the conversation with id
     * `convId` (the ORIGINATING conv), NOT the live active one. This keeps the
     * streamed reply routed to the right conversation even if the user switched
     * mid-stream. No-op when the id no longer exists (e.g. deleted).
     */
    _appendMsg(convId: string, msg: ChatMsg) {
      this.conversations = this.conversations.map((c) =>
        c.id === convId ? { ...c, messages: [...c.messages, msg] } : c,
      );
    },

    /**
     * Streaming-scope fix — immutably patch metadata fields on the originating
     * conversation by id (survives mid-stream switches). No-op if the id is gone.
     */
    _patchConv(convId: string, patch: Partial<Conversation>) {
      this.conversations = this.conversations.map((c) =>
        c.id === convId ? { ...c, ...patch } : c,
      );
    },

    /**
     * Alpine-callable thin wrapper around the module-level `renderMarkdown`.
     * Invoked as `x-html="renderMd(m.text)"` for assistant messages. Delegating
     * to the exported function keeps the factory testable without Alpine.
     */
    renderMd(text: string): string {
      return renderMarkdown(text);
    },

    /** Starter-prompt chips list (mirrors STARTER_PROMPTS). */
    starterPrompts: STARTER_PROMPTS,

    /**
     * Starter chips show ONLY when the active conversation is fresh (zero
     * messages) AND no CTA is pending — so they don't compete with a desync/
     * stale/terminal/blocked prompt. terminalCta is the per-conv computed
     * accessor (null when the active conv is non-terminal).
     *
     * Streaming-scope: also hide when the active conv is the one streaming, so
     * chips never co-render with the typing dots on the SAME conv (defense in
     * depth — the user-message append already pushes messages.length > 0).
     */
    showStarters() {
      const conv = this.active();
      if (!conv || conv.messages.length > 0) return false;
      if (this.isActiveStreaming()) return false;
      if (this.desyncCta !== null) return false;
      if (this.staleCta !== null) return false;
      if (this.blockedCta !== null) return false;
      if (this.terminalCta != null) return false;
      return true;
    },

    /**
     * Click a starter chip — set the draft to the prompt and dispatch it via the
     * normal send() path so every pre-flight gate (desync/stale/terminal/
     * blocked), the anchor logic, and the auto-scroll all apply unchanged. Once
     * the message lands the conversation is no longer fresh → showStarters()
     * flips to false and the chips disappear.
     */
    async sendStarter(prompt: string) {
      this.draft = prompt;
      await this.send();
    },
  };
}

interface AlpineGlobal {
  data(name: string, factory: () => unknown): void;
}

export function registerFloatingChat(Alpine: AlpineGlobal): void {
  Alpine.data("floatingChat", () => makeFloatingChatData());
}

declare const globalThis: { Alpine?: AlpineGlobal };
if (globalThis.Alpine) {
  registerFloatingChat(globalThis.Alpine);
} else if (typeof document !== "undefined") {
  document.addEventListener("alpine:init", () => {
    if (globalThis.Alpine) registerFloatingChat(globalThis.Alpine);
  });
}
