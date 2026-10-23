// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Every dashboard chat call leaves one record (spec 2026-10-13 §5 step 1,
// §10.2), the client is told which record belongs to the answer it got, and
// the records are served per conversation.
//
// Two layers, as in chat-route-provider.test.ts: the route with injected
// streams (each outcome), and a REAL daemon with a fake agent on disk —
// because the server.ts lines that wire the store are exactly the ones that
// get no test otherwise.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resetQuotaWarnStateForTests } from "../../src/brain/brain-guarded";
import type { ChatProviderResolution } from "../../src/brain/chat-provider";
import { type ChatIndex, openIndex } from "../../src/chat/fts5-index";
import { readSession } from "../../src/chat/jsonl-store";
import type { ChatRun } from "../../src/chat/run-store";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import { type DaemonHandle, startDaemon, stopDaemon } from "../../src/daemon/server";
import { resetNavAvailability } from "../../src/web/routes/nav";

const SECRET = "test-secret";
const HEADERS = { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET };

let home = "";
let bin = "";
let log = "";
let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.SILTPOKE_HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "chat-run-route-home-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "chat-run-route-bin-")));
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

/** A CC-fork-shaped fake agent that logs each launch with its argv. */
function fakeCli(name: string, reply = "answer from another agent"): string {
  const path = join(bin, name);
  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + "\\n");`,
      `if (process.argv.includes("--version")) { process.stdout.write("${name} 0.0.1-fake\\n"); process.exit(0); }`,
      "await Bun.stdin.text();",
      `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(reply)}, usage: { input_tokens: 7, output_tokens: 3 } }));`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function launched(): { bin: string; argv: string[] }[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { bin: string; argv: string[] });
}

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

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

describe("chat call records through the route (injected streams)", () => {
  let app: Hono;
  let idx: ChatIndex;

  beforeEach(() => {
    idx = openIndex(home);
    app = new Hono();
  });
  afterEach(() => idx.close());

  const okStream = async function* (opts: StreamChatOptions): AsyncGenerator<StreamEvent, void, void> {
    opts.onRawLine?.(JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-4-5-20251001" }));
    yield { type: "message_start", message_id: "", model: opts.model ?? "x" };
    yield { type: "content_block_delta", text: "hello back" };
    opts.onExit?.(0);
    yield { type: "message_stop", usage: { input_tokens: 2, output_tokens: 3 }, full_text: "hello back" };
  };

  /** Waits for the stop signal, the way a real call does when the user presses Stop. */
  const hangingStream = async function* (opts: StreamChatOptions): AsyncGenerator<StreamEvent, void, void> {
    yield { type: "message_start", message_id: "", model: "x" };
    opts.onRawLine?.('{"type":"system","subtype":"init"}');
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) resolve();
      opts.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  };

  function mount(
    resolution: ChatProviderResolution | undefined,
    streamFactory: (opts: StreamChatOptions) => AsyncGenerator<StreamEvent, void, void> = okStream,
  ): void {
    mountChatRoutes(app, {
      homeBase: home,
      index: idx,
      secret: SECRET,
      ...(resolution ? { resolveChatProvider: () => resolution } : {}),
      streamFactory,
      ledgerBrainCall: async () => {},
    });
  }

  async function send(sessionId?: string): Promise<{ sid: string; body: string }> {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ message: "hello", ...(sessionId ? { session_id: sessionId } : {}) }),
    });
    expect(res.status).toBe(200);
    return { sid: res.headers.get("X-Siltpoke-Session-Id") ?? "", body: await res.text() };
  }

  async function runs(sid: string): Promise<ChatRun[]> {
    const res = await app.request(`/api/chat/sessions/${sid}/runs`, { headers: HEADERS });
    expect(res.status).toBe(200);
    return ((await res.json()) as { runs: ChatRun[] }).runs;
  }

  test("one send → a `run` event naming the stored answer, and one record for it", async () => {
    mount({ kind: "use", family: "claude", source: "chosen", model: "claude-haiku-4-5-20251001" });
    const { sid, body } = await send();
    const run = frames(body).find((f) => f.event === "run");
    const answer = (await readSession(home, sid)).find((m) => m.role === "assistant");
    expect(run?.data).toMatchObject({ message_id: answer?.id, recorded: true });
    const [rec, ...rest] = await runs(sid);
    expect(rest).toEqual([]);
    expect(rec).toMatchObject({
      run_id: run?.data.run_id,
      message_id: answer?.id,
      family: "claude",
      source: "chosen",
      model_requested: "claude-haiku-4-5-20251001",
      model_reported: "claude-haiku-4-5-20251001",
      outcome: "ok",
      exit_code: 0,
    });
    expect(rec?.prompt_blocks.at(-1)?.name).toBe("conversation");
    expect(rec?.command.slice(0, 2)).toEqual(["claude", "-p"]);
  });

  test("the `run` event comes after the answer's last frame", async () => {
    mount(undefined);
    const { body } = await send();
    const names = frames(body).map((f) => f.event);
    expect(names.indexOf("run")).toBeGreaterThan(names.indexOf("message_stop"));
    expect(names.at(-1)).toBe("run");
  });

  test("no resolver wired (the old claude-only mount) is recorded as source `default`", async () => {
    mount(undefined);
    const { sid } = await send();
    expect((await runs(sid))[0]).toMatchObject({ family: "claude", source: "default" });
  });

  test("two answers in one conversation → two records, oldest first, each linked to its own answer", async () => {
    mount(undefined);
    const first = await send();
    await send(first.sid);
    const answers = (await readSession(home, first.sid)).filter((m) => m.role === "assistant").map((m) => m.id);
    const recs = await runs(first.sid);
    expect(recs.map((r) => r.message_id)).toEqual(answers);
    expect(new Set(answers).size).toBe(2);
  });

  test("a record that cannot be written does not cost the answer", async () => {
    writeFileSync(join(home, "chat-runs"), "not a folder");
    mount(undefined);
    const { sid, body } = await send();
    expect(frames(body).find((f) => f.event === "run")?.data).toMatchObject({ recorded: false });
    expect((await readSession(home, sid)).find((m) => m.role === "assistant")?.content).toBe("hello back");
    expect(await runs(sid)).toEqual([]);
  });

  test("an agent that answered still leaves a record when saving the answer fails afterwards", async () => {
    // The agent answers; then the search index breaks, so the insert of the
    // ANSWER throws (the user's message was already stored).
    mount(undefined, async function* (opts) {
      yield* okStream(opts);
      idx.close();
    });
    const res = await app.request("/api/chat", { method: "POST", headers: HEADERS, body: JSON.stringify({ message: "hello" }) });
    const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
    try {
      await res.text();
    } catch {
      // the stream may error out — the record is what this test is about
    }
    idx = openIndex(home); // afterEach closes it again
    expect(await waitFor(async () => (await runs(sid)).length > 0, 2_000)).toBe(true);
    expect((await runs(sid))[0]).toMatchObject({ outcome: "ok", family: "claude" });
  });

  test("Stop mid-call → exactly one record, cancelled, with the output that arrived", async () => {
    mount(undefined, hangingStream);
    const res = await app.request("/api/chat", { method: "POST", headers: HEADERS, body: JSON.stringify({ message: "hello" }) });
    const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    expect(await waitFor(async () => (await runs(sid)).length > 0)).toBe(true);
    await Bun.sleep(100);
    const recs = await runs(sid);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ outcome: "cancelled" });
    expect(recs[0]?.output.length).toBe(1);
  });

  test("two agents and none chosen → a failed record that names no agent", async () => {
    mount({ kind: "choose", found: ["codex", "qoder"] });
    const { sid } = await send();
    expect((await runs(sid))[0]).toMatchObject({
      family: null,
      source: null,
      outcome: "failed",
      failure_reason: "choose_provider",
      cost: null,
    });
  });

  test("deleting the conversation deletes its records", async () => {
    mount(undefined);
    const { sid } = await send();
    expect((await runs(sid)).length).toBe(1);
    const del = await app.request(`/api/chat/sessions/${sid}`, { method: "DELETE", headers: HEADERS });
    expect(del.status).toBe(200);
    expect(await runs(sid)).toEqual([]);
  });

  test("the runs route wants the secret and a well-formed id", async () => {
    mount(undefined);
    const { sid } = await send();
    expect((await app.request(`/api/chat/sessions/${sid}/runs`)).status).toBe(401);
    expect((await app.request("/api/chat/sessions/bad.id/runs", { headers: HEADERS })).status).toBe(400);
  });
});

describe("chat call records through a real daemon", () => {
  let handle: DaemonHandle | null = null;
  afterEach(async () => {
    if (handle) await stopDaemon(handle);
    handle = null;
    resetNavAvailability();
  });

  test("last-host says codebuddy → a record of what codebuddy was started with and printed", async () => {
    const cb = fakeCli("codebuddy", "codebuddy answered");
    writeFileSync(join(home, "last-host"), `codebuddy\n${cb}\n`);
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(home, "siltpoked.lock"),
      pidPath: join(home, "siltpoked.pid"),
      markerDir: join(home, "markers"),
      secret: SECRET,
      homeBase: home, // never the real ~/.siltpoke
    });
    const base = `http://127.0.0.1:${handle.server.port}`;
    const res = await fetch(`${base}/api/chat`, { method: "POST", headers: HEADERS, body: JSON.stringify({ message: "hello" }) });
    expect(res.status).toBe(200);
    const sid = res.headers.get("X-Siltpoke-Session-Id") ?? "";
    const body = await res.text();
    expect(frames(body).find((f) => f.event === "run")?.data).toMatchObject({ recorded: true });
    const recs = ((await (await fetch(`${base}/api/chat/sessions/${sid}/runs`, { headers: HEADERS })).json()) as { runs: ChatRun[] }).runs;
    expect(recs).toHaveLength(1);
    const rec = recs[0] as ChatRun;
    expect(rec).toMatchObject({
      family: "codebuddy",
      source: "installed",
      model_reported: null,
      outcome: "ok",
      exit_code: 0,
      cost: { kind: "quota" },
      cli_version: "codebuddy 0.0.1-fake",
    });
    expect(rec.command[0]).toContain("codebuddy");
    expect(rec.output.map((o) => o.line).join("\n")).toContain("codebuddy answered");
    // The answer itself ran once; the version was asked once; claude never ran.
    const runsOf = launched();
    expect(runsOf.filter((l) => !l.argv.includes("--version")).map((l) => l.bin)).toEqual(["codebuddy"]);
    expect(runsOf.filter((l) => l.argv.includes("--version"))).toHaveLength(1);
  });
});
