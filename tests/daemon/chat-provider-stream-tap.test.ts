// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The chat call record's tap on an agent other than claude: every stdout line,
// the argv, the exit code — without changing what the provider itself reads.
// Real child processes (a fake CLI on disk), like chat-provider-stream.test.ts;
// its own file because that one is already past the length cap.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetQuotaWarnStateForTests } from "../../src/brain/brain-guarded";
import { streamChatViaProvider } from "../../src/daemon/routes/chat-provider-stream";
import type { StreamEvent } from "../../src/daemon/routes/chat-stream";

let home = "";
let bin = "";
let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.SILTPOKE_HOME;
  home = realpathSync(mkdtempSync(join(tmpdir(), "chat-tap-home-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "chat-tap-bin-")));
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

/** A CC-fork-shaped fake: the one result envelope those CLIs print (no
 * trailing newline) — or, in "fail", two stdout lines and exit 1. */
function fakeCli(name: string, mode: "answer" | "fail", reply = "same reply"): void {
  const path = join(bin, name);
  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      "await Bun.stdin.text();",
      `if (${JSON.stringify(mode)} === "fail") { process.stdout.write("starting\\nnot logged in\\n"); process.exit(1); }`,
      `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: ${JSON.stringify(reply)}, usage: { input_tokens: 7, output_tokens: 3 } }));`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

async function collect(gen: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const base = () => ({ homeBase: home, commandDir: bin, transcript: "[user] q", systemPrompt: "be brief" });

test("the provider gets the same reply with the tap on as with it off", async () => {
  fakeCli("codebuddy", "answer");
  const off = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
  const lines: string[] = [];
  const on = await collect(streamChatViaProvider({ ...base(), family: "codebuddy", onRawLine: (l) => lines.push(l) }));
  expect(on).toEqual(off);
  expect(on.map((e) => e.type)).toEqual(["message_start", "content_block_delta", "message_stop"]);
  // The envelope has no trailing newline and is still kept.
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("same reply");
});

test("argv and exit code are reported", async () => {
  fakeCli("qodercli", "answer");
  let argv: string[] = [];
  let code: number | null | undefined;
  await collect(
    streamChatViaProvider({
      ...base(),
      family: "qoder",
      onSpawn: (a) => {
        argv = a;
      },
      onExit: (c) => {
        code = c;
      },
    }),
  );
  for (let i = 0; i < 40 && code === undefined; i++) await Bun.sleep(25);
  expect(argv[0]).toContain("qodercli");
  expect(code).toBe(0);
});

test("a failing CLI still has its stdout lines and exit code recorded", async () => {
  fakeCli("codebuddy", "fail");
  const lines: string[] = [];
  let code: number | null | undefined;
  const evs = await collect(
    streamChatViaProvider({
      ...base(),
      family: "codebuddy",
      onRawLine: (l) => lines.push(l),
      onExit: (c) => {
        code = c;
      },
    }),
  );
  for (let i = 0; i < 40 && code === undefined; i++) await Bun.sleep(25);
  expect(evs.at(-1)?.type).toBe("error");
  expect(lines).toEqual(["starting", "not logged in"]);
  expect(code).toBe(1);
});
