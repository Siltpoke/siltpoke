// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * One dashboard chat turn answered by an agent other than claude (defect
 * `[49]`, spec an internal design note
 * §4–§5).
 *
 * Same shape as `streamChat`, so the route's reducer, persistence and ledger
 * are shared. The reply arrives whole: these CLIs are called the way review
 * calls them (`provider.callRaw` behind `makeGuardedCallRaw`), which is what
 * gives chat the restriction flags, `SILTPOKE_INTERNAL=1` and the daily cap
 * without a second copy of any argv. That wrapper neither retries nor records a
 * review failure, so a chat that fails cannot latch the review breaker.
 *
 * Three things the review path has no need for are added HERE, through the
 * `spawnFn` seam every provider already has — no provider file changes:
 *
 *  - Stop. Each child the provider starts is remembered; an abort kills them
 *    and the generator yields nothing further (the route owns the cancelled
 *    turn, exactly as with `streamChat`).
 *  - PATH. The autostarted daemon gets a short PATH; `commandDir` (recorded by
 *    a hook in the user's own session) is put in front of the CHILD's PATH for
 *    this one call. `process.env` is never touched.
 *  - A folder. `<home>/chat-cwd/`, empty and ours — nobody's code and no
 *    project instruction file for the agent to pick up. agy ignores it and
 *    runs in its own per-call empty folder (providers/agy-cwd.ts).
 */
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { BrainError } from "../../brain/brain";
import type { ProviderFamily } from "../../brain/brain-config";
import { makeGuardedCallRaw } from "../../brain/brain-guarded";
import { providerForFamily } from "../../brain/registry";
import type { StreamErrorReason, StreamEvent } from "./chat-stream";

const CHAT_CWD_DIRNAME = "chat-cwd";

/** Same cap as `streamChat`'s stderr tail — daemon log only. */
const DETAIL_CAP = 8 * 1024;

/** How long a stopped child gets to exit on the polite signal before it is
 * killed outright. A CLI with its own SIGTERM handler may never leave. */
const STOP_GRACE_MS = 2_000;

interface StreamChatViaProviderOptions {
  /** The siltpoke home — quota counter, config, and the chat folder live here. */
  homeBase: string;
  family: ProviderFamily;
  /** Absent = the agent's CLI picks its own model. */
  model?: string;
  /** Folder to put in front of the child's PATH (see `resolveChatProvider`). */
  commandDir?: string;
  transcript: string;
  systemPrompt?: string;
  signal?: AbortSignal;
  /**
   * Test seam only. Production passes nothing: each agent keeps the time limit
   * review gives it (90s; codex 120s), which lives in that agent's own file.
   */
  timeoutMs?: number;
  /** Each stdout line of each child, for the chat call record. The provider
   * reads its own copy of the stream; this one only forwards. */
  onRawLine?: (line: string) => void;
  /** The argv each child was started with. */
  onSpawn?: (argv: string[]) => void;
  /** Each child's exit code; null when a signal ended it. */
  onExit?: (code: number | null) => void;
}

/** Reads a byte stream to the end, handing each line to `sink`. Never throws. */
async function readLines(stream: ReadableStream<Uint8Array>, sink: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      for (let i = pending.indexOf("\n"); i >= 0; i = pending.indexOf("\n")) {
        sink(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
    }
  } catch {
    // the record keeps what arrived; the provider's own read reports the failure
  }
  if (pending.length > 0) sink(pending);
}

/** The record's taps on one child: stdout split in two (the provider reads one
 * branch, untouched), argv, exit code. */
function tapChild(
  proc: Bun.Subprocess,
  argv: string[],
  opts: Pick<StreamChatViaProviderOptions, "onRawLine" | "onSpawn" | "onExit">,
): void {
  opts.onSpawn?.(argv);
  if (opts.onRawLine !== undefined && proc.stdout instanceof ReadableStream) {
    const [forProvider, forRecord] = proc.stdout.tee();
    // An own property shadows the prototype getter; the provider reads this branch.
    Object.defineProperty(proc, "stdout", { value: forProvider, configurable: true });
    void readLines(forRecord, opts.onRawLine);
  }
  const onExit = opts.onExit;
  if (onExit !== undefined) {
    proc.exited.then(
      (code) => onExit(proc.signalCode ? null : code),
      () => onExit(null),
    );
  }
}

type SpawnOptions = { env?: Record<string, string | undefined> } & Record<string, unknown>;

/** The child's env with `commandDir` first on PATH. A name containing the PATH
 * separator cannot be expressed in PATH at all, so it is left out. */
function withCommandDir(
  env: Record<string, string | undefined>,
  commandDir: string | undefined,
): Record<string, string | undefined> {
  if (commandDir === undefined || commandDir.length === 0 || commandDir.includes(delimiter)) return env;
  const rest = env.PATH ?? "";
  return { ...env, PATH: rest.length > 0 ? `${commandDir}${delimiter}${rest}` : commandDir };
}

/** What a failed call's own output looked like — for the daemon log. */
function failureDetail(err: unknown): string {
  if (!(err instanceof BrainError)) return err instanceof Error ? err.message : String(err);
  const f = err.failure;
  return [err.message, f?.spawnError, f?.stderr, f?.stdout]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n")
    .slice(0, DETAIL_CAP);
}

/**
 * Why the call failed, from facts this module observed — never from the
 * agent's output text. `providerKilled` = the provider itself asked a child
 * that was still running to stop, which is what its time limit does. How the
 * child then ended says nothing: one with a shutdown handler exits with a code,
 * one that ignores the signal is killed outright by us. A provider also kills
 * on its way out of a throw of its own (agy's stdin guard); that error carries
 * no exit, so it is required here. A child that died with nobody asking — a
 * crash, the OS killing it for memory — is a failure, not a wait that ran out.
 */
function classifyFailure(err: unknown, providerKilled: boolean): StreamErrorReason {
  if (!(err instanceof BrainError)) return "provider_failed";
  if (err.code === "quota_cap") return "quota_cap";
  if (err.failure?.spawnError !== undefined) return "spawn_failed";
  return providerKilled && err.failure !== undefined ? "timeout" : "provider_failed";
}

/** Fixed wording per reason. The client renders its own sentence from
 * `reason` + `provider`; this string is the stored hint and the legacy text. */
const FAILURE_MESSAGE: Partial<Record<StreamErrorReason, (family: ProviderFamily) => string>> = {
  quota_cap: (f) => `chat reached today's call cap for ${f}`,
  spawn_failed: (f) => `could not start ${f}`,
  timeout: (f) => `${f} did not answer in time`,
  provider_failed: (f) => `${f} ran and failed`,
  empty_exit: (f) => `${f} returned no text`,
};

export async function* streamChatViaProvider(
  opts: StreamChatViaProviderOptions,
): AsyncGenerator<StreamEvent, void, void> {
  const { family, signal } = opts;

  const fail = (reason: StreamErrorReason, detail?: string): StreamEvent => ({
    type: "error",
    error: (FAILURE_MESSAGE[reason]?.(family) ?? `${family} chat failed`).slice(0, 300),
    reason,
    provider: family,
    ...(detail !== undefined && detail.length > 0 ? { stderr_tail: detail } : {}),
  });

  yield {
    type: "message_start",
    message_id: "",
    // "" = the agent's CLI picks its own model; a family name is not a model.
    model: opts.model ?? "",
    provider: family,
    whole_reply: true,
  };

  // Each child's own `kill`, kept apart from the one the provider is handed.
  const kills: Array<(how?: "SIGKILL") => void> = [];
  let aborted = false;
  let providerKilled = false;
  const killAll = (how?: "SIGKILL"): void => {
    for (const kill of kills) {
      try {
        kill(how);
      } catch {
        // already gone — the provider's own read of the exit still resolves
      }
    }
  };
  // unref: a pending hard-kill must not hold the daemon open at shutdown.
  const hardKillSoon = (): void => {
    setTimeout(() => killAll("SIGKILL"), STOP_GRACE_MS).unref();
  };
  // Resolves on Stop. The turn ends for the user THEN — the provider's call only
  // settles when the child closes its stdout, which a child that ignores the
  // signal (or left a grandchild holding the pipe) may not do for a long time.
  let markStopped: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    markStopped = () => resolve("stopped");
  });
  const onAbort = (): void => {
    aborted = true;
    killAll();
    hardKillSoon();
    markStopped();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  // The providers call `spawnFn(argv, options)`; nothing else is supported here.
  const spawnFn = ((argv: string[], options: SpawnOptions) => {
    // No provider today can get here after a Stop: each one spawns before its
    // first await. Kept for one that does not — a child started after the
    // abort would have nobody left to kill it.
    if (aborted) throw new Error("chat turn was stopped");
    const proc = Bun.spawn(argv, {
      ...options,
      env: withCommandDir(options.env ?? process.env, opts.commandDir),
    } as Parameters<typeof Bun.spawn>[1]);
    tapChild(proc, argv, opts);
    const kill = proc.kill.bind(proc);
    kills.push(kill);
    // The provider's time limit sends the polite signal once and then waits for
    // the child's output to close. A child that ignores it would keep the turn
    // open for good, so the same grace-then-kill as Stop follows it.
    proc.kill = (...args: Parameters<typeof proc.kill>): void => {
      providerKilled = true;
      hardKillSoon();
      kill(...args);
    };
    return proc;
  }) as unknown as typeof Bun.spawn;

  let text: string;
  let usage: { input_tokens: number; output_tokens: number };
  try {
    // Stopped before we began, or while the start event above was being
    // delivered: no listener was attached then, so none will fire. Start
    // nothing — this is the one check both cases go through.
    if (signal?.aborted) return;
    const cwd = join(opts.homeBase, CHAT_CWD_DIRNAME);
    mkdirSync(cwd, { recursive: true });
    const call = makeGuardedCallRaw({
      homeBase: opts.homeBase,
      provider: providerForFamily(family),
      usedBy: "chat",
    });
    const pending = call({
      systemPrompt: opts.systemPrompt ?? "",
      contextBundle: opts.transcript,
      cwd,
      spawnFn,
      // Prose for a person — codex and agy otherwise ask for a review verdict.
      plainReply: true,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    // A call abandoned on Stop still settles later, usually by rejecting.
    pending.catch(() => {});
    const result = await Promise.race([pending, stopped]);
    if (result === "stopped") return;
    text = result.text;
    usage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens };
  } catch (err) {
    // A Stop normally leaves through the race above. This covers the few
    // microtasks where the call failed on its own and Stop landed before we
    // resumed: a stopped turn still gets no error event.
    if (aborted) return;
    yield fail(classifyFailure(err, providerKilled), failureDetail(err));
    return;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // A child that outlived a throw (stdin write failed, parse threw before the
    // exit was read) must not linger; killing an exited one is a no-op.
    if (!aborted) killAll();
  }

  if (aborted) return;
  if (text.trim().length === 0) {
    yield fail("empty_exit");
    return;
  }
  yield { type: "content_block_delta", text };
  yield { type: "message_stop", usage, full_text: text };
}
