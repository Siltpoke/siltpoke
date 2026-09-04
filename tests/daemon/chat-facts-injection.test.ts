// Recall leg — the chat route injects active user-facts into
// the system prompt sent to the model, via deps.readMemory (the same store the
// /memory page reads). Uses a capturing fake streamFactory + a stubbed readMemory.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import { openIndex } from "../../src/chat/fts5-index";
import { emptyMemory } from "../../src/memory/memory";
import type { CoreMemory, Fact } from "../../src/memory/memory";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";

const TEST_SECRET = "test-secret";

const ELIGIBLE_PROJECT = async () => ({
  project_id: null,
  proj_hash: null,
  project_root: null,
  display_name: null,
  source: "explicit" as const,
});

let home: string;
let captured: StreamChatOptions[];

function fakeStream(opts: StreamChatOptions): AsyncGenerator<StreamEvent, void, void> {
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
    ...over,
  };
}

function memWith(facts: Fact[]): CoreMemory {
  return { ...emptyMemory(), facts };
}

/** Mount the chat route with a stubbed readMemory (or none). */
function app(readMemory?: () => Promise<CoreMemory | null>): Hono {
  const a = new Hono();
  mountChatRoutes(a, {
    resolveProject: ELIGIBLE_PROJECT,
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    readMemory,
    secret: TEST_SECRET,
  });
  return a;
}

async function post(a: Hono, body: unknown): Promise<Response> {
  return a.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
    body: JSON.stringify(body),
  });
}
async function drain(res: Response): Promise<void> {
  await res.text(); // consume SSE so the stream's start() runs (captures opts)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-facts-"));
  captured = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("chat fact-injection", () => {
  test("active facts land in the system prompt as a <user_context> block", async () => {
    const a = app(async () =>
      memWith([
        fact({ id: "zh", text: "the user prefers concise answers" }),
        fact({ id: "dan", text: "User's partner is Alex" }),
      ]),
    );
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt).toContain("<user_context>");
    expect(captured[0].systemPrompt).toContain("the user prefers concise answers");
    expect(captured[0].systemPrompt).toContain("User's partner is Alex");
  });

  test("retired facts do NOT leak; active null-stream facts DO inject", async () => {
    const a = app(async () =>
      memWith([
        fact({ id: "en", text: "User prefers responses in English", status: "retired" }),
        fact({ id: "zh", text: "the user prefers concise answers", status: "active", learned_from: null }),
      ]),
    );
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured[0].systemPrompt).toContain("the user prefers concise answers");
    expect(captured[0].systemPrompt).not.toContain("English");
  });

  test("a project with 0 active facts emits NO <user_context> block", async () => {
    const a = app(async () => memWith([fact({ status: "pending" })]));
    const res = await post(a, { message: "hi" });
    await drain(res);
    // no active facts → no block → no anchor/recall either → undefined system prompt
    expect(captured[0].systemPrompt ?? "").not.toContain("<user_context>");
  });

  test("contingency — readMemory returning null injects nothing, no throw", async () => {
    const a = app(async () => null);
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(res.status).toBe(200);
    expect(captured[0].systemPrompt ?? "").not.toContain("<user_context>");
  });

  test("readMemory is invoked with deps.homeBase (correct-store contract)", async () => {
    // Store-resolution itself lives in readMemory (resolveProjectRoot(cwd) = the
    // same store the /memory page reads, separately tested). This pins the route's
    // half of the contract: it asks readMemory for THIS home's facts.
    const seen: string[] = [];
    const a = new Hono();
    mountChatRoutes(a, {
      resolveProject: ELIGIBLE_PROJECT,
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      secret: TEST_SECRET,
      readMemory: async (hb: string) => {
        seen.push(hb);
        return memWith([fact({ text: "User prefers the color teal" })]);
      },
    });
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(seen).toEqual([home]);
    expect(captured[0].systemPrompt).toContain("User prefers the color teal");
  });

  test("back-compat — no readMemory dep → no facts, route still streams", async () => {
    const a = app(undefined);
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt ?? "").not.toContain("<user_context>");
  });
});
