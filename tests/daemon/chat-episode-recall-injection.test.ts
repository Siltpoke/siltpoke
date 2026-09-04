// Episode recall — the chat route injects synthesized episode
// narratives into the system prompt via deps.readMemory (the SAME store + read
// as facts, no second read). Mirrors chat-facts-injection.test.ts's harness:
// a capturing fake streamFactory + a stubbed readMemory. Uses real `now`
// (the route calls `new Date()`), so episode dates are computed relative to it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openIndex } from "../../src/chat/fts5-index";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import type { Episode } from "../../src/memory/episode";
import type { CoreMemory } from "../../src/memory/memory";
import { emptyMemory } from "../../src/memory/memory";

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
    yield { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 }, full_text: "ok" };
  })();
}

const DAY = 86_400_000;
/** Episode whose `time_span.end` is `daysAgo` before the real now. */
function episode(daysAgo: number, over?: Partial<Episode>): Episode {
  const end = new Date(Date.now() - daysAgo * DAY).toISOString();
  return {
    id: `ep-${daysAgo}`,
    day_key: end.slice(0, 10),
    member_fragment_ids: ["ev-1", "ev-2"],
    time_span: { start: end, end },
    narrative: "built out the episode recall leg into chat",
    entity_labels: [],
    version: 1,
    created_at: end,
    updated_at: end,
    expires_at: "2099-01-01T00:00:00Z",
    ...over,
  };
}

function memWithEpisodes(episodes: Episode[]): CoreMemory {
  return { ...emptyMemory(), episodes };
}

function app(
  readMemory?: () => Promise<CoreMemory | null>,
  episodeRecallEnabled?: boolean,
): Hono {
  const a = new Hono();
  mountChatRoutes(a, {
    resolveProject: ELIGIBLE_PROJECT,
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    readMemory,
    episodeRecallEnabled,
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
  await res.text();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-ep-recall-"));
  captured = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Episode recall — chat injection", () => {
  test("a fresh episode lands in the system prompt as an <episode_recall> block", async () => {
    const a = app(async () => memWithEpisodes([episode(2)]));
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt).toContain("<episode_recall>");
    expect(captured[0].systemPrompt).toContain("built out the episode recall leg into chat");
  });

  test("an episode older than the recency window emits NO block (abstain)", async () => {
    const a = app(async () => memWithEpisodes([episode(30)])); // >14d
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured[0].systemPrompt ?? "").not.toContain("<episode_recall>");
  });

  test("episodeRecallEnabled:false emits NO block even with a fresh episode", async () => {
    const a = app(async () => memWithEpisodes([episode(1)]), false);
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured[0].systemPrompt ?? "").not.toContain("<episode_recall>");
  });

  test("a store with 0 episodes emits NO block", async () => {
    const a = app(async () => memWithEpisodes([]));
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured[0].systemPrompt ?? "").not.toContain("<episode_recall>");
  });

  test("readMemory returning null injects nothing, no throw", async () => {
    const a = app(async () => null);
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(res.status).toBe(200);
    expect(captured[0].systemPrompt ?? "").not.toContain("<episode_recall>");
  });

  test("a readMemory throw fails open (route still streams, no block)", async () => {
    const a = app(async () => {
      throw new Error("store read boom");
    });
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt ?? "").not.toContain("<episode_recall>");
  });

  test("recall reuses the single readMemory read (no second store read)", async () => {
    let reads = 0;
    const a = new Hono();
    mountChatRoutes(a, {
      resolveProject: ELIGIBLE_PROJECT,
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      secret: TEST_SECRET,
      readMemory: async () => {
        reads += 1;
        return memWithEpisodes([episode(1)]);
      },
    });
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(reads).toBe(1); // facts + episodes share ONE read (zero added hot-path I/O)
    expect(captured[0].systemPrompt).toContain("<episode_recall>");
  });

  test("back-compat — no readMemory dep → no block, route still streams", async () => {
    const a = app(undefined);
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt ?? "").not.toContain("<episode_recall>");
  });
});
