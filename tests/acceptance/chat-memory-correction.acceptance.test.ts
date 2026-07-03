/**
 * Acceptance tests — chat-memory correction (zero-command).
 *
 * The eval-artifact case (labeled-set before/after run with a threshold lock)
 * is out of this file's scope.
 *
 * Exercises the system FROM OUTSIDE: every test drives the MOUNTED Hono app
 * via POST /api/chat (the same surface the daemon exposes) against the REAL
 * memory store on disk — `readMemory`/`writeMemory` from src/memory/memory
 * read/write a real memory.json under a tmp homeBase (the writeMemory dep is
 * a pass-through spy that counts calls, then delegates to the real writer, so
 * "one atomic write" stays assertable). Everything between HTTP and the store
 * is real code. ONLY the two Brain boundaries are stubbed:
 *   - extractFacts (the extractor LLM call) — call spy records message +
 *     candidates so the provenance fence and call count are observable;
 *   - streamFactory (the chat reply LLM) — records the composed systemPrompt
 *     so marker injection is assertable at the deterministic
 *     checkpoint.
 *
 * UNTESTABLE at this layer (stub would encode the answer — anti-vacuous rule):
 *   - Verbal half ("the reply names old AND new"): the reply text is
 *     LLM-generated. Deterministic proxy asserted here = the [REPLACED] marker
 *     naming both sides in the systemPrompt. Verbalization verified via live smoke.
 *   - Classification half ("still classified contradict"): whether the
 *     REAL model classifies a marker-free turn as contradict is model
 *     behavior → covered by the eval harness, not here. The deterministic half
 *     (the turn reaches the ONE extractor call WITH candidates) IS asserted below.
 *   - The eval-gate artifact is out of scope here (covered elsewhere).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openIndex } from "../../src/chat/fts5-index";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type {
  StreamChatOptions,
  StreamEvent,
} from "../../src/daemon/routes/chat-stream";
import type { CandidateFact, ExtractedFact } from "../../src/memory/extract-facts";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import {
  emptyMemory,
  readMemory as realReadMemory,
  writeMemory as realWriteMemory,
} from "../../src/memory/memory";

// ── Shared fixtures ─────────────────────────────────────────────────────────

let home: string;
let capturedStreams: StreamChatOptions[];

function fakeStream(
  opts: StreamChatOptions,
): AsyncGenerator<StreamEvent, void, void> {
  capturedStreams.push(opts);
  return (async function* () {
    yield { type: "message_start", message_id: "m-acc", model: "mock" };
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

/** Seeded correctable fact — chat provenance, inside the candidate fence. */
const dogFact = () =>
  fact({
    id: "f-dog",
    text: "用户是狗派",
    learned_from: { stream: "chat", session_id: null },
  });

/** Seed the REAL on-disk store (memory.json under the tmp homeBase). */
async function seed(facts: Fact[]): Promise<void> {
  await realWriteMemory(home, { ...emptyMemory(), facts });
}

/**
 * "store byte-identical" oracle, scoped to the FACTS layer.
 *
 * The whole memory.json is NOT byte-stable across a chat turn regardless of
 * capture: the route's pre-existing session bookkeeping registers the session
 * in `chat_sessions` on every POST (verified empirically — the diff is the
 * session row only). What must stay protected is the memory the corrections
 * touch, so the invariant asserted is: the serialized `facts` array is
 * byte-identical AND the capture seam performed zero writes.
 */
async function factsBytes(): Promise<string> {
  return JSON.stringify((await store()).facts);
}

/** Read the real store back the way production reads it. */
async function store(): Promise<CoreMemory> {
  const mem = await realReadMemory(home);
  if (!mem) throw new Error("store unreadable — seeding failed");
  return mem;
}

interface ExtractorCall {
  message: string;
  candidates: CandidateFact[] | undefined;
}

interface Harness {
  app: Hono;
  /** Pass-through writeMemory spy — counts atomic writes, delegates to disk. */
  writes: CoreMemory[];
  /** Extractor (Brain-boundary) spy — message + fenced candidates per call. */
  extractorCalls: ExtractorCall[];
}

/**
 * Mount the real chat route. Only the extractor stub is injectable; memory
 * read/write are the REAL disk-backed functions (write wrapped in a counting
 * pass-through so single-write atomicity stays observable from outside).
 */
