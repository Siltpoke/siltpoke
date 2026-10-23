// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [49] step 3 — dashboard chat calls an agent other than claude.
//
// Every test runs a REAL child process: a fake `codebuddy` / `qodercli` /
// `claude` script on disk that writes down what it was started with (argv, cwd,
// env, pid) and then answers, hangs or fails. A stubbed spawn would prove the
// generator calls a function; these prove a command line was launched, with
// which flags, in which folder — and that Stop leaves no process behind.
//
// `process.env.PATH` is cut down to `/usr/bin:/bin` for the whole file, so the
// only way a fake command is found is the `commandDir` the generator is given.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetQuotaWarnStateForTests } from "../../src/brain/brain-guarded";
import { codexSandboxArgs } from "../../src/brain/providers/codex-sandbox";
import { streamChatViaProvider } from "../../src/daemon/routes/chat-provider-stream";
import type { StreamEvent } from "../../src/daemon/routes/chat-stream";
import { readBrainHealth, writeBrainHealth } from "../../src/state/brain-health";

type Mode = "answer" | "hang" | "stubborn" | "polite" | "fail" | "crash" | "empty";

interface Launch {
  bin: string;
  pid: number;
  argv: string[];
  cwd: string;
  internal: string | null;
  stdin?: string;
}

let home = "";
let bin = "";
let log = "";
let savedPath: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  // The qoder / agy providers tidy up their own old sessions after every call,
  // from a registry under the siltpoke home. Point that at the temp home so a
  // test never reads or prunes anything in the real one.
  savedHome = process.env.SILTPOKE_HOME;
  // realpath: macOS tmpdir is a symlink (/var → /private/var) and the child
  // reports its cwd resolved.
  home = realpathSync(mkdtempSync(join(tmpdir(), "chat-provider-home-")));
  bin = realpathSync(mkdtempSync(join(tmpdir(), "chat-provider-bin-")));
  log = join(home, "launches.jsonl");
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

/** A fake agent CLI. Records its launch FIRST (so a hanging one is still on
 * record), then drains stdin, then behaves per `mode`. */
function fakeCli(name: string, mode: Mode, reply = "hello from the other agent"): void {
  const path = join(bin, name);
  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      'import { appendFileSync } from "node:fs";',
      `const mode = ${JSON.stringify(mode)};`,
      // "stubborn" ignores the polite signal, like a CLI with its own handler.
      // Installed BEFORE the first record is written, so a test that has seen
      // a record knows the handler is already in place.
      'if (mode === "stubborn") process.on("SIGTERM", () => {});',
      // "polite" shuts itself down on the signal and reports an exit CODE, the
      // way a CLI with a shutdown handler (or a shim relaying its child) does —
      // so the parent sees no signal at all.
      'if (mode === "polite") process.on("SIGTERM", () => process.exit(143));',
      `const LOG = ${JSON.stringify(log)};`,
      `const base = { bin: ${JSON.stringify(name)}, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), internal: process.env.SILTPOKE_INTERNAL ?? null };`,
      'appendFileSync(LOG, JSON.stringify(base) + "\\n");',
      "const stdin = await Bun.stdin.text();",
      'appendFileSync(LOG, JSON.stringify({ ...base, stdin }) + "\\n");',
      'if (mode === "hang" || mode === "stubborn" || mode === "polite") { setInterval(() => {}, 1000); await new Promise(() => {}); }',
      'if (mode === "fail") { process.stderr.write("Please run /login\\n"); process.exit(1); }',
      'if (mode === "crash") { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); }',
      `const result = mode === "empty" ? "" : ${JSON.stringify(reply)};`,
      // Each family's real reply format: codex = JSONL events, agy = the bare
      // text, the two CC forks = one result envelope.
      `const bin = ${JSON.stringify(name)};`,
      'if (bin === "codex") {',
      '  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: result } }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }) + "\\n");',
      '} else if (bin === "agy") {',
      "  process.stdout.write(result);",
      "} else {",
      '  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, usage: { input_tokens: 7, output_tokens: 3 } }));',
      "}",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function launches(): Launch[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Launch);
}

