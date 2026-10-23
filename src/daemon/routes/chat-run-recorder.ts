// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Turns one dashboard chat call into one stored record (spec
 * 2026-10-13-agent-in-use-truth §10.2). It rides beside the turn: it is handed
 * the CLI's raw lines, argv and exit code, watches the stream go by, and writes
 * the record once at the end. It never steers the turn, and a record that
 * cannot be written never fails it — the caller learns `recorded: false`.
 */
import { claudeOutputFacts } from "../../chat/claude-output-facts";
import type { PromptBlock } from "../../chat/prompt-blocks";
import { type ChatRun, type ChatRunStore, RUN_OUTPUT_CAP_BYTES } from "../../chat/run-store";
import { newId } from "../../memory/memory";
import type { ChatProviderName } from "./chat-stream";

interface ChatRunInit {
  store: ChatRunStore;
  sessionId: string;
  /** null = no agent was decided (none installed / the user must choose). */
  family: ChatProviderName | null;
  source: ChatRun["source"];
  modelRequested: string | null;
  billing: "usd" | "quota" | null;
  /** argv when nothing reports a spawn (claude's argv is built before the call). */
  command: string[];
  blocks: PromptBlock[];
  omitted: string[];
  /** `<command> --version`, asked for agents other than claude (claude reports it itself). */
  versionOf?: (command: string) => Promise<string | null>;
  logError?: (message: string) => void;
  /** Test seam: milliseconds clock. */
  now?: () => number;
}

interface RunEnd {
  messageId: string;
  outcome: ChatRun["outcome"];
  failureReason: string | null;
  failureMessage: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
}

interface ChatRunRecorder {
  onRawLine(line: string): void;
  onSpawn(argv: string[]): void;
  onExit(code: number | null): void;
  wrap<T extends { type: string }>(stream: AsyncIterable<T>): AsyncGenerator<T, void, void>;
  finish(end: RunEnd): Promise<{ runId: string; recorded: boolean }>;
}

const enc = new TextEncoder();

type ReportedPart = Pick<ChatRun, "model_reported" | "cli_version" | "permitted_tools" | "tokens" | "cost">;

/** The fields that depend on what the agent's CLI says about itself. */
async function reportedPart(
  init: ChatRunInit,
  end: RunEnd,
  output: ChatRun["output"],
  /** The `--version` asked when the agent started; null = never asked. */
  versionAsked: Promise<string | null> | null,
): Promise<ReportedPart> {
  const fromUsage = end.usage
    ? { input: end.usage.input_tokens, output: end.usage.output_tokens, cache_read: null, cache_write: null, thinking: null }
    : null;
  if (init.family === "claude") {
    const facts = claudeOutputFacts(output.map((o) => o.line));
    return {
      model_reported: facts.reportedModel,
      cli_version: facts.cliVersion,
      permitted_tools: facts.permittedTools,
      tokens: facts.tokens ?? fromUsage,
      cost: facts.costUsd === null ? null : { kind: "usd", usd: facts.costUsd },
    };
  }
  return {
    // Spec §7.1 [2]: these CLIs do not report the model they ran.
    model_reported: null,
    cli_version: versionAsked === null ? null : await versionAsked,
    permitted_tools: null,
    tokens: fromUsage,
    cost: init.billing === "quota" ? { kind: "quota" } : null,
  };
}

export function startChatRun(init: ChatRunInit): ChatRunRecorder {
  const now = init.now ?? Date.now;
  const t0 = now();
  const startedAt = new Date().toISOString();
  const runId = newId("r");
  const output: ChatRun["output"] = [];
  let bytes = 0;
  let truncated = false;
  let firstTokenMs: number | null = null;
  let spawned: string[] | null = null;
  let exitCode: number | null = null;
  let versionAsked: Promise<string | null> | null = null;
  let finished: Promise<{ runId: string; recorded: boolean }> | null = null;
  const since = (): number => Math.max(0, Math.round(now() - t0));

  const build = async (end: RunEnd): Promise<ChatRun> => {
    const command = spawned ?? init.command;
    const common = {
      v: 1 as const,
      run_id: runId,
      session_id: init.sessionId,
      message_id: end.messageId,
      started_at: startedAt,
      total_ms: since(),
      first_token_ms: init.family === "claude" ? firstTokenMs : null,
      family: init.family,
      source: init.source,
      model_requested: init.modelRequested,
      outcome: end.outcome,
      failure_reason: end.failureReason,
      failure_message: end.failureMessage === null ? null : end.failureMessage.slice(0, 300),
      command,
      exit_code: exitCode,
      prompt_blocks: init.blocks,
      prompt_omitted: init.omitted,
      output,
      output_truncated: truncated,
    };
    return { ...common, ...(await reportedPart(init, end, output, versionAsked)) };
  };

  return {
    onRawLine(line) {
      if (truncated) return;
      const size = enc.encode(line).length;
      if (bytes + size > RUN_OUTPUT_CAP_BYTES) {
        truncated = true;
        return;
      }
      bytes += size;
      output.push({ t_ms: since(), line });
    },
    onSpawn(argv) {
      spawned = [...argv];
      // Asked now, beside the answer, so writing the record does not wait for it.
      const bin = argv[0];
      if (versionAsked === null && init.family !== null && init.family !== "claude" && bin !== undefined && init.versionOf) {
        versionAsked = init.versionOf(bin);
      }
    },
    onExit(code) {
      exitCode = code;
    },
    async *wrap(stream) {
      for await (const ev of stream) {
        if (firstTokenMs === null && ev.type === "content_block_delta") firstTokenMs = since();
        yield ev;
      }
    },
    finish(end) {
      if (finished === null) {
        finished = (async () => {
          try {
            await init.store.append(await build(end));
            return { runId, recorded: true };
          } catch (err) {
            init.logError?.(`[chat-run] record not written: ${err instanceof Error ? err.message : String(err)}`);
            return { runId, recorded: false };
          }
        })();
      }
      return finished;
    },
  };
}
