/**
 * Defect [44], the route half: POST /api/chat reads `view` from the request
 * and the selected component reaches the system prompt handed to the model.
 *
 * Asserts at the deterministic checkpoint — the prompt given to the stream
 * factory — not at the model's words.
 *
 * Run: bun test tests/daemon/chat-code-map-view.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openIndex } from "../../src/chat/fts5-index";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import { emptyMemory } from "../../src/memory/memory";

const SECRET = "test-secret";
const VIEW = {
  repo: "siltpoke",
  selection: { kind: "component", title: "Brain", description: "The second-opinion reviewer.", files: ["src/brain/brain.ts"] },
};

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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-view-"));
  captured = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** POST one chat turn and return the system prompt the model was given. */
async function promptFor(body: Record<string, unknown>): Promise<{ status: number; prompt: string }> {
  const app = new Hono();
  mountChatRoutes(app, {
    resolveProject: async () => ({
      project_id: null,
      proj_hash: null,
      project_root: null,
      display_name: null,
      source: "explicit" as const,
    }),
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    readMemory: async () => emptyMemory(),
    secret: SECRET,
  });
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
    body: JSON.stringify({ message: "What does this do?", ...body }),
  });
  await res.text(); // consume the SSE so the stream's start() runs
  return { status: res.status, prompt: captured[0]?.systemPrompt ?? "" };
}

describe("POST /api/chat — the Code Map view (defect [44])", () => {
  test("a chat from the Code Map with a component selected is told which one", async () => {
    const { status, prompt } = await promptFor({ page: "/repo-graph", view: VIEW });
    expect(status).toBe(200);
    expect(prompt).toContain("Repository: siltpoke");
    expect(prompt).toContain("Selected component: Brain");
    expect(prompt).toContain("The second-opinion reviewer.");
    expect(prompt).toContain("- src/brain/brain.ts");
  });

  test("control: the same chat without a view gets only the page label — the old behaviour", async () => {
    const { prompt } = await promptFor({ page: "/repo-graph" });
    expect(prompt).toContain("Code Map page");
    expect(prompt).not.toContain("Brain");
  });

  test("a view that is not an object is ignored, and the turn still goes through", async () => {
    const { status, prompt } = await promptFor({ page: "/repo-graph", view: "Brain" });
    expect(status).toBe(200);
    expect(prompt).toContain("Code Map page");
  });

  test("a view sent with another page is ignored", async () => {
    const { prompt } = await promptFor({ page: "/memory", view: VIEW });
    expect(prompt).not.toContain("Selected component");
  });
});