function mount(
  extract: (
    message: string,
    candidates: CandidateFact[] | undefined,
  ) => Promise<ExtractedFact[]>,
): Harness {
  const app = new Hono();
  const writes: CoreMemory[] = [];
  const extractorCalls: ExtractorCall[] = [];
  mountChatRoutes(app, {
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    readMemory: async (hb: string) => realReadMemory(hb),
    writeMemory: async (hb: string, memory: CoreMemory) => {
      writes.push(memory);
      await realWriteMemory(hb, memory);
    },
    // The route dep type is 2-param; the runner invokes it with the fenced
    // candidate list as a 3rd argument (optional param — assignable), which
    // is how the provenance fence assertion observes what the Brain would see.
    extractFacts: async (
      message: string,
      _deps: { homeBase: string; sessionId: string },
      candidates?: CandidateFact[],
    ) => {
      extractorCalls.push({ message, candidates });
      return extract(message, candidates);
    },
  });
  return { app, writes, extractorCalls };
}

const contradictStub =
  (confidence: number, target = "f-dog") =>
  async (): Promise<ExtractedFact[]> => [
    {
      text: "用户是猫派",
      entities: [],
      classification: "contradict",
      target_fact_id: target,
      confidence,
    },
  ];

async function post(a: Hono, message: string): Promise<Response> {
  return a.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}
async function drain(res: Response): Promise<void> {
  await res.text(); // consume SSE so the stream's start() runs (captures opts)
}

