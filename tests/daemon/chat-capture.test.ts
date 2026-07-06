// memory work (real-time chat capture) — the chat route detects an explicit
// "记住 X" remember-intent on the user turn, persists it via writeMemory (same
// store the facts route writes to), and injects a [SAVED]/[ALREADY KNOWN]/
// [CAPTURE INCOMPLETE] marker + an always-on capture-honesty framing into the
// system prompt so the pet acks truthfully (and never hallucinates a save).
//
// Asserts at the DETERMINISTIC checkpoint (door-before-contents): the composed
// systemPrompt handed to streamFactory + the writeMemory calls — NOT the LLM's
// words (verbalization is LLM-nondeterministic → confirmed by
// live smoke).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { ResolveAnchorResult } from "../../src/chat/anchor-context";
import { openIndex } from "../../src/chat/fts5-index";
import type { PageContext } from "../../src/chat/page-context";
import type { RecapDeps } from "../../src/chat/recap";
import {
  type BudgetSignal,
  type ChatAnchorRef,
  mountChatRoutes,
  type QuietHoursSignal,
} from "../../src/daemon/routes/chat";
import type {
  StreamChatOptions,
  StreamEvent,
} from "../../src/daemon/routes/chat-stream";
import { runChatCapture } from "../../src/daemon/routes/chat-capture-runner";
import type { CandidateFact, ExtractedFact } from "../../src/memory/extract-facts";
import type { ChatSession, CoreMemory, Fact } from "../../src/memory/memory";
import { emptyMemory } from "../../src/memory/memory";

let home: string;
let captured: StreamChatOptions[];

function fakeStream(
  opts: StreamChatOptions,
): AsyncGenerator<StreamEvent, void, void> {
  captured.push(opts);
  return (async function* () {
    yield { type: "message_start", message_id: "m-fake", model: "mock" };
    yield { type: "content_block_delta", text: "ok" };
    yield {
      type: "message_stop",
      usage: { input_tokens: 1, output_tokens: 1 },
      full_text: "ok",
    };
  })();
}

function fact(over: Partial<Fact>): Fact {
  return {
    id: "f-1",
    text: "x",
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-06-29T00:00:00.000Z",
    last_seen_at: "2026-06-29T00:00:00.000Z",
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    kind: null,
    ...over,
  };
}

function memWith(facts: Fact[]): CoreMemory {
  return { ...emptyMemory(), facts };
}

interface MountOpts {
  /** Initial store returned by readMemory (cloned per call so writes don't alias). */
  initial?: CoreMemory;
  /**
   * Correction track — make writeMemory feed back into the store that
   * readMemory clones, so a capture on turn 1 is visible to turn 2's reads
   * (corrected-fact-reaches-next-turn assertion). Default false: writes are
   * only recorded, store stays frozen (all pre-existing tests unchanged).
   */
  persistWrites?: boolean;
  /** Omit readMemory entirely. */
  noReadMemory?: boolean;
  /** Omit writeMemory entirely (capture disabled — back-compat). */
  noWriteMemory?: boolean;
  /** Make writeMemory throw (Contingency-2). */
  failWrite?: boolean;
  /**
   * Conversational auto-capture stub. When set, injected as the route's
   * `extractFacts` dep so the auto path runs deterministically (no `claude`
   * CLI). The spy records every message it was called with so tests can assert
   * the pre-filter gate (NOT called on chatter / explicit-marker turns).
   */
  extractFacts?: (message: string) => Promise<ExtractedFact[]>;
  /**
   * Page-context chat — stub for `assemblePageContext` (deterministic, no real
   * memory read). Absent → dep omitted (route falls back to the real
   * assembler, unused by these tests since no test sends `page` without it).
   */
  assemblePageContext?: (pageId: string) => Promise<PageContext | null>;
  /**
   * Stub for `resolveAnchor` (node > page precedence test needs a
   * resolved node anchor without a real graph).
   */
  resolveAnchor?: (a: ChatAnchorRef) => Promise<ResolveAnchorResult>;
  /**
   * Lazy per-chat recap — stub for the recap route's session
   * transcript read. Absent → route falls back to the real `readSession`
   * (jsonl-store), unused by these tests since they stub messages directly.
   */
  readSession?: (
    homeBase: string,
    sessionId: string,
  ) => Promise<{ role: string; content: string }[]>;
  /**
   * Lazy per-chat recap — stub for `recapSession` so recap tests
   * never spawn the `claude` CLI. Absent → route falls back to the real
   * `recapSession` (src/chat/recap.ts).
   */
  recapSession?: (
    messages: { role: string; content: string }[],
    deps: RecapDeps,
  ) => Promise<string>;
  /**
   * Gate reuse — stub for `checkSendGate` so the
   * recap-recent route's budget/quiet-hours short-circuit can be tested
   * without a real budget config.
   */
  checkSendGate?: () => Promise<BudgetSignal | QuietHoursSignal | null>;
}

interface Harness {
  app: Hono;
  writes: CoreMemory[];
  /** Messages the injected extractFacts stub was called with (gate proof). */
  extractCalls: string[];
}

function mount(opts: MountOpts = {}): Harness {
  const writes: CoreMemory[] = [];
  const extractCalls: string[] = [];
  const a = new Hono();
  let store = opts.initial ?? emptyMemory();
  mountChatRoutes(a, {
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    readMemory: opts.noReadMemory
      ? undefined
      : // Return a fresh structural clone each call so a captured write never
        // aliases the readMemory source (mirrors the real Zod-parsed read).
        async () => structuredClone(store),
    writeMemory:
      opts.noWriteMemory
        ? undefined
        : async (_hb: string, memory: CoreMemory) => {
            if (opts.failWrite) throw new Error("disk full");
            writes.push(memory);
            if (opts.persistWrites) store = memory;
          },
    extractFacts: opts.extractFacts
      ? async (message: string) => {
          extractCalls.push(message);
          // biome-ignore lint/style/noNonNullAssertion: guarded by the ternary.
          return opts.extractFacts!(message);
        }
      : undefined,
    assemblePageContext: opts.assemblePageContext,
    resolveAnchor: opts.resolveAnchor,
    readSession: opts.readSession,
    recapSession: opts.recapSession,
    checkSendGate: opts.checkSendGate,
  });
  return { app: a, writes, extractCalls };
}

