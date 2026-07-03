import { test, expect, describe } from "bun:test";
import {
  parseChatArgs,
  consumeSseStream,
  runChat,
} from "../../src/cli/chat";

describe("parseChatArgs", () => {
  test("no args → repl", () => {
    expect(parseChatArgs([]).mode).toBe("repl");
  });
  test("positional → single-turn", () => {
    const p = parseChatArgs(["hello", "world"]);
    expect(p.mode).toBe("single");
    expect(p.message).toBe("hello world");
  });
  test("--session captures id", () => {
    const p = parseChatArgs(["--session", "s-1", "hi"]);
    expect(p.sessionId).toBe("s-1");
    expect(p.mode).toBe("single");
  });
  test("--model captures model", () => {
    const p = parseChatArgs(["--model", "claude-haiku-4-5", "hi"]);
    expect(p.model).toBe("claude-haiku-4-5");
  });
  test("--search → search mode", () => {
    const p = parseChatArgs(["--search", "ripgrep"]);
    expect(p.mode).toBe("search");
    expect(p.query).toBe("ripgrep");
  });
  test("--limit parsed as int", () => {
    const p = parseChatArgs(["--search", "x", "--limit", "5"]);
    expect(p.limit).toBe(5);
  });
  test("--limit rejects non-positive", () => {
    expect(parseChatArgs(["--search", "x", "--limit", "0"]).error).toMatch(
      /positive/,
    );
    expect(parseChatArgs(["--search", "x", "--limit", "abc"]).error).toMatch(
      /positive/,
    );
  });
  test("--session without value errors", () => {
    expect(parseChatArgs(["--session"]).error).toMatch(/requires/);
  });
  test("--help → help mode", () => {
    expect(parseChatArgs(["--help"]).mode).toBe("help");
  });
  test("unknown flag errors", () => {
    expect(parseChatArgs(["--bogus"]).error).toMatch(/unknown flag/);
  });
});

function sseBody(blocks: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = blocks.map((b) =>
    enc.encode(`event: ${b.event}\ndata: ${JSON.stringify(b.data)}\n\n`),
  );
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        c.enqueue(chunks[i]!);
        i += 1;
      } else {
        c.close();
      }
    },
  });
}

describe("consumeSseStream", () => {
  test("collects content_block_delta text", async () => {
    const body = sseBody([
      { event: "message_start", data: { model: "x" } },
      { event: "content_block_delta", data: { text: "hello " } },
      { event: "content_block_delta", data: { text: "world" } },
      { event: "message_stop", data: { usage: {} } },
    ]);
    const res = new Response(body, {
      headers: { "X-Siltpoke-Session-Id": "s-1" },
    });
    let buf = "";
    const result = await consumeSseStream(res, (s) => (buf += s));
    expect(buf).toBe("hello world");
    expect(result.sessionId).toBe("s-1");
    expect(result.error).toBeNull();
  });

  test("surfaces error event", async () => {
    const body = sseBody([
      { event: "error", data: { error: "boom" } },
    ]);
    const res = new Response(body);
    let buf = "";
    const result = await consumeSseStream(res, (s) => (buf += s));
    expect(result.error).toBe("boom");
  });

  test("skips malformed delta payload", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          enc.encode("event: content_block_delta\ndata: not json\n\n"),
        );
        c.enqueue(
          enc.encode(
            `event: content_block_delta\ndata: ${JSON.stringify({ text: "ok" })}\n\n`,
          ),
        );
        c.close();
      },
    });
    const res = new Response(stream);
    let buf = "";
    await consumeSseStream(res, (s) => (buf += s));
    expect(buf).toBe("ok");
  });
});

describe("runChat", () => {
  test("single-turn happy path", async () => {
    let captured = "";
    const fakeFetch = async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("/api/chat");
      expect(init?.method).toBe("POST");
      const body = sseBody([
        { event: "content_block_delta", data: { text: "yo" } },
      ]);
      return new Response(body, {
        headers: { "X-Siltpoke-Session-Id": "s-new" },
      });
    };
    const code = await runChat({
      argv: ["hello"],
      daemonUrl: "http://test",
      fetchFn: fakeFetch as unknown as typeof fetch,
      out: (s) => (captured += s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(captured).toContain("yo");
  });

  test("daemon unreachable returns 1", async () => {
    const fakeFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    let errMsg = "";
    const code = await runChat({
      argv: ["hello"],
      fetchFn: fakeFetch as unknown as typeof fetch,
      out: () => {},
      err: (s) => (errMsg += s),
    });
    expect(code).toBe(1);
    expect(errMsg).toMatch(/daemon unreachable/);
  });

  test("search mode prints matches", async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          matches: [
            {
              id: "m-1",
              session_id: "s-1",
              role: "user",
              content_snippet: "[rip]grep is great",
              score: -1,
              ts: "2026-05-16T00:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    let captured = "";
    const code = await runChat({
      argv: ["--search", "rip"],
      fetchFn: fakeFetch as unknown as typeof fetch,
      out: (s) => (captured += s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(captured).toContain("[s-1]");
    expect(captured).toContain("[rip]grep");
  });

  test("search mode no matches", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ matches: [] }), { status: 200 });
    let captured = "";
    const code = await runChat({
      argv: ["--search", "nope"],
      fetchFn: fakeFetch as unknown as typeof fetch,
      out: (s) => (captured += s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(captured).toBe("no matches.\n");
  });

  test("help mode exits 0", async () => {
    let captured = "";
    const code = await runChat({
      argv: ["--help"],
      out: (s) => (captured += s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(captured).toContain("Usage:");
  });

  test("CLI flag error returns 3", async () => {
    let errMsg = "";
    const code = await runChat({
      argv: ["--bogus"],
      out: () => {},
      err: (s) => (errMsg += s),
    });
    expect(code).toBe(3);
    expect(errMsg).toMatch(/unknown flag/);
  });
});
