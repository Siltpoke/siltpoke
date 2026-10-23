// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [49] step 3 — POST /api/chat sends the message to the agent
// `resolveChatProvider` names, and what the wire and the stored row say when it
// cannot.
//
// Two layers on purpose:
//   - the route with an injected resolution (each outcome, one test);
//   - a REAL daemon (`startDaemon`) with nothing injected, a `last-host` record
//     and fake commands on disk — because the line in server.ts that connects
//     the resolver to the route is exactly the kind of line that gets no test
//     (`/settings` sat unmounted for two months with a green screen test).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetQuotaWarnStateForTests } from "../../src/brain/brain-guarded";
import type { ChatProviderResolution } from "../../src/brain/chat-provider";
import { type ChatIndex, openIndex } from "../../src/chat/fts5-index";
import { readSession } from "../../src/chat/jsonl-store";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import { type DaemonHandle, startDaemon, stopDaemon } from "../../src/daemon/server";
import { resetNavAvailability } from "../../src/web/routes/nav";

const SECRET = "test-secret";
const HEADERS = { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET };

type Mode = "answer" | "hang" | "fail";

let home = "";
let bin = "";
let log = "";
let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  // The providers tidy their own old sessions from a registry under the
  // siltpoke home after each call — keep that inside the temp home.
  savedHome = process.env.SILTPOKE_HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "chat-route-provider-home-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "chat-route-provider-bin-")));
  log = join(bin, "launches.jsonl");
  savedPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  process.env.SILTPOKE_HOME = home;
  resetQuotaWarnStateForTests();
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.SILTPOKE_HOME;
  else process.env.SILTPOKE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

