// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[26]`, third face — the dashboard's chat, audit §40.4.
 *
 * `startClaudeSession` put the whole system prompt in argv and spawned the
 * same `claude.cmd` the reviewer does, so on Windows every chat turn failed
 * before the process started.
 *
 * The spawn seam is a stand-in for the child, and it is used the way the child
 * would use it: it reads the staged file AT SPAWN TIME, which is the only
 * moment the file is guaranteed to exist. The removal is then asserted after
 * the turn ends, so "written" and "cleaned up" are two separate claims with
 * two separate assertions rather than one that could pass either way.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { type StreamChatOptions, type StreamEvent, streamChat } from "../../src/daemon/routes/chat-stream";

const PROMPT = 'CHAT SYSTEM & "quoted" (parens) 100% | <tag>';

const OK_LINES = [
  JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }] } }),
  JSON.stringify({ type: "result", subtype: "success", result: "hi", usage: { input_tokens: 1, output_tokens: 1 } }),
];

/** Records the argv, and reads the staged file the way the real child would. */
function recordingSpawn(): {
  spawnFn: typeof Bun.spawn;
  argv: () => string[];
  seenPromptFile: () => string | null;
} {
  let seen: string[] = [];
  let content: string | null = null;
  const enc = new TextEncoder();
  const spawnFn = ((args: string[]) => {
    seen = args;
    const at = args.indexOf("--system-prompt-file");
    // The child reads its prompt file at startup; do the same here, because
    // after the turn the file is (correctly) gone.
    if (at >= 0) content = readFileSync(args[at + 1] as string, "utf8");
    return {
      stdin: { write() {}, end() {} },
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          for (const l of OK_LINES) c.enqueue(enc.encode(`${l}\n`));
          c.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, argv: () => seen, seenPromptFile: () => content };
}

/**
 * A child that accepts the spawn and then dies on the first write — EPIPE,
 * which is exactly what an unrecognized `--system-prompt-file` produces. So
 * the flag this change introduces is itself the way to reach this path, and
 * the leak it exposes would have been created BY the fix.
 */
function epipeSpawn(): { spawnFn: typeof Bun.spawn; stagedPath: () => string | null } {
  let staged: string | null = null;
  const enc = new TextEncoder();
  const spawnFn = ((args: string[]) => {
    const at = args.indexOf("--system-prompt-file");
    staged = at >= 0 ? (args[at + 1] as string) : null;
    return {
      stdin: {
        write() {
          throw new Error("EPIPE: the child already exited");
        },
        end() {},
      },
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode("\n"));
          c.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(1),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
  return { spawnFn, stagedPath: () => staged };
}

async function drain(extra: Partial<StreamChatOptions> & { spawnFn: typeof Bun.spawn }): Promise<void> {
  const seenEvents: StreamEvent[] = [];
  for await (const ev of streamChat({ transcript: "hi", systemPrompt: PROMPT, ...extra })) {
    seenEvents.push(ev);
  }
  expect(seenEvents.length).toBeGreaterThan(0);
}

describe("defect [26] — chat's system prompt travels in a file on Windows", () => {
  test("win32: argv carries the path, the file carries the prompt, nothing is left behind", async () => {
    const rec = recordingSpawn();
    await drain({ spawnFn: rec.spawnFn, platform: "win32" });

    const argv = rec.argv();
    const at = argv.indexOf("--system-prompt-file");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(argv).not.toContain("--system-prompt");
    // The prompt text must be nowhere in argv — that IS the defect.
    expect(argv).not.toContain(PROMPT);
    expect(rec.seenPromptFile()).toBe(PROMPT);
    // `teardown` ran: the staged file does not outlive the turn.
    expect(existsSync(argv[at + 1] as string)).toBe(false);
  });

  test("non-Windows is untouched: the prompt still rides in argv", async () => {
    const rec = recordingSpawn();
    await drain({ spawnFn: rec.spawnFn, platform: "darwin" });

    const argv = rec.argv();
    expect(argv).toContain("--system-prompt");
    expect(argv).toContain(PROMPT);
    expect(argv).not.toContain("--system-prompt-file");
  });

  test("no system prompt at all: neither form appears", async () => {
    const rec = recordingSpawn();
    const seen: StreamEvent[] = [];
    for await (const ev of streamChat({
      transcript: "hi",
      spawnFn: rec.spawnFn,
      platform: "win32",
    })) {
      seen.push(ev);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(rec.argv()).not.toContain("--system-prompt");
    expect(rec.argv()).not.toContain("--system-prompt-file");
  });
});

describe("defect [26] — chat stages the prompt file and always removes it", () => {
  test("a stdin-write throw still removes the staged file", async () => {
    // The realistic trigger for this path is a child that exits instantly
    // (EPIPE) — which is what an unrecognized `--system-prompt-file` produces.
    // The flag this change introduces is itself the way to reach it, so the
    // leak would have been created BY the fix.
    const { spawnFn, stagedPath } = epipeSpawn();
    const seen: StreamEvent[] = [];
    for await (const ev of streamChat({
      transcript: "hi",
      systemPrompt: PROMPT,
      spawnFn,
      platform: "win32",
    })) {
      seen.push(ev);
    }
    expect(seen.some((e) => e.type === "error")).toBe(true);
    expect(stagedPath()).not.toBeNull();
    expect(existsSync(stagedPath() as string)).toBe(false);
  });

  test("a spawn failure still removes the staged file", async () => {
    let stagedPath: string | null = null;
    const spawnFn = ((args: string[]) => {
      const at = args.indexOf("--system-prompt-file");
      stagedPath = at >= 0 ? (args[at + 1] as string) : null;
      throw new Error("Executable not found in $PATH");
    }) as unknown as typeof Bun.spawn;

    const seen: StreamEvent[] = [];
    for await (const ev of streamChat({
      transcript: "hi",
      systemPrompt: PROMPT,
      spawnFn,
      platform: "win32",
    })) {
      seen.push(ev);
    }
    expect(seen.some((e) => e.type === "error")).toBe(true);
    expect(stagedPath).not.toBeNull();
    expect(existsSync(stagedPath as unknown as string)).toBe(false);
  });
});