/** One row per process: the later (stdin-carrying) record wins. */
function launchesByPid(): Launch[] {
  const byPid = new Map<number, Launch>();
  for (const l of launches()) byPid.set(l.pid, { ...byPid.get(l.pid), ...l });
  return [...byPid.values()];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

async function collect(gen: AsyncGenerator<StreamEvent, void, void>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const base = () => ({ homeBase: home, commandDir: bin, transcript: "[user] hi", systemPrompt: "be brief" });

// The injected time limit for the timer tests. Long enough for the fake to
// start and write its first record with the whole suite running beside it: at
// 400ms the child was once killed before it had written anything, so there was
// no pid to check — and a fake killed before it installs its signal handler is
// not the case its test is about.
const TIMER_MS = 2000;

describe("streamChatViaProvider — a reply from another agent", () => {
  test("yields start (naming the agent, whole-reply) → ONE delta → stop with usage", async () => {
    fakeCli("codebuddy", "answer", "the whole answer");
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    expect(evs.map((e) => e.type)).toEqual(["message_start", "content_block_delta", "message_stop"]);
    expect(evs[0]).toMatchObject({ type: "message_start", provider: "codebuddy", whole_reply: true });
    expect(evs[1]).toEqual({ type: "content_block_delta", text: "the whole answer" });
    expect(evs[2]).toEqual({
      type: "message_stop",
      usage: { input_tokens: 7, output_tokens: 3 },
      full_text: "the whole answer",
    });
  });

  test("starts that agent's command and never claude", async () => {
    fakeCli("qodercli", "answer");
    fakeCli("claude", "answer");
    await collect(streamChatViaProvider({ ...base(), family: "qoder" }));
    const ran = launchesByPid();
    expect(ran.map((l) => l.bin)).toEqual(["qodercli"]);
  });

  test("the child gets the restriction flags, SILTPOKE_INTERNAL, the model, and the transcript on stdin", async () => {
    fakeCli("codebuddy", "answer");
    await collect(streamChatViaProvider({ ...base(), family: "codebuddy", model: "some-model" }));
    const [l] = launchesByPid();
    expect(l).toBeDefined();
    const argv = (l as Launch).argv;
    // `--tools ""` — the flag immediately followed by an empty string (AC10).
    const toolsAt = argv.indexOf("--tools");
    expect(toolsAt).toBeGreaterThanOrEqual(0);
    expect(argv[toolsAt + 1]).toBe("");
    expect(argv[argv.indexOf("--model") + 1]).toBe("some-model");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("be brief");
    expect((l as Launch).internal).toBe("1");
    expect((l as Launch).stdin).toBe("[user] hi");
    // The command folder went on the CHILD's PATH only.
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  test("qoder: the same restriction flag and the chat folder", async () => {
    fakeCli("qodercli", "answer");
    await collect(streamChatViaProvider({ ...base(), family: "qoder" }));
    const [l] = launchesByPid();
    expect(l).toBeDefined();
    const argv = (l as Launch).argv;
    const toolsAt = argv.indexOf("--tools");
    expect(toolsAt).toBeGreaterThanOrEqual(0);
    expect(argv[toolsAt + 1]).toBe("");
    expect((l as Launch).cwd).toBe(join(home, "chat-cwd"));
    expect((l as Launch).internal).toBe("1");
  });

  test("runs in <home>/chat-cwd, creating it — not in this process's folder", async () => {
    fakeCli("codebuddy", "answer");
    const cwd = join(home, "chat-cwd");
    expect(existsSync(cwd)).toBe(false);
    await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    const [l] = launchesByPid();
    expect((l as Launch).cwd).toBe(cwd);
    expect((l as Launch).cwd).not.toBe(process.cwd());
  });

  // codex and agy build a REVIEW request by default: codex is handed the review
  // verdict's JSON schema, agy a prompt headed "review rubric". A chat sent that
  // way comes back as a verdict, not an answer.
  test("codex: read-only sandbox, the chat folder, and NO review schema — the reply is the text", async () => {
    fakeCli("codex", "answer", "plain words from codex");
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codex" }));
    expect(evs[1]).toEqual({ type: "content_block_delta", text: "plain words from codex" });
    expect(evs.at(-1)).toMatchObject({ type: "message_stop", usage: { input_tokens: 7, output_tokens: 3 } });
    const [l] = launchesByPid();
    const argv = (l as Launch).argv;
    expect(argv[argv.indexOf("-C") + 1]).toBe(join(home, "chat-cwd"));
    // read-only, and on macOS readable only inside the chat folder
    expect(argv.slice(argv.indexOf("--skip-git-repo-check") + 1, argv.indexOf("-C"))).toEqual(
      codexSandboxArgs(join(home, "chat-cwd")),
    );
    expect(argv).not.toContain("--output-schema");
    expect((l as Launch).internal).toBe("1");
    expect((l as Launch).stdin).toBe("[user] hi");
  });

  test("agy: sandboxed, in its own per-call empty folder (not the chat folder), and the prompt is not framed as a review", async () => {
    fakeCli("agy", "answer", "plain words from agy");
    const evs = await collect(streamChatViaProvider({ ...base(), family: "agy", model: "some-model" }));
    expect(evs[1]).toEqual({ type: "content_block_delta", text: "plain words from agy" });
    const [l] = launchesByPid();
    const argv = (l as Launch).argv;
    expect(argv).toContain("--sandbox");
    expect(argv[argv.indexOf("--model") + 1]).toBe("some-model");
    // agy ignores the cwd it is handed: providers/agy-cwd.ts makes a fresh empty dir per call.
    expect((l as Launch).cwd).not.toBe(join(home, "chat-cwd"));
    expect((l as Launch).cwd.startsWith(join(realpathSync(tmpdir()), "siltpoke-agy-cwd-"))).toBe(true);
    expect(existsSync((l as Launch).cwd)).toBe(false);
    expect((l as Launch).internal).toBe("1");
    const prompt = argv[argv.indexOf("-p") + 1] ?? "";
    expect(prompt).toContain("be brief");
    expect(prompt).toContain("[user] hi");
    expect(prompt).not.toMatch(/review|rubric|diff/i);
  });

  test("without commandDir the command is looked up on PATH as it stands (control for the tests above)", async () => {
    fakeCli("codebuddy", "answer");
    const evs = await collect(streamChatViaProvider({ ...base(), commandDir: undefined, family: "codebuddy" }));
    expect(evs.at(-1)).toMatchObject({ type: "error", reason: "spawn_failed", provider: "codebuddy" });
    expect(launches()).toEqual([]);
  });

  test("a commandDir with the PATH separator in its name is not added", async () => {
    // Put on PATH as it stands, `<home>/a:b` would be read as TWO entries, the
    // first being `<home>/a` — a folder nobody recorded. A command sitting
    // there must not be what answers.
    const split = join(home, "a");
    mkdirSync(split);
    mkdirSync(join(home, "a:b"));
    fakeCli("codebuddy", "answer");
    const impostor = join(split, "codebuddy");
    writeFileSync(impostor, readFileSync(join(bin, "codebuddy"), "utf8"));
    chmodSync(impostor, 0o755);
    const evs = await collect(streamChatViaProvider({ ...base(), commandDir: join(home, "a:b"), family: "codebuddy" }));
    expect(evs.at(-1)).toMatchObject({ type: "error", reason: "spawn_failed" });
    expect(launches()).toEqual([]);
  });
});

describe("streamChatViaProvider — Stop", () => {
  test("abort kills the child, and the generator yields nothing after it", async () => {
    fakeCli("codebuddy", "hang");
    const ac = new AbortController();
    const evs: StreamEvent[] = [];
    const done = (async () => {
      for await (const ev of streamChatViaProvider({ ...base(), family: "codebuddy", signal: ac.signal })) evs.push(ev);
    })();
    expect(await waitFor(() => launches().length > 0)).toBe(true);
    const pid = (launches()[0] as Launch).pid;
    expect(alive(pid)).toBe(true);
    const before = evs.length;
    ac.abort();
    await done;
    expect(await waitFor(() => !alive(pid))).toBe(true);
    // Nothing after the abort: no error card, no stop — the route owns the
    // cancelled-turn record.
    expect(evs.slice(before)).toEqual([]);
    expect(evs.some((e) => e.type === "error" || e.type === "message_stop")).toBe(false);
  });

  test("a child that ignores the polite signal: Stop still returns at once, and the child is killed outright", async () => {
    fakeCli("codebuddy", "stubborn");
    const ac = new AbortController();
    const evs: StreamEvent[] = [];
    const done = (async () => {
      for await (const ev of streamChatViaProvider({ ...base(), family: "codebuddy", signal: ac.signal })) evs.push(ev);
    })();
    // The fake installs its handler before it writes its first record.
    expect(await waitFor(() => launches().length >= 1)).toBe(true);
    const pid = (launches()[0] as Launch).pid;
    ac.abort();
    const returned = await Promise.race([done.then(() => true), Bun.sleep(1000).then(() => false)]);
    // The turn ends for the user now — not when the child finally lets go.
    expect(returned).toBe(true);
    expect(evs.some((e) => e.type === "error" || e.type === "message_stop")).toBe(false);
    expect(await waitFor(() => !alive(pid), 6000)).toBe(true);
  }, 15000);

  test("Stop that lands while the start event is being delivered starts no process", async () => {
    fakeCli("codebuddy", "answer");
    const ac = new AbortController();
    const gen = streamChatViaProvider({ ...base(), family: "codebuddy", signal: ac.signal });
    const first = await gen.next();
    expect((first.value as StreamEvent).type).toBe("message_start");
    // The generator is parked at its first yield — nothing is listening yet.
    ac.abort();
    const rest: StreamEvent[] = [];
    for await (const ev of gen) rest.push(ev);
    expect(rest).toEqual([]);
    await Bun.sleep(150);
    expect(launches()).toEqual([]);
    // And it cost nothing: no daily counter was touched, chat's or review's.
    expect(readBrainHealth(home).quota_calls_today).toEqual({});
  });

  test("a signal that is already aborted starts no process at all", async () => {
    fakeCli("codebuddy", "answer");
    const ac = new AbortController();
    ac.abort();
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy", signal: ac.signal }));
    expect(evs.some((e) => e.type === "error" || e.type === "message_stop" || e.type === "content_block_delta")).toBe(false);
    await Bun.sleep(150);
    expect(launches()).toEqual([]);
  });
});

describe("streamChatViaProvider — failures name the agent and never quote it", () => {
  test("command not found → spawn_failed", async () => {
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    expect(evs.at(-1)).toMatchObject({ type: "error", reason: "spawn_failed", provider: "codebuddy" });
  });

  test("the command fails → provider_failed; started once, no other agent tried, its output stays out of the message", async () => {
    fakeCli("codebuddy", "fail");
    fakeCli("claude", "answer");
    fakeCli("qodercli", "answer");
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    const last = evs.at(-1) as Extract<StreamEvent, { type: "error" }>;
    expect(last).toMatchObject({ type: "error", reason: "provider_failed", provider: "codebuddy" });
    expect(last.error).not.toContain("/login");
    // The CLI's own words reach the daemon log channel only.
    expect(last.stderr_tail).toContain("Please run /login");
    expect(launchesByPid().map((l) => l.bin)).toEqual(["codebuddy"]);
  });

  test("the agent's own timer fires → timeout, and the child is gone", async () => {
    fakeCli("codebuddy", "hang");
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy", timeoutMs: TIMER_MS }));
    expect(evs.at(-1)).toMatchObject({ type: "error", reason: "timeout", provider: "codebuddy" });
    expect(launches().length).toBeGreaterThan(0);
    const pid = (launches()[0] as Launch).pid;
    expect(await waitFor(() => !alive(pid))).toBe(true);
  });

  test("the timer fires on a child that exits with a CODE on the signal → still timeout, not 'is it logged in?'", async () => {
    fakeCli("codebuddy", "polite");
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy", timeoutMs: TIMER_MS }));
    expect(evs.at(-1)).toMatchObject({ type: "error", reason: "timeout", provider: "codebuddy" });
    // The fake installs its handler before its first record: a record means
    // the signal met the handler, not a process still starting.
    expect(launches().length).toBeGreaterThan(0);
  });

  test("the timer fires on a child that ignores the signal → the turn still ends as timeout, and the child is killed outright", async () => {
    fakeCli("codebuddy", "stubborn");
    const done = collect(streamChatViaProvider({ ...base(), family: "codebuddy", timeoutMs: TIMER_MS }));
    const evs = await Promise.race([done, Bun.sleep(8000).then(() => null)]);
    // null = the turn never ended: nobody escalated past the ignored signal.
    expect(evs).not.toBeNull();
    expect((evs as StreamEvent[]).at(-1)).toMatchObject({ type: "error", reason: "timeout", provider: "codebuddy" });
    expect(launches().length).toBeGreaterThan(0);
    const pid = (launches()[0] as Launch).pid;
    expect(await waitFor(() => !alive(pid))).toBe(true);
  }, 15000);

  test("a child that dies by any other signal (a crash) is a failure, not a timeout", async () => {
    fakeCli("codebuddy", "crash");
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    expect(evs.at(-1)).toMatchObject({ type: "error", reason: "provider_failed", provider: "codebuddy" });
  });

  test("a reply with no text → empty_exit", async () => {
    fakeCli("codebuddy", "empty");
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    expect(evs.at(-1)).toMatchObject({ type: "error", reason: "empty_exit", provider: "codebuddy" });
    expect(evs.some((e) => e.type === "content_block_delta")).toBe(false);
  });

  test("chat's daily cap is reached → quota_cap, and nothing is started", async () => {
    fakeCli("codebuddy", "answer");
    writeFileSync(join(home, "config.json"), JSON.stringify({ brain: { chat_quota_daily_cap: 1 } }));
    const first = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    expect(first.at(-1)?.type).toBe("message_stop");
    const second = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    expect(second.at(-1)).toMatchObject({ type: "error", reason: "quota_cap", provider: "codebuddy" });
    expect(launchesByPid().length).toBe(1);
  });

  test("review's daily cap does not stop chat, and chat does not move review's count", async () => {
    fakeCli("codebuddy", "answer");
    writeFileSync(join(home, "config.json"), JSON.stringify({ brain: { quota_daily_cap: 1 } }));
    for (let i = 0; i < 2; i++) {
      const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
      expect(evs.at(-1)?.type).toBe("message_stop");
    }
    expect(launchesByPid().length).toBe(2);
    const calls = readBrainHealth(home).quota_calls_today;
    expect(calls.chat?.count).toBe(2);
    expect(calls.review).toBeUndefined();
  });

  test("a failed chat call does not count as a failed review", async () => {
    fakeCli("codebuddy", "fail");
    writeBrainHealth(home, readBrainHealth(home));
    // Everything review's health record holds, minus the daily call counter
    // (which a chat call does move — that is the cap, not a failure).
    const reviewState = (): string => {
      const { quota_calls_today: _calls, ...rest } = readBrainHealth(home);
      return JSON.stringify(rest);
    };
    const before = reviewState();
    const evs = await collect(streamChatViaProvider({ ...base(), family: "codebuddy" }));
    // Not vacuous: the call did fail, and the counter shows it was made.
    expect(evs.at(-1)).toMatchObject({ type: "error", reason: "provider_failed" });
    expect(readBrainHealth(home).quota_calls_today.chat?.count).toBe(1);
    expect(reviewState()).toBe(before);
  });
});