function fakeCli(name: string, mode: Mode, reply = "answer from another agent"): string {
  const path = join(bin, name);
  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: ${JSON.stringify(name)}, pid: process.pid }) + "\\n");`,
      "await Bun.stdin.text();",
      `const mode = ${JSON.stringify(mode)};`,
      'if (mode === "hang") { setInterval(() => {}, 1000); await new Promise(() => {}); }',
      'if (mode === "fail") { process.stderr.write("Please run /login\\n"); process.exit(1); }',
      `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(reply)}, usage: { input_tokens: 7, output_tokens: 3 } }));`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function launched(): { bin: string; pid: number }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { bin: string; pid: number });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

/** Parse an SSE body into `{ event, data }` frames. */
function frames(body: string): { event: string; data: Record<string, unknown> }[] {
  return body
    .split("\n\n")
    .filter((b) => b.startsWith("event: "))
    .map((b) => {
      const [first, second] = b.split("\n");
      return {
        event: (first ?? "").slice("event: ".length),
        data: JSON.parse((second ?? "").slice("data: ".length)) as Record<string, unknown>,
      };
    });
}

describe("POST /api/chat — which agent answers (injected resolution)", () => {
  let app: Hono;
  let idx: ChatIndex;
  let ledgered: { model?: string }[];
  let claudeCalls: StreamChatOptions[];

  beforeEach(() => {
    idx = openIndex(home);
    app = new Hono();
    ledgered = [];
    claudeCalls = [];
  });
  afterEach(() => idx.close());

  function mount(resolution: ChatProviderResolution | undefined): void {
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      secret: SECRET,
      ...(resolution ? { resolveChatProvider: () => resolution } : {}),
      // Stands in for `streamChat` — the claude path only.
      streamFactory: async function* (opts) {
        claudeCalls.push(opts);
        yield { type: "message_start", message_id: "m-claude", model: opts.model ?? "claude-default" } as StreamEvent;
        yield { type: "content_block_delta", text: "from claude" } as StreamEvent;
        yield {
          type: "message_stop",
          usage: { input_tokens: 1, output_tokens: 1 },
          full_text: "from claude",
        } as StreamEvent;
      },
      ledgerBrainCall: async (_base, args) => {
        ledgered.push({ model: args.model });
      },
    });
  }

  async function send(): Promise<{ sid: string; body: string }> {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    return { sid: res.headers.get("X-Siltpoke-Session-Id") ?? "", body: await res.text() };
  }

  test("no agent found → no_provider on the wire and in the stored row; nothing is launched", async () => {
    fakeCli("claude", "answer");
    mount({ kind: "none" });
    const { sid, body } = await send();
    const err = frames(body).find((f) => f.event === "error");
    expect(err?.data.reason).toBe("no_provider");
    expect(err?.data.provider).toBeUndefined();
    expect(frames(body).find((f) => f.event === "message_start")?.data.provider).toBeUndefined();
    const row = (await readSession(home, sid))[1];
    expect(row).toMatchObject({ status: "failed", error_reason: "no_provider", content: "" });
    expect(row?.error_provider).toBeUndefined();
    expect(claudeCalls).toEqual([]);
    expect(launched()).toEqual([]);
  });

  test("several found, none chosen → choose_provider, with the names found", async () => {
    mount({ kind: "choose", found: ["codex", "qoder"] });
    const { sid, body } = await send();
    const err = frames(body).find((f) => f.event === "error");
    expect(err?.data).toMatchObject({ reason: "choose_provider", found: ["codex", "qoder"] });
    const row = (await readSession(home, sid))[1];
    expect(row).toMatchObject({ status: "failed", error_reason: "choose_provider", error_found: ["codex", "qoder"] });
    expect(claudeCalls).toEqual([]);
  });

  test("another agent → its command runs, claude does not; the start event says who and that the reply comes whole", async () => {
    fakeCli("codebuddy", "answer", "the whole reply");
    fakeCli("claude", "answer");
    mount({ kind: "use", family: "codebuddy", source: "installed", commandDir: bin });
    const { sid, body } = await send();
    const fs = frames(body);
    const starts = fs.filter((f) => f.event === "message_start");
    expect(starts).toHaveLength(1);
    expect(starts[0]?.data).toMatchObject({ provider: "codebuddy", whole_reply: true });
    expect(fs.filter((f) => f.event === "content_block_delta").map((f) => f.data.text)).toEqual(["the whole reply"]);
    // The route's own `run` frame (chat call record) follows the reply's last frame.
    expect(fs.filter((f) => f.event !== "run").at(-1)?.event).toBe("message_stop");
    expect(launched().map((l) => l.bin)).toEqual(["codebuddy"]);
    expect(claudeCalls).toEqual([]);
    const row = (await readSession(home, sid))[1];
    expect(row).toMatchObject({ role: "assistant", content: "the whole reply", model: null });
    expect(row?.status).toBeUndefined();
    // Quota-billed: tokens are ledgered, no model to derive a dollar figure from.
    expect(ledgered).toEqual([{ model: undefined }]);
  });

  test("another agent fails → provider_failed naming it; its own words reach neither the wire nor the store", async () => {
    fakeCli("codebuddy", "fail");
    mount({ kind: "use", family: "codebuddy", source: "chosen", commandDir: bin });
    const { sid, body } = await send();
    const err = frames(body).find((f) => f.event === "error");
    expect(err?.data).toMatchObject({ reason: "provider_failed", provider: "codebuddy" });
    expect(body).not.toContain("/login");
    expect(body).not.toContain("stderr_tail");
    const row = (await readSession(home, sid))[1];
    expect(row).toMatchObject({ status: "failed", error_reason: "provider_failed", error_provider: "codebuddy" });
    expect(JSON.stringify(row)).not.toContain("/login");
    expect(claudeCalls).toEqual([]);

    // Reopened later: the history route hands the page who failed, so the card
    // reads the same as when it happened.
    const hist = await app.request(`/api/chat/sessions/${sid}/messages`);
    const { messages } = (await hist.json()) as { messages: Record<string, unknown>[] };
    expect(messages[1]).toMatchObject({ status: "failed", error_reason: "provider_failed", error_provider: "codebuddy" });
  });

  test("the history route passes the agents found on a choose_provider row", async () => {
    mount({ kind: "choose", found: ["agy", "codex"] });
    const { sid } = await send();
    const hist = await app.request(`/api/chat/sessions/${sid}/messages`);
    const { messages } = (await hist.json()) as { messages: Record<string, unknown>[] };
    expect(messages[1]).toMatchObject({ error_reason: "choose_provider", error_found: ["agy", "codex"] });
  });

  test("claude → the old stream, with the model chosen for chat; no whole-reply flag; priced by model", async () => {
    mount({ kind: "use", family: "claude", source: "chosen", model: "claude-sonnet-4-6" });
    const { body } = await send();
    expect(claudeCalls.map((c) => c.model)).toEqual(["claude-sonnet-4-6"]);
    const start = frames(body).find((f) => f.event === "message_start");
    expect(start?.data).toMatchObject({ provider: "claude", model: "claude-sonnet-4-6" });
    expect(start?.data.whole_reply).toBeUndefined();
    expect(ledgered).toEqual([{ model: "claude-sonnet-4-6" }]);
  });

  test("a mount with no resolver behaves as before [49]: claude, model left to the stream", async () => {
    fakeCli("codebuddy", "answer");
    mount(undefined);
    await send();
    expect(claudeCalls.map((c) => c.model)).toEqual([undefined]);
    expect(launched()).toEqual([]);
  });

  test("Stop while another agent is answering → its process is gone and the turn is stored as cancelled, not failed", async () => {
    fakeCli("codebuddy", "hang");
    mount({ kind: "use", family: "codebuddy", source: "installed", commandDir: bin });
    const ac = new AbortController();
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "hello" }),
      signal: ac.signal,
    });
    const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // the start event — the turn is under way
    expect(await waitFor(() => launched().length > 0)).toBe(true);
    const pid = (launched()[0] as { pid: number }).pid;
    expect(alive(pid)).toBe(true);
    ac.abort();
    await reader.cancel().catch(() => {});
    expect(await waitFor(() => !alive(pid))).toBe(true);
    expect(await waitFor(async () => (await readSession(home, sid)).length === 2)).toBe(true);
    const row = (await readSession(home, sid))[1];
    expect(row?.status).toBe("cancelled");
    expect(row?.error_reason).toBeUndefined();
  });
});

describe("POST /api/chat on a running daemon — the resolver is really connected", () => {
  let handle: DaemonHandle | null = null;

  afterEach(async () => {
    if (handle) await stopDaemon(handle);
    handle = null;
    resetNavAvailability();
  });

  test("last-host says qoder → the daemon launches qodercli from the recorded folder and never claude", async () => {
    const qoder = fakeCli("qodercli", "answer", "qoder answered");
    fakeCli("claude", "answer", "claude answered");
    writeFileSync(join(home, "last-host"), `qoder\n${qoder}\n`);
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(home, "siltpoked.lock"),
      pidPath: join(home, "siltpoked.pid"),
      markerDir: join(home, "markers"),
      secret: SECRET,
      homeBase: home, // never the real ~/.siltpoke
    });
    const res = await fetch(`http://127.0.0.1:${handle.server.port}/api/chat`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    const fs = frames(await res.text());
    expect(fs.find((f) => f.event === "message_start")?.data).toMatchObject({ provider: "qoder", whole_reply: true });
    expect(fs.filter((f) => f.event === "content_block_delta").map((f) => f.data.text)).toEqual(["qoder answered"]);
    // Only qodercli, never claude. qodercli runs twice: the answer, and the one
    // `--version` the daemon asks for the chat call record (chat-run-route.test.ts
    // tells the two apart by argv).
    expect([...new Set(launched().map((l) => l.bin))]).toEqual(["qodercli"]);
  });
});