async function post(a: Hono, body: unknown): Promise<Response> {
  return a.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function drain(res: Response): Promise<void> {
  await res.text(); // consume SSE so the stream's start() runs (captures opts)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-capture-"));
  captured = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("memory work — real-time chat capture", () => {
  test("'记住 X' writes an active stream:chat fact + injects [SAVED:", async () => {
    const { app, writes } = mount(); // empty initial store
    const res = await post(app, { message: "记住 我用 pnpm 不用 npm" });
    await drain(res);

    // writeMemory called exactly once (door): inspect the persisted store.
    expect(writes).toHaveLength(1);
    const newFacts = writes[0].facts.filter(
      (f) => f.status === "active" && f.learned_from?.stream === "chat",
    );
    expect(newFacts).toHaveLength(1);
    expect(newFacts[0].text).toBe("我用 pnpm 不用 npm");
    expect(newFacts[0].kind).toBeNull();
    // Provenance recorded (not null) so /memory shows a real "Why" line, not the
    // "no source recorded (early memory)" legacy fallback.
    expect(newFacts[0].save_reason).toBe("you asked me to remember this in chat");

    // The same turn that saved carries the truthful-ack marker (contents).
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt).toContain('[SAVED: "我用 pnpm 不用 npm"]');
  });

  test("plain message writes nothing; honesty framing present, NO marker", async () => {
    const { app, writes } = mount();
    const res = await post(app, { message: "怎么用 git rebase?" });
    await drain(res);

    expect(writes).toHaveLength(0);
    const sp = captured[0].systemPrompt ?? "";
    // Capture-honesty framing is always injected when capture is wired.
    expect(sp).toContain("NEVER claim you saved");
    // …but no capture fired → no marker of any kind. NB: the framing text itself
    // mentions "[SAVED]/[ALREADY KNOWN]" (no colon); the real markers carry a
    // colon ("[SAVED:"), so assert the colon form to distinguish marker vs framing.
    expect(sp).not.toContain("[SAVED:");
    expect(sp).not.toContain("[ALREADY KNOWN:");
    expect(sp).not.toContain("[CAPTURE INCOMPLETE]");
  });

  test("repeat of an existing active fact dedupes (no dup) + [ALREADY KNOWN:", async () => {
    const initial = memWith([
      fact({
        id: "pnpm",
        text: "我用 pnpm 不用 npm",
        status: "active",
        learned_from: { stream: "chat", session_id: null },
      }),
    ]);
    const { app, writes } = mount({ initial });
    const res = await post(app, { message: "记住 我用 pnpm 不用 npm" });
    await drain(res);

    expect(writes).toHaveLength(1);
    // Dedupe: no duplicate fact created (length unchanged at 1).
    expect(writes[0].facts).toHaveLength(1);
    expect(captured[0].systemPrompt).toContain(
      '[ALREADY KNOWN: "我用 pnpm 不用 npm"]',
    );
  });

  test("trigger-only '记住' writes nothing + [CAPTURE INCOMPLETE", async () => {
    const { app, writes } = mount();
    const res = await post(app, { message: "记住" });
    await drain(res);

    expect(writes).toHaveLength(0);
    expect(captured[0].systemPrompt).toContain("[CAPTURE INCOMPLETE]");
  });

  test("Contingency-2 — writeMemory failure still streams the reply, NO [SAVED marker", async () => {
    const { app, writes } = mount({ failWrite: true });
    const res = await post(app, { message: "记住 我用 pnpm 不用 npm" });
    // The reply still streams — capture is best-effort, never blocks (no 500).
    expect(res.status).toBe(200);
    await drain(res);

    // NOTE: `writes` is empty by mock construction (failWrite throws before
    // push), so it carries no independent signal — the real proof is that the
    // stream still ran AND no false ack leaked despite the write failure.
    expect(captured.length).toBeGreaterThan(0); // the reply actually streamed
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).not.toContain("[SAVED:"); // no false ack on write failure (colon = real marker)
  });

  test("back-compat — deps without writeMemory: remember message does not crash, no marker", async () => {
    const { app } = mount({ noWriteMemory: true });
    const res = await post(app, { message: "记住 我用 pnpm 不用 npm" });
    expect(res.status).toBe(200);
    await drain(res);

    expect(captured).toHaveLength(1);
    const sp = captured[0].systemPrompt ?? "";
    // Capture disabled → no marker AND no honesty framing (back-compat mount
    // behaves exactly as before this feature).
    expect(sp).not.toContain("[SAVED");
    expect(sp).not.toContain("NEVER claim you saved");
  });
});

