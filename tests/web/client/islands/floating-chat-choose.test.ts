/**
 * floating-chat — pick the agent from inside the chat (plan 2026-10-14
 * settings-real-and-chat-agent, Task 2; spec agent-in-use-truth §11.1).
 *
 * Two or more agents installed and none chosen → the server answers
 * `choose_provider` with the agents it found. The failed entry keeps that
 * list; picking one saves `brain.roles.chat` and resends the same message once.
 * Factory tests, no Alpine/DOM; the rendered buttons are covered by the e2e
 * `tests/e2e/chat-choose-agent.spec.ts`.
 */
import { describe, expect, test } from "bun:test";
import { makeFailedEntry } from "../../../../src/web/client/lib/chat-error-copy";
import { makeFloatingChatData } from "../../../../src/web/client/islands/floating-chat";

function sseResponse(...chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "X-Siltpoke-Session-Id": "s-deadbeef" },
  });
}

const CHOOSE = `event: error\ndata: ${JSON.stringify({ reason: "choose_provider", error: "x", found: ["codex", "qoder"] })}\n\n`;
const ANSWER = `event: content_block_delta\ndata: ${JSON.stringify({ text: "hi from qoder" })}\n\n`;

interface Call {
  url: string;
  body: unknown;
  secret: string | null;
}

/** First POST /api/chat fails with choose_provider, later ones answer. */
function fakeFetch(rolesStatus: number) {
  const calls: Call[] = [];
  let chats = 0;
  const fn = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/api/chat/context-preview")) return Response.json({ node: null, page: "/", facts: 0 });
    const headers = new Headers(init?.headers);
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null, secret: headers.get("X-Siltpoke-Secret") });
    if (u === "/api/brain/roles/chat") {
      return Response.json(rolesStatus === 200 ? { ok: true } : { error: "boom" }, { status: rolesStatus });
    }
    if (u === "/api/chat") {
      chats += 1;
      return sseResponse(chats === 1 ? CHOOSE : ANSWER);
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function failedChoose(rolesStatus: number) {
  const f = fakeFetch(rolesStatus);
  const d = makeFloatingChatData(f.fn, { onGraph: () => false, getViewed: () => null });
  d.secret = "s3cret";
  d.newConversation();
  d.draft = "what does this do?";
  await d.send();
  return { d, calls: f.calls };
}

describe("failed entry keeps the agents the server found", () => {
  test("choose_provider with found → entry carries found", () => {
    expect(makeFailedEntry("choose_provider", { found: ["codex", "qoder"] }).found).toEqual(["codex", "qoder"]);
  });

  test("names that are not one of the five are dropped", () => {
    expect(makeFailedEntry("choose_provider", { found: ["codex", "<img>"] }).found).toEqual(["codex"]);
  });

  test("no found → no found key, so no buttons", () => {
    expect("found" in makeFailedEntry("choose_provider", {})).toBe(false);
    expect("found" in makeFailedEntry("timeout", { found: ["codex"] })).toBe(false);
  });

  test("live choose_provider stream → the failed entry has found", async () => {
    const { d } = await failedChoose(200);
    const failed = d.active()!.messages.find((m) => m.status === "failed");
    expect(failed?.found).toEqual(["codex", "qoder"]);
  });
});

describe("pickAgent", () => {
  test("saves the choice once, resends the same text once, and no duplicate bubbles", async () => {
    const { d, calls } = await failedChoose(200);
    const idx = d.active()!.messages.findIndex((m) => m.status === "failed");
    await d.pickAgent("qoder", idx);

    const saves = calls.filter((c) => c.url === "/api/brain/roles/chat");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.body).toEqual({ family: "qoder" });
    expect(saves[0]!.secret).toBe("s3cret");

    const chats = calls.filter((c) => c.url === "/api/chat");
    expect(chats).toHaveLength(2);
    expect((chats[1]!.body as { message: string }).message).toBe("what does this do?");

    const msgs = d.active()!.messages;
    expect(msgs.map((m) => [m.role, m.text, m.status ?? "ok"])).toEqual([
      ["user", "what does this do?", "ok"],
      ["assistant", "hi from qoder", "ok"],
    ]);
  });

  test("a draft typed meanwhile survives the resend", async () => {
    const { d } = await failedChoose(200);
    d.draft = "half-typed";
    const idx = d.active()!.messages.findIndex((m) => m.status === "failed");
    await d.pickAgent("qoder", idx);
    expect(d.draft).toBe("half-typed");
  });

  test("save fails → entry stays, fallback sentence shown, nothing resent", async () => {
    const { d, calls } = await failedChoose(500);
    const idx = d.active()!.messages.findIndex((m) => m.status === "failed");
    await d.pickAgent("qoder", idx);

    expect(calls.filter((c) => c.url === "/api/chat")).toHaveLength(1);
    const failed = d.active()!.messages[idx]!;
    expect(failed.status).toBe("failed");
    expect(failed.pickNote).toBe("could not save — set it on the Settings page");
  });

  // Found in the final review: the question and card were removed before the
  // checks that can stop the resend, so it vanished and was never sent.
  test("switching conversation while the save is in flight keeps the question and resends nothing", async () => {
    const { d, calls } = await failedChoose(200);
    const conv = d.active()!;
    const idx = conv.messages.findIndex((m) => m.status === "failed");
    const picking = d.pickAgent("qoder", idx);
    d.newConversation();
    await picking;

    const back = d.conversations.find((c) => c.id === conv.id)!;
    expect(back.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(back.messages[1]!.pickNote).toBe("saved — send your message again");
    expect(calls.filter((c) => c.url === "/api/chat")).toHaveLength(1);
  });

  test("another reply streaming when the save returns keeps the question and resends nothing", async () => {
    const { d, calls } = await failedChoose(200);
    const idx = d.active()!.messages.findIndex((m) => m.status === "failed");
    const picking = d.pickAgent("qoder", idx);
    d.streaming = true;
    await picking;
    d.streaming = false;

    const msgs = d.active()!.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.pickNote).toBe("saved — send your message again");
    expect(calls.filter((c) => c.url === "/api/chat")).toHaveLength(1);
  });

  test("a family the entry did not list is refused without a request", async () => {
    const { d, calls } = await failedChoose(200);
    const idx = d.active()!.messages.findIndex((m) => m.status === "failed");
    await d.pickAgent("claude", idx);
    expect(calls.filter((c) => c.url === "/api/brain/roles/chat")).toHaveLength(0);
  });
});
