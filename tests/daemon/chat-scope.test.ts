/**
 * Chat send-path per-request memory scope (Leg A — T3, AC3 + un-anchored).
 *
 * The chat route resolves ONE memory scope per send and threads it to the
 * recall read + capture read/write:
 *   - anchored   → resolveProjectRootByHash(anchor.proj_hash) → that repo's cwd.
 *   - un-anchored → GLOBAL_ONLY (cwd-independent global store; never the `/` slice).
 * A spy readMemory/writeMemory records the scope each call received.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import { openIndex } from "../../src/chat/fts5-index";
import {
  emptyMemory,
  GLOBAL_ONLY,
  type CoreMemory,
  type ProjectScope,
} from "../../src/memory/memory";
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

function fakeStream(_opts: StreamChatOptions): AsyncGenerator<StreamEvent, void, void> {
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

interface Harness {
  app: Hono;
  readScopes: (ProjectScope | undefined)[];
  writeScopes: (ProjectScope | undefined)[];
}

function buildHarness(opts: {
  resolveProjectRootByHash?: (h: string) => Promise<string | null>;
}): Harness {
  const readScopes: (ProjectScope | undefined)[] = [];
  const writeScopes: (ProjectScope | undefined)[] = [];
  const app = new Hono();
  mountChatRoutes(app, {
    resolveProject: ELIGIBLE_PROJECT,
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    secret: TEST_SECRET,
    resolveProjectRootByHash: opts.resolveProjectRootByHash,
    readMemory: async (_h, projectCwd): Promise<CoreMemory | null> => {
      readScopes.push(projectCwd);
      return emptyMemory();
    },
    writeMemory: async (_h, _m, projectCwd): Promise<void> => {
      writeScopes.push(projectCwd);
    },
  });
  return { app, readScopes, writeScopes };
}

async function post(app: Hono, body: unknown): Promise<void> {
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
    body: JSON.stringify(body),
  });
  await res.text(); // drain SSE so start() runs
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-scope-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("chat send-path memory scope", () => {
  test("un-anchored send reads with GLOBAL_ONLY", async () => {
    const h = buildHarness({});
    await post(h.app, { message: "hi" });
    expect(h.readScopes.length).toBeGreaterThan(0);
    for (const s of h.readScopes) expect(s).toBe(GLOBAL_ONLY);
  });

  test("AC3 — anchored send reads with the resolved project root", async () => {
    const seen: string[] = [];
    const h = buildHarness({
      resolveProjectRootByHash: async (hash) => {
        seen.push(hash);
        return "/resolved/repo/root";
      },
    });
    await post(h.app, {
      message: "hi",
      anchor: { proj_hash: "abcd1234abcd1234", node_id: "n-1" },
    });
    expect(seen).toEqual(["abcd1234abcd1234"]);
    expect(h.readScopes.length).toBeGreaterThan(0);
    for (const s of h.readScopes) expect(s).toBe("/resolved/repo/root");
  });

  test("anchored but unresolvable hash falls back to GLOBAL_ONLY", async () => {
    const h = buildHarness({
      resolveProjectRootByHash: async () => null, // no indexed repo
    });
    await post(h.app, {
      message: "hi",
      anchor: { proj_hash: "deadbeefdeadbeef", node_id: "n-1" },
    });
    for (const s of h.readScopes) expect(s).toBe(GLOBAL_ONLY);
  });

  test("capture write is threaded with the SAME scope as the read (un-anchored → GLOBAL_ONLY)", async () => {
    const h = buildHarness({});
    // An explicit  fires the capture write path.
    await post(h.app, { message: "记住 我喜欢中文" });
    expect(h.writeScopes.length).toBeGreaterThan(0);
    for (const s of h.writeScopes) expect(s).toBe(GLOBAL_ONLY);
    for (const s of h.readScopes) expect(s).toBe(GLOBAL_ONLY);
  });
});