describe("memory work — conversational auto-capture", () => {
  test("plain fact statement auto-extracts → active stream:chat fact + [SAVED:", async () => {
    const { app, writes, extractCalls } = mount({
      extractFacts: async () => [{ text: "喜欢奶油海绵蛋糕", entities: [] }],
    });
    const res = await post(app, { message: "我喜欢吃奶油海绵蛋糕" });
    await drain(res);

    // Pre-filter passed → extractor called once with the user message.
    expect(extractCalls).toEqual(["我喜欢吃奶油海绵蛋糕"]);
    // writeMemory called once (door): persisted store gained the active chat fact.
    expect(writes).toHaveLength(1);
    const newFacts = writes[0].facts.filter(
      (f) => f.status === "active" && f.learned_from?.stream === "chat",
    );
    expect(newFacts).toHaveLength(1);
    expect(newFacts[0].text).toBe("喜欢奶油海绵蛋糕");
    // Auto-capture provenance recorded (distinct from the explicit path).
    expect(newFacts[0].save_reason).toBe("noticed while chatting");
    // The same turn carries the truthful-ack marker (contents).
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt).toContain('[SAVED: "喜欢奶油海绵蛋糕"]');
  });

  test("chatter fails the pre-filter → extractor NOT called, writes nothing, no marker", async () => {
    const { app, writes, extractCalls } = mount({
      // If this ran it would "save" — proves the pre-filter gated it out.
      extractFacts: async () => [{ text: "should not be saved", entities: [] }],
    });
    const res = await post(app, { message: "帮我看这个 bug" });
    await drain(res);

    expect(extractCalls).toHaveLength(0); // cost gate: no paid call on chatter
    expect(writes).toHaveLength(0);
    expect(captured[0].systemPrompt ?? "").not.toContain("[SAVED:");
  });

  test("cost gate — too-short message ('ok') never reaches the extractor", async () => {
    const { app, writes, extractCalls } = mount({
      extractFacts: async () => [{ text: "nope", entities: [] }],
    });
    const res = await post(app, { message: "ok" });
    await drain(res);

    expect(extractCalls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test("multi — extractor returns two facts → both persisted + marker lists both", async () => {
    const { app, writes, extractCalls } = mount({
      extractFacts: async () => [{ text: "喜欢奶油海绵蛋糕", entities: [] }, { text: "喜欢奥利奥海盐奶油", entities: [] }],
    });
    const res = await post(app, { message: "我喜欢奶油海绵蛋糕和奥利奥海盐奶油" });
    await drain(res);

    expect(extractCalls).toHaveLength(1);
    expect(writes).toHaveLength(1);
    const texts = writes[0].facts
      .filter((f) => f.status === "active" && f.learned_from?.stream === "chat")
      .map((f) => f.text);
    expect(texts).toEqual(["喜欢奶油海绵蛋糕", "喜欢奥利奥海盐奶油"]);
    expect(captured[0].systemPrompt).toContain(
      '[SAVED: "喜欢奶油海绵蛋糕"; "喜欢奥利奥海盐奶油"]',
    );
  });

  test("auto dedupe — plain restatement of a known fact → [ALREADY KNOWN:, no dup", async () => {
    // Seed an existing active chat fact, then auto-extract the SAME text from a
    // plain (no-marker) message → the IMP-1 fix: signal must be ALREADY KNOWN,
    // NOT a false [SAVED:.
    const initial = memWith([
      fact({
        id: "cake",
        text: "喜欢奶油海绵蛋糕",
        status: "active",
        learned_from: { stream: "chat", session_id: null },
      }),
    ]);
    const { app, writes, extractCalls } = mount({
      initial,
      extractFacts: async () => [{ text: "喜欢奶油海绵蛋糕", entities: [] }],
    });
    const res = await post(app, { message: "我喜欢吃奶油海绵蛋糕" });
    await drain(res);

    expect(extractCalls).toHaveLength(1);
    // writeMemory IS called (the dedupe refreshes clocks — a real mutation)…
    expect(writes).toHaveLength(1);
    // …but NO duplicate fact (length unchanged at 1).
    expect(writes[0].facts).toHaveLength(1);
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain('[ALREADY KNOWN: "喜欢奶油海绵蛋糕"]');
    expect(sp).not.toContain("[SAVED:"); // the bug: was emitting a false SAVED
  });

  test("auto mixed — one new + one known fact → [SAVED: (any fresh save wins)", async () => {
    const initial = memWith([
      fact({
        id: "cake",
        text: "喜欢奶油海绵蛋糕",
        status: "active",
        learned_from: { stream: "chat", session_id: null },
      }),
    ]);
    const { app, writes, extractCalls } = mount({
      initial,
      // first is a dupe of the seeded fact, second is new.
      extractFacts: async () => [{ text: "喜欢奶油海绵蛋糕", entities: [] }, { text: "喜欢奥利奥海盐奶油", entities: [] }],
    });
    const res = await post(app, { message: "我喜欢奶油海绵蛋糕和奥利奥海盐奶油" });
    await drain(res);

    expect(extractCalls).toHaveLength(1);
    expect(writes).toHaveLength(1);
    // 1 seeded + 1 new = 2 (the dupe did not add a fact).
    expect(writes[0].facts).toHaveLength(2);
    const sp = captured[0].systemPrompt ?? "";
    // ANY fresh save → SAVED (not ALREADY KNOWN), listing both claim texts.
    expect(sp).toContain('[SAVED: "喜欢奶油海绵蛋糕"; "喜欢奥利奥海盐奶油"]');
    expect(sp).not.toContain("[ALREADY KNOWN:");
  });

  test("explicit '记住 X' wins; auto extractor NOT called, still saves via the explicit path", async () => {
    const { app, writes, extractCalls } = mount({
      extractFacts: async () => [{ text: "auto path should not run", entities: [] }],
    });
    const res = await post(app, { message: "记住 我用 pnpm" });
    await drain(res);

    // Explicit intent hit → the auto branch never runs.
    expect(extractCalls).toHaveLength(0);
    // …but the explicit path still persisted the fact.
    expect(writes).toHaveLength(1);
    const saved = writes[0].facts.filter(
      (f) => f.status === "active" && f.learned_from?.stream === "chat",
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].text).toBe("我用 pnpm");
    expect(captured[0].systemPrompt).toContain('[SAVED: "我用 pnpm"]');
  });

  test("Contingency-2 — extractor throws → reply streams (200), no marker, no write", async () => {
    const { app, writes } = mount({
      extractFacts: async () => {
        throw new Error("haiku timeout");
      },
    });
    const res = await post(app, { message: "我喜欢吃奶油海绵蛋糕" });
    expect(res.status).toBe(200);
    await drain(res);

    expect(writes).toHaveLength(0);
    expect(captured.length).toBeGreaterThan(0); // reply still streamed
    expect(captured[0].systemPrompt ?? "").not.toContain("[SAVED:");
  });

  test("back-compat — fact statement with no extractFacts AND no writeMemory: no crash, no marker", async () => {
    // captureEnabled is false (no writeMemory) → the whole capture block is
    // skipped, so the auto branch never reaches the (defaulted) real extractor.
    const { app } = mount({ noWriteMemory: true });
    const res = await post(app, { message: "我喜欢吃奶油海绵蛋糕" });
    expect(res.status).toBe(200);
    await drain(res);

    expect(captured).toHaveLength(1);
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).not.toContain("[SAVED");
    expect(sp).not.toContain("NEVER claim you saved");
  });

  // Door-proof (anti-vacuous, entity model): assert against what
  // writeMemory actually RECEIVED, not just the route's return value — proves
  // the extracted entities survive the full readMemory → captureChatFactsCore →
  // writeMemory round-trip, not just the in-memory core transition.
  test("auto-capture persists entities from extraction into writeMemory", async () => {
    const { app, writes, extractCalls } = mount({
      extractFacts: async () => [{ text: "likes dogs", entities: [{ name: "dogs" }] }],
    });
    const res = await post(app, { message: "我喜欢狗" });
    await drain(res);

    expect(extractCalls).toEqual(["我喜欢狗"]);
    expect(writes).toHaveLength(1);
    const persisted = writes[0].facts.find((f) => f.text === "likes dogs");
    expect(persisted?.entities).toEqual([{ name: "dogs" }]);
  });
});