function systemPrompt(i = 0): string {
  return capturedStreams[i]?.systemPrompt ?? "";
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-correction-acc-"));
  capturedStreams = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// ── acceptance cases ────────────────────────────────────────────────────────

describe("chat-memory correction — acceptance", () => {
  test("correction happy path — new active fact supersedes, old retired, ONE atomic write", async () => {
    await seed([dogFact()]);
    const { app, writes } = mount(contradictStub(0.95));
    await drain(await post(app, "不对，我是猫派不是狗派"));

    // ONE atomic write carried both sides (no intermediate both-retired state
    // is observable because there was exactly one store transition).
    expect(writes).toHaveLength(1);

    // Oracle = the REAL store read back from disk, not the route's internals.
    const mem = await store();
    const cat = mem.facts.find((f) => f.text === "用户是猫派");
    expect(cat?.status).toBe("active");
    expect(cat?.supersedes).toBe("f-dog");
    expect(cat?.learned_from?.stream).toBe("chat");
    const dog = mem.facts.find((f) => f.id === "f-dog");
    expect(dog?.status).toBe("retired");
    expect(dog?.retired_reason).toBe("superseded");
    expect(dog?.superseded_by).toBe(cat?.id ?? "");
    expect(dog?.invalid_at).not.toBeNull();
    // Never deleted: both facts still present.
    expect(mem.facts).toHaveLength(2);
    // At no point are both retired (final-state check; single write above is
    // the atomicity proof): exactly one of the pair is active.
    expect(mem.facts.filter((f) => f.status === "active")).toHaveLength(1);
  });

  test("[REPLACED] marker names old AND new; marker present iff the op happened", async () => {
    await seed([dogFact()]);
    const { app, writes } = mount(contradictStub(0.95));
    await drain(await post(app, "不对，我是猫派不是狗派"));

    const sp = systemPrompt();
    // Marker names BOTH sides (deterministic proxy for the verbal both-sides
    // ack — the reply words themselves are LLM output, verified via live smoke).
    expect(sp).toContain('[REPLACED: "用户是狗派" → "用户是猫派"]');
    // No false add-family ack alongside the replacement.
    expect(sp).not.toContain("[SAVED:");
    // Honesty invariant, both directions on this turn: op happened (1 write)
    // AND its marker is present; the framing forbids claiming without one.
    expect(writes).toHaveLength(1);
    expect(sp).toContain("unless a [REPLACED] marker is present");
  });

  test("conversational undo — correcting back supersedes the correction; chain fully linked, nothing deleted", async () => {
    await seed([dogFact()]);
    // Turn-aware stub: when the store's candidates contain the cat fact
    // (turn 2), contradict IT back to 狗派; otherwise contradict f-dog.
    const { app, writes } = mount(async (_msg, candidates) => {
      const cat = candidates?.find((c) => c.text === "用户是猫派");
      if (cat) {
        return [
          {
            text: "用户是狗派",
            entities: [],
            classification: "contradict",
            target_fact_id: cat.id,
            confidence: 0.95,
          },
        ];
      }
      return [
        {
          text: "用户是猫派",
          entities: [],
          classification: "contradict",
          target_fact_id: "f-dog",
          confidence: 0.95,
        },
      ];
    });

    await drain(await post(app, "不对，我是猫派不是狗派"));
    await drain(await post(app, "搞错了，还是狗派"));
    expect(writes).toHaveLength(2); // one atomic write per turn

    const mem = await store();
    // Nothing deleted: original + correction + undo all present.
    expect(mem.facts).toHaveLength(3);
    const dog = mem.facts.find((f) => f.id === "f-dog");
    const cat = mem.facts.find((f) => f.text === "用户是猫派");
    const dogAgain = mem.facts.find(
      (f) => f.text === "用户是狗派" && f.id !== "f-dog",
    );
    // Chain old→new→newer fully linked.
    expect(dog?.status).toBe("retired");
    expect(dog?.superseded_by).toBe(cat?.id ?? "");
    expect(cat?.status).toBe("retired");
    expect(cat?.supersedes).toBe("f-dog");
    expect(cat?.superseded_by).toBe(dogAgain?.id ?? "");
    expect(cat?.retired_reason).toBe("superseded");
    expect(dogAgain?.status).toBe("active");
    expect(dogAgain?.supersedes).toBe(cat?.id ?? "");
    // The undo turn acks with its own [REPLACED] naming both sides.
    expect(systemPrompt(1)).toContain('[REPLACED: "用户是猫派" → "用户是狗派"]');
  });

  test("marker-free correction — the turn ('我现在是猫派了') reaches the single extractor call WITH candidates", async () => {
    // Deterministic half only: this requires the marker-free turn to be seen by
    // the ONE merged call alongside candidates ("single call sees candidates").
    // Whether the REAL model then classifies it contradict is model behavior —
    // that half is eval / live smoke, NOT stub-encodable here.
    await seed([dogFact()]);
    const { app, extractorCalls } = mount(async () => []);
    await drain(await post(app, "我现在是猫派了"));

    expect(extractorCalls).toHaveLength(1);
    expect(extractorCalls[0]?.message).toBe("我现在是猫派了");
    expect(extractorCalls[0]?.candidates?.map((c) => c.id)).toEqual(["f-dog"]);
  });

  test("negative control — pet-output correction ('不对，13×7=91') leaves the store byte-identical, no marker", async () => {
    await seed([dogFact()]);
    const before = await factsBytes();
    // The real extractor's durable-first-person contract returns [] for a
    // pet-output correction; the stub models that verdict (the gate having
    // ADMITTED the turn is asserted via the recorded call).
    const { app, writes, extractorCalls } = mount(async () => []);
    await drain(await post(app, "不对，13×7=91"));

    expect(extractorCalls).toHaveLength(1); // widened gate admitted the turn…
    expect(writes).toHaveLength(0); // …capture wrote nothing…
    expect(await factsBytes()).toBe(before); // …and the on-disk facts are byte-identical.
    const sp = systemPrompt();
    expect(sp).not.toContain("[SAVED:");
    expect(sp).not.toContain("[ALREADY KNOWN:");
    expect(sp).not.toContain("[REPLACED:");
    expect(sp).not.toContain("[PROPOSED-REPLACE:");
  });

  test("negative control — plain new-fact turn behaves exactly as before this change (add path, [SAVED] ack)", async () => {
    await seed([]);
    // Pre-track extractor shape: no classification/target/confidence fields.
    const { app, writes } = mount(async () => [
      { text: "喜欢吃蛋糕", entities: [] },
    ]);
    await drain(await post(app, "我喜欢吃蛋糕"));

    expect(writes).toHaveLength(1);
    const mem = await store();
    const saved = mem.facts.find((f) => f.text === "喜欢吃蛋糕");
    expect(saved?.status).toBe("active");
    expect(saved?.learned_from?.stream).toBe("chat");
    expect(saved?.save_reason).toBe("noticed while chatting");
    expect(saved?.supersedes).toBeNull();
    const sp = systemPrompt();
    expect(sp).toContain('[SAVED: "喜欢吃蛋糕"]');
    expect(sp).not.toContain("[REPLACED:");
    expect(sp).not.toContain("[PROPOSED-REPLACE:");
  });

  test("provenance fence — commit-derived fact absent from candidates; contradict naming it falls to plain add, commit fact untouched", async () => {
    await seed([
      fact({
        id: "f-commit",
        text: "用户是狗派",
        learned_from: { stream: "commit", session_id: null },
      }),
    ]);
    const { app, writes, extractorCalls } = mount(
      contradictStub(0.95, "f-commit"),
    );
    await drain(await post(app, "不对，我是猫派不是狗派"));

    // (a) the fence: the candidate list handed across the Brain boundary
    // EXCLUDES the commit-stream fact (unnameable by construction).
    expect(extractorCalls).toHaveLength(1);
    expect(extractorCalls[0]?.candidates).toEqual([]);

    // (b) the phantom-target contradict degraded to a plain add.
    expect(writes).toHaveLength(1);
    const mem = await store();
    const commit = mem.facts.find((f) => f.id === "f-commit");
    expect(commit?.status).toBe("active");
    expect(commit?.superseded_by).toBeNull();
    expect(commit?.retired_reason).toBeNull();
    const added = mem.facts.find((f) => f.text === "用户是猫派");
    expect(added?.status).toBe("active");
    expect(added?.supersedes).toBeNull();
    const sp = systemPrompt();
    expect(sp).toContain('[SAVED: "用户是猫派"]');
    expect(sp).not.toContain("[REPLACED:");
  });

  test("ladder mid-band (0.8) — new claim lands PENDING, old fact untouched, ack does NOT claim replacement", async () => {
    await seed([dogFact()]);
    const { app, writes } = mount(contradictStub(0.8));
    await drain(await post(app, "不对，我是猫派不是狗派"));

    expect(writes).toHaveLength(1);
    const mem = await store();
    const pending = mem.facts.find((f) => f.text === "用户是猫派");
    expect(pending?.status).toBe("pending");
    expect(pending?.supersedes).toBe("f-dog");
    const dog = mem.facts.find((f) => f.id === "f-dog");
    expect(dog?.status).toBe("active");
    expect(dog?.retired_reason).toBeNull();
    expect(dog?.superseded_by).toBeNull();
    expect(dog?.invalid_at).toBeNull();
    const sp = systemPrompt();
    expect(sp).toContain("[PROPOSED-REPLACE:");
    expect(sp).not.toContain("[REPLACED:");
  });

  test("ladder floor (0.5) — no store change, no [REPLACED] marker", async () => {
    await seed([dogFact()]);
    const before = await factsBytes();
    const { app, writes, extractorCalls } = mount(contradictStub(0.5));
    await drain(await post(app, "不对，我是猫派不是狗派"));

    expect(extractorCalls).toHaveLength(1); // the DROP was code-side, post-call
    expect(writes).toHaveLength(0);
    expect(await factsBytes()).toBe(before);
    const sp = systemPrompt();
    expect(sp).not.toContain("[REPLACED:");
    expect(sp).not.toContain("[PROPOSED-REPLACE:");
    expect(sp).not.toContain("[SAVED:");
  });

  test("atomic multi-claim — one add + one correction land in a SINGLE writeMemory carrying both", async () => {
    await seed([dogFact()]);
    const { app, writes } = mount(async () => [
      {
        text: "喜欢吃蛋糕",
        entities: [],
        classification: "add",
        target_fact_id: null,
      },
      {
        text: "用户是猫派",
        entities: [],
        classification: "contradict",
        target_fact_id: "f-dog",
        confidence: 0.95,
      },
    ]);
    await drain(await post(app, "不对，我是猫派不是狗派，另外我喜欢吃蛋糕"));

    // ONE write — crash between claims is impossible (neither-or-both).
    expect(writes).toHaveLength(1);
    const mem = await store();
    expect(mem.facts.find((f) => f.text === "喜欢吃蛋糕")?.status).toBe("active");
    const cat = mem.facts.find((f) => f.text === "用户是猫派");
    expect(cat?.status).toBe("active");
    expect(cat?.supersedes).toBe("f-dog");
    expect(mem.facts.find((f) => f.id === "f-dog")?.status).toBe("retired");
    const sp = systemPrompt();
    expect(sp).toContain('[SAVED: "喜欢吃蛋糕"]');
    expect(sp).toContain('[REPLACED: "用户是狗派" → "用户是猫派"]');
  });

  test("no new hot-path spawn — exactly ONE extractor (Brain) call for a fact-like correction turn", async () => {
    await seed([dogFact()]);
    const { app, extractorCalls } = mount(contradictStub(0.95));
    await drain(await post(app, "不对，我是猫派不是狗派"));

    expect(extractorCalls).toHaveLength(1); // capture Brain seam: one call
    expect(capturedStreams).toHaveLength(1); // reply stream: one (pre-existing)
  });

  // Deliberately NO test here for the eval-gate artifact: the labeled set +
  // before/after run + threshold lock is a separate deliverable, not observable
  // at the HTTP/store layer, and a placeholder would be a vacuous pass.
});