// Chat-memory correction — route-level, stubbed extractor. Same
// deterministic checkpoints as the capture suite: what writeMemory RECEIVED +
// the composed systemPrompt handed to streamFactory (door-before-contents).
// The stub returns the CLASSIFIED shape (classification/target_fact_id/
// confidence) the extractor emits; the runner's layer-2 re-derivation +
// ladder are the units under test here.
describe("Chat-memory correction — runner wiring", () => {
  /** Seeded correctable fact — chat provenance, inside the candidate fence. */
  const dogFact = () =>
    fact({
      id: "f-dog",
      text: "用户是狗派",
      learned_from: { stream: "chat", session_id: null },
    });

  const contradictStub =
    (confidence?: number, target = "f-dog") =>
    async (): Promise<ExtractedFact[]> => [
      {
        text: "用户是猫派",
        entities: [],
        classification: "contradict",
        target_fact_id: target,
        ...(confidence !== undefined ? { confidence } : {}),
      },
    ];

  test("correction turn: new active + old retired in ONE write, [REPLACED] names both, ONE extractor call", async () => {
    const { app, writes, extractCalls } = mount({
      initial: memWith([dogFact()]),
      extractFacts: contradictStub(0.95),
    });
    const res = await post(app, { message: "不对，我是猫派不是狗派" });
    await drain(res);

    // Exactly ONE Brain-call seam invocation for the fact-like turn.
    expect(extractCalls).toEqual(["不对，我是猫派不是狗派"]);
    // One atomic write carrying BOTH sides of the supersession.
    expect(writes).toHaveLength(1);
    const newFact = writes[0].facts.find((f) => f.text === "用户是猫派");
    expect(newFact?.status).toBe("active");
    expect(newFact?.supersedes).toBe("f-dog");
    expect(newFact?.learned_from).toEqual({ stream: "chat", session_id: null });
    expect(newFact?.save_reason).toBe("noticed while chatting");
    const old = writes[0].facts.find((f) => f.id === "f-dog");
    expect(old?.status).toBe("retired");
    expect(old?.retired_reason).toBe("superseded");
    expect(old?.superseded_by).toBe(newFact?.id);
    expect(old?.invalid_at).not.toBeNull();

    // The marker names old AND new; no false [SAVED] alongside.
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain('[REPLACED: "用户是狗派" → "用户是猫派"]');
    expect(sp).not.toContain("[SAVED:");
    // Honesty framing extended for the correction family (colon-free names).
    expect(sp).toContain("unless a [REPLACED] marker is present");
  });

  test("ladder mid-band — 0.8 → PENDING replacement, old fact untouched, [PROPOSED-REPLACE] not [REPLACED]", async () => {
    const { app, writes } = mount({
      initial: memWith([dogFact()]),
      extractFacts: contradictStub(0.8),
    });
    const res = await post(app, { message: "不对，我是猫派不是狗派" });
    await drain(res);

    expect(writes).toHaveLength(1);
    const pending = writes[0].facts.find((f) => f.text === "用户是猫派");
    expect(pending?.status).toBe("pending");
    expect(pending?.supersedes).toBe("f-dog");
    const old = writes[0].facts.find((f) => f.id === "f-dog");
    expect(old?.status).toBe("active");
    expect(old?.retired_reason).toBeNull();
    expect(old?.superseded_by).toBeNull();

    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain('[PROPOSED-REPLACE: "用户是猫派"');
    expect(sp).toContain("pending the user's confirmation");
    expect(sp).not.toContain("[REPLACED:");
  });

  test("ladder floor — 0.5 → dropped: NO write, store untouched, no marker of any kind", async () => {
    const { app, writes, extractCalls } = mount({
      initial: memWith([dogFact()]),
      extractFacts: contradictStub(0.5),
    });
    const res = await post(app, { message: "不对，我是猫派不是狗派" });
    await drain(res);

    expect(extractCalls).toHaveLength(1); // extraction ran; the DROP was code-side
    expect(writes).toHaveLength(0); // reference-equal memory → write skipped
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).not.toContain("[REPLACED:");
    expect(sp).not.toContain("[PROPOSED-REPLACE:");
    expect(sp).not.toContain("[SAVED:");
    expect(sp).not.toContain("[ALREADY KNOWN:");
  });

  test("ladder — undefined confidence → conservative PENDING (matches apply-core's missing-tier default)", async () => {
    const { app, writes } = mount({
      initial: memWith([dogFact()]),
      extractFacts: contradictStub(undefined),
    });
    const res = await post(app, { message: "不对，我是猫派不是狗派" });
    await drain(res);

    expect(writes).toHaveLength(1);
    const pending = writes[0].facts.find((f) => f.text === "用户是猫派");
    expect(pending?.status).toBe("pending");
    expect((captured[0].systemPrompt ?? "")).toContain("[PROPOSED-REPLACE:");
    expect((captured[0].systemPrompt ?? "")).not.toContain("[REPLACED:");
  });

  test("provenance fence — a commit-stream fact is not correctable: contradict downgrades to plain add", async () => {
    const { app, writes } = mount({
      initial: memWith([
        fact({
          id: "f-commit",
          text: "用户是狗派",
          learned_from: { stream: "commit", session_id: null },
        }),
      ]),
      extractFacts: contradictStub(0.95, "f-commit"),
    });
    const res = await post(app, { message: "不对，我是猫派不是狗派" });
    await drain(res);

    expect(writes).toHaveLength(1);
    // The commit-derived fact is untouched — it was never in the candidate list.
    const commitFact = writes[0].facts.find((f) => f.id === "f-commit");
    expect(commitFact?.status).toBe("active");
    expect(commitFact?.superseded_by).toBeNull();
    // The user's claim landed as a plain add (guard 3's "else → add").
    const added = writes[0].facts.find((f) => f.text === "用户是猫派");
    expect(added?.status).toBe("active");
    expect(added?.supersedes).toBeNull();
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain('[SAVED: "用户是猫派"]');
    expect(sp).not.toContain("[REPLACED:");
  });

  test("numeric-specifics guard — contradict@0.95 on a numeric-equivalent pair downgrades to add: old fact untouched, [SAVED] not [REPLACED]", async () => {
    // Eval-calibrated failure mode (
    // eval-report.md, numeric-trap 1/6): Haiku calls a numbers-only difference
    // a contradiction at 0.95-1.0, above T_HIGH — only the CODE guard catches it.
    const { app, writes } = mount({
      initial: memWith([
        fact({
          id: "f-cats",
          text: "用户养了 2 只猫",
          learned_from: { stream: "chat", session_id: null },
        }),
      ]),
      extractFacts: async () => [
        {
          text: "有 3 只猫",
          entities: [],
          classification: "contradict",
          target_fact_id: "f-cats",
          confidence: 0.95,
        },
      ],
    });
    const res = await post(app, { message: "我现在有 3 只猫" });
    await drain(res);

    expect(writes).toHaveLength(1);
    // The stored fact is NOT retired — a numeric difference is not a contradiction.
    const old = writes[0].facts.find((f) => f.id === "f-cats");
    expect(old?.status).toBe("active");
    expect(old?.superseded_by).toBeNull();
    expect(old?.retired_reason).toBeNull();
    // The claim landed as a coexisting add (the guard's safe direction).
    const added = writes[0].facts.find((f) => f.text === "有 3 只猫");
    expect(added?.status).toBe("active");
    expect(added?.supersedes).toBeNull();
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain('[SAVED: "有 3 只猫"]');
    expect(sp).not.toContain("[REPLACED:");
    expect(sp).not.toContain("[PROPOSED-REPLACE:");
  });

  test("numeric guard also covers RESTATE — numeric-diff restate becomes a coexisting add, NOT a stale reaffirm + false [ALREADY KNOWN]", async () => {
    // A numeric update mislabeled "restate" must not reaffirm the STALE number
    // in place — that acks [ALREADY KNOWN] while the old count stays active
    // (a false confirmation, worse than a visible drop).
    const { app, writes } = mount({
      initial: memWith([
        fact({
          id: "f-cats",
          text: "用户养了 2 只猫",
          learned_from: { stream: "chat", session_id: null },
        }),
      ]),
      extractFacts: async () => [
        {
          text: "养了 3 只猫",
          entities: [],
          classification: "restate",
          target_fact_id: "f-cats",
          confidence: 0.9,
        },
      ],
    });
    const res = await post(app, { message: "我现在养了 3 只猫" });
    await drain(res);

    expect(writes).toHaveLength(1);
    // Old fact NOT reaffirmed in place (its recall_count untouched at 0).
    const old = writes[0].facts.find((f) => f.id === "f-cats");
    expect(old?.status).toBe("active");
    expect(old?.recall_count ?? 0).toBe(0);
    // The new count landed as a visible coexisting add.
    const added = writes[0].facts.find((f) => f.text === "养了 3 只猫");
    expect(added?.status).toBe("active");
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain('[SAVED: "养了 3 只猫"]');
    // Colon form = a LIVE marker (the honesty framing mentions the bare name).
    expect(sp).not.toContain("[ALREADY KNOWN:");
  });

  test("negative — extractor returns [] on a correction-shaped turn (pet-output fix) → store untouched, no marker", async () => {
    const { app, writes, extractCalls } = mount({
      initial: memWith([dogFact()]),
      extractFacts: async () => [], // real extractor rejects '不对，13×7=91' as non-durable
    });
    const res = await post(app, { message: "不对，13×7=91" });
    await drain(res);

    expect(extractCalls).toHaveLength(1); // widened gate admitted the turn…
    expect(writes).toHaveLength(0); // …but nothing durable → byte-identical store
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).not.toContain("[SAVED:");
    expect(sp).not.toContain("[REPLACED:");
    expect(sp).not.toContain("[PROPOSED-REPLACE:");
  });

  test("one add + one correction in a single turn → ONE write carrying both, markers in outcome order", async () => {
    const { app, writes } = mount({
      initial: memWith([dogFact()]),
      extractFacts: async () => [
        { text: "喜欢蛋糕", entities: [], classification: "add", target_fact_id: null },
        {
          text: "用户是猫派",
          entities: [],
          classification: "contradict",
          target_fact_id: "f-dog",
          confidence: 0.95,
        },
      ],
    });
    const res = await post(app, { message: "不对，我是猫派不是狗派，另外我喜欢吃蛋糕" });
    await drain(res);

    // A single writeMemory carries the add AND the supersession.
    expect(writes).toHaveLength(1);
    expect(writes[0].facts.find((f) => f.text === "喜欢蛋糕")?.status).toBe("active");
    expect(writes[0].facts.find((f) => f.text === "用户是猫派")?.status).toBe("active");
    expect(writes[0].facts.find((f) => f.id === "f-dog")?.status).toBe("retired");

    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain('[SAVED: "喜欢蛋糕"]');
    expect(sp).toContain('[REPLACED: "用户是狗派" → "用户是猫派"]');
    // Markers appear in claim-outcome order (add first, correction second).
    expect(sp.indexOf('[SAVED: "喜欢蛋糕"]')).toBeLessThan(sp.indexOf("[REPLACED:"));
  });

  test("guard 3 belt — missing classification with a named target stays a plain add (default-to-add)", async () => {
    const { app, writes } = mount({
      initial: memWith([dogFact()]),
      // Malformed-ish stub: target + confidence but NO classification — the
      // extractor normally normalizes this; the runner must still treat it as add.
      extractFacts: async () => [
        { text: "用户是猫派", entities: [], target_fact_id: "f-dog", confidence: 0.99 },
      ],
    });
    const res = await post(app, { message: "不对，我是猫派不是狗派" });
    await drain(res);

    expect(writes).toHaveLength(1);
    expect(writes[0].facts.find((f) => f.id === "f-dog")?.status).toBe("active");
    expect(writes[0].facts.find((f) => f.text === "用户是猫派")?.supersedes).toBeNull();
    expect(captured[0].systemPrompt ?? "").toContain('[SAVED: "用户是猫派"]');
  });

  test("corrected fact reaches the NEXT turn's user-context injection (old text gone)", async () => {
    const { app, writes } = mount({
      initial: memWith([dogFact()]),
      persistWrites: true, // writes feed back into the store readMemory clones
      extractFacts: contradictStub(0.95),
    });
    await drain(await post(app, { message: "不对，我是猫派不是狗派" }));
    expect(writes).toHaveLength(1);

    // Next turn (non-capturing question) — the injected <user_context> reflects
    // the corrected fact, and the retired one no longer leaks.
    await drain(await post(app, { message: "怎么用 git rebase?" }));
    expect(captured).toHaveLength(2);
    const sp2 = captured[1].systemPrompt ?? "";
    expect(sp2).toContain("用户是猫派");
    expect(sp2).not.toContain("用户是狗派");
  });
});

// Direct runner tests — the candidate list handed to the extractor is invisible
// at route level (chat.ts's 2-param dep type erases it), so the fence/cap/
// rollback assertions capture it via a 3-param stub on runChatCapture itself.
describe("runChatCapture — candidate fence + rollback (direct)", () => {
  const chatFact = (id: string, text: string, over: Partial<Fact> = {}) =>
    fact({ id, text, learned_from: { stream: "chat", session_id: null }, ...over });

  function runnerDeps(
    mem: CoreMemory,
    extractFacts: (
      message: string,
      deps: { homeBase: string; sessionId: string },
      candidates?: CandidateFact[],
    ) => Promise<ExtractedFact[]>,
    over: { correctionEnabled?: boolean } = {},
  ) {
    const writes: CoreMemory[] = [];
    return {
      writes,
      deps: {
        readMemory: async () => structuredClone(mem),
        writeMemory: async (_hb: string, memory: CoreMemory) => {
          writes.push(memory);
        },
        extractFacts,
        homeBase: home,
        sessionId: "s-test",
        nowIso: () => "2026-07-02T00:00:00.000Z",
        ...over,
      },
    };
  }

  test("fence — candidates = active ∩ {chat, remember, user} only; commit/critique/dismissal/legacy-null/non-active excluded", async () => {
    const mem = memWith([
      chatFact("f-chat", "A"),
      fact({ id: "f-rem", text: "B", learned_from: { stream: "remember", session_id: null } }),
      fact({ id: "f-user", text: "C", learned_from: { stream: "user", session_id: null } }),
      fact({ id: "f-commit", text: "D", learned_from: { stream: "commit", session_id: null } }),
      fact({ id: "f-crit", text: "E", learned_from: { stream: "critique", session_id: null } }),
      fact({ id: "f-dis", text: "F", learned_from: { stream: "dismissal", session_id: null } }),
      fact({ id: "f-legacy", text: "G", learned_from: null }),
      chatFact("f-retired", "H", { status: "retired" }),
      chatFact("f-pending", "I", { status: "pending" }),
    ]);
    const seen: (CandidateFact[] | undefined)[] = [];
    const { deps } = runnerDeps(mem, async (_m, _d, candidates) => {
      seen.push(candidates);
      return [];
    });

    const result = await runChatCapture("我喜欢吃蛋糕", deps);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((c) => c.id)).toEqual(["f-chat", "f-rem", "f-user"]);
    expect(result.signal).toBeNull();
  });

  test("rollback — correctionEnabled: false → candidates never built/passed; add-only behavior intact", async () => {
    const mem = memWith([chatFact("f-chat", "A")]);
    const seen: (CandidateFact[] | undefined)[] = [];
    const { deps, writes } = runnerDeps(
      mem,
      async (_m, _d, candidates) => {
        seen.push(candidates);
        return [{ text: "喜欢蛋糕", entities: [] }];
      },
      { correctionEnabled: false },
    );

    const result = await runChatCapture("我喜欢吃蛋糕", deps);

    expect(seen).toEqual([undefined]); // the fence was never even computed
    expect(result.signal).toBe("saved"); // pre-track add path fully intact
    expect(writes).toHaveLength(1);
    expect(writes[0].facts.find((f) => f.text === "喜欢蛋糕")?.status).toBe("active");
  });

  test("candidate cap — >30 fenced facts → 30 most-recent by last_seen_at", async () => {
    const facts = Array.from({ length: 35 }, (_, i) =>
      chatFact(`f-${i}`, `fact ${i}`, {
        last_seen_at: `2026-06-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    const seen: (CandidateFact[] | undefined)[] = [];
    const { deps } = runnerDeps(memWith(facts), async (_m, _d, candidates) => {
      seen.push(candidates);
      return [];
    });

    await runChatCapture("我喜欢吃蛋糕", deps);

    expect(seen[0]).toHaveLength(30);
    expect(seen[0]?.[0]?.id).toBe("f-34"); // newest first when capped
    const ids = new Set(seen[0]?.map((c) => c.id));
    for (const oldest of ["f-0", "f-1", "f-2", "f-3", "f-4"]) {
      expect(ids.has(oldest)).toBe(false); // the 5 oldest fell off
    }
  });
});

// Page-context chat — an un-anchored chat gets context from the PAGE
// the user is on. Asserts at the same deterministic checkpoint as the capture
// suite above: the composed systemPrompt handed to streamFactory (door-before-
// contents), not the assembler's return value alone — proving the page block
// actually reaches the Brain call. Precedence: node anchor > page > none.
describe("Page-context chat", () => {
  test("page context is injected when no node anchor (node > page > none)", async () => {
    const { app } = mount({
      assemblePageContext: async () => ({
        pageLabel: "Memory Book",
        contextBundle: "- likes dogs",
        systemPrompt: "PAGE-SYS",
      }),
    });
    const res = await post(app, { message: "hi", page: "/memory" });
    await drain(res);

    expect(captured).toHaveLength(1);
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain("PAGE-SYS");
    expect(sp).toContain("likes dogs");
  });

  test("node anchor wins over page (page ignored when a node resolved)", async () => {
    const resolveAnchor = async (): Promise<ResolveAnchorResult> => ({
      kind: "resolved",
      context: {
        nodeId: "function:src/foo.ts:applyDiscount",
        nodeName: "applyDiscount",
        nodeType: "function",
        path: "src/foo.ts",
        contextBundle: "NODE-CODE",
        systemPrompt: "NODE-SYS",
        fingerprint: "sha-foo-123",
        includedSources: ["src/foo.ts"],
        truncated: false,
      },
    });
    const { app } = mount({
      resolveAnchor,
      assemblePageContext: async () => ({
        pageLabel: "Memory Book",
        contextBundle: "PAGE-BUNDLE",
        systemPrompt: "PAGE-SYS",
      }),
    });
    const res = await post(app, {
      message: "hi",
      page: "/memory",
      anchor: { proj_hash: "abc", node_id: "fn:x" },
    });
    await drain(res);

    expect(captured).toHaveLength(1);
    const sp = captured[0].systemPrompt ?? "";
    expect(sp).toContain("NODE-SYS");
    expect(sp).not.toContain("PAGE-SYS");
  });

  // FIX 2 (review, Minor) — a malformed `body.page` must be silently
  // ignored: no page context reaches the Brain call, AND the reply still
  // streams 200 (additive-only, never blocks). Non-vacuous: the
  // assemblePageContext stub proves it was never CALLED (not just that its
  // output didn't appear), and captured[0] proves the turn still streamed.
  test("malformed page (path-traversal chars) is silently ignored — no context injected, reply still 200", async () => {
    let assembleCalled = false;
    const { app } = mount({
      assemblePageContext: async () => {
        assembleCalled = true;
        return { pageLabel: "x", contextBundle: "should not appear", systemPrompt: "PAGE-SYS" };
      },
    });
    const res = await post(app, { message: "hi", page: "../etc" });
    expect(res.status).toBe(200);
    await drain(res);

    expect(assembleCalled).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt ?? "").not.toContain("PAGE-SYS");
  });

  test("malformed page (>128 chars) is silently ignored — no context injected, reply still 200", async () => {
    let assembleCalled = false;
    const { app } = mount({
      assemblePageContext: async () => {
        assembleCalled = true;
        return { pageLabel: "x", contextBundle: "should not appear", systemPrompt: "PAGE-SYS" };
      },
    });
    const res = await post(app, { message: "hi", page: `/${"a".repeat(128)}` });
    expect(res.status).toBe(200);
    await drain(res);

    expect(assembleCalled).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt ?? "").not.toContain("PAGE-SYS");
  });

  test("malformed page (non-string) is silently ignored — no context injected, reply still 200", async () => {
    let assembleCalled = false;
    const { app } = mount({
      assemblePageContext: async () => {
        assembleCalled = true;
        return { pageLabel: "x", contextBundle: "should not appear", systemPrompt: "PAGE-SYS" };
      },
    });
    const res = await post(app, { message: "hi", page: 12345 });
    expect(res.status).toBe(200);
    await drain(res);

    expect(assembleCalled).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt ?? "").not.toContain("PAGE-SYS");
  });

  // GET /api/chat/context-preview: $0 read that powers the
  // transparency bar. Must never call the Brain/stream (captured stays empty).
  test("context-preview returns page label + facts count, no Brain call", async () => {
    const { app } = mount({ initial: memWith([fact({ status: "active" })]) });
    const res = await app.request("/api/chat/context-preview?page=/memory");
    const json = await res.json();
    expect(json).toEqual({ page_label: "Memory Book", facts_count: 1 });
    expect(captured).toHaveLength(0);
  });
});

// Lazy per-chat recap — POST /api/chat/recap-recent. Asserts at the
// deterministic door: what writeMemory RECEIVED (persisted summary +
// summary_generated_at), not merely the route's return JSON — proving the
// recap actually reached the store, not just the response body.
function session(over: Partial<ChatSession>): ChatSession {
  return {
    id: "s1",
    started_at: "t",
    ended_at: null,
    message_count: 2,
    summary: "我在看什么页面?",
    summary_generated_at: null,
    tags: [],
    anchor: null,
    ...over,
  };
}

describe("Lazy per-chat recap", () => {
  test("recaps un-recapped recent sessions and writes back (door: persisted summary + timestamp)", async () => {
    const sess = session({ id: "s1" });
    const { app, writes } = mount({
      initial: { ...emptyMemory(), chat_sessions: [sess] },
      readSession: async () => [
        { role: "user", content: "我在看什么页面?" },
        { role: "assistant", content: "Memory Book 页。" },
      ],
      recapSession: async () => "聊了 Memory Book 页。",
    });

    const res = await app.request("/api/chat/recap-recent", { method: "POST" });
    const json = await res.json();
    expect(json.recapped).toEqual([{ id: "s1", summary: "聊了 Memory Book 页。" }]);

    // Door-proof: inspect what writeMemory actually received, not just the
    // response JSON.
    expect(writes).toHaveLength(1);
    const persisted = writes[0].chat_sessions.find((s) => s.id === "s1");
    expect(persisted?.summary).toBe("聊了 Memory Book 页。");
    expect(persisted?.summary_generated_at).not.toBeNull();
  });

  test("skips already-recapped sessions (idempotent, no call, no write)", async () => {
    let called = false;
    const sess = session({
      id: "s1",
      summary: "recap done",
      summary_generated_at: "2026-06-30T00:00:00Z",
    });
    const { app, writes } = mount({
      initial: { ...emptyMemory(), chat_sessions: [sess] },
      recapSession: async () => {
        called = true;
        return "x";
      },
    });

    const res = await app.request("/api/chat/recap-recent", { method: "POST" });
    expect((await res.json()).recapped).toEqual([]);
    expect(called).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("budget/quiet-hours gate blocks: {recapped: []}, recapSession never called, no write", async () => {
    let called = false;
    const sess = session({ id: "s1" });
    const gateSignal: BudgetSignal = { blocked: "budget", used_pct: 150 };
    const { app, writes } = mount({
      initial: { ...emptyMemory(), chat_sessions: [sess] },
      checkSendGate: async () => gateSignal,
      recapSession: async () => {
        called = true;
        return "should not run";
      },
    });

    const res = await app.request("/api/chat/recap-recent", { method: "POST" });
    expect(await res.json()).toEqual({ recapped: [] });
    expect(called).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("scopes recap to the ids the client sent (panel-shown sessions), leaving other eligible sessions untouched", async () => {
    const s1 = session({ id: "s1", summary: "first msg 1" });
    const s2 = session({ id: "s2", summary: "first msg 2" });
    const { app, writes } = mount({
      initial: { ...emptyMemory(), chat_sessions: [s1, s2] },
      readSession: async () => [{ role: "user", content: "hi" }],
      recapSession: async (_m, deps) => `recap of ${deps.sessionId}`,
    });

    const res = await app.request("/api/chat/recap-recent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["s1"] }),
    });
    expect((await res.json()).recapped).toEqual([{ id: "s1", summary: "recap of s1" }]);

    // Door: only s1 persisted; s2 (eligible but NOT requested) keeps its
    // placeholder + null flag — the recap landed on the session the client
    // showed, not an independently-picked one.
    expect(writes).toHaveLength(1);
    const p1 = writes[0].chat_sessions.find((s) => s.id === "s1");
    const p2 = writes[0].chat_sessions.find((s) => s.id === "s2");
    expect(p1?.summary).toBe("recap of s1");
    expect(p1?.summary_generated_at).not.toBeNull();
    expect(p2?.summary).toBe("first msg 2");
    expect(p2?.summary_generated_at).toBeNull();
  });

  test("empty ids array → recaps nothing (scope-to-nothing, not panel-agnostic fallback)", async () => {
    let called = false;
    const s1 = session({ id: "s1" });
    const { app, writes } = mount({
      initial: { ...emptyMemory(), chat_sessions: [s1] },
      readSession: async () => [{ role: "user", content: "hi" }],
      recapSession: async () => {
        called = true;
        return "x";
      },
    });

    const res = await app.request("/api/chat/recap-recent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect((await res.json()).recapped).toEqual([]);
    expect(called).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("no ids in body → recaps all eligible (panel-agnostic fallback, back-compat)", async () => {
    const s1 = session({ id: "s1" });
    const s2 = session({ id: "s2" });
    const { app } = mount({
      initial: { ...emptyMemory(), chat_sessions: [s1, s2] },
      readSession: async () => [{ role: "user", content: "hi" }],
      recapSession: async (_m, deps) => `recap of ${deps.sessionId}`,
    });

    const res = await app.request("/api/chat/recap-recent", { method: "POST" });
    const ids = ((await res.json()).recapped as Array<{ id: string }>)
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(["s1", "s2"]);
  });
});
