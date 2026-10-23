// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Where one chat turn's reply comes from (defect `[49]`, spec §4).
 *
 * The route asks `resolveChatProvider` which agent this message goes to and
 * hands the answer here. Three outcomes, all returned as the same stream shape
 * so the route's reducer, persistence and ledger stay one code path:
 *
 *   claude            → `streamChat`, untouched (token-by-token)
 *   another agent     → `streamChatViaProvider` (the reply arrives whole)
 *   none / must choose → a stream of exactly one `error` event
 *
 * No resolution at all (a mount that does not wire one — the route tests that
 * inject `streamFactory`) means claude, which is what the route did before
 * `[49]`: those tests must not depend on what this machine has installed.
 */
import type { ChatProviderResolution } from "../../brain/chat-provider";
import { providerForFamily } from "../../brain/registry";
import { loadChatQuotaDailyCapSync } from "../../config/brain-quota-cap-config";
import { tryConsumeQuotaCall } from "../../state/brain-health";
import type { ChatRun } from "../../chat/run-store";
import { buildChatArgv } from "./chat-argv";
import { streamChatViaProvider } from "./chat-provider-stream";
import {
  type ChatProviderName,
  DEFAULT_CHAT_MODEL,
  type StreamChatOptions,
  type StreamEvent,
  streamChat,
} from "./chat-stream";

type ChatStream = AsyncGenerator<StreamEvent, void, void>;

interface ChatTurnSource {
  stream: ChatStream;
  /** The model this turn asked for. `""` = the agent's CLI picks its own. */
  model: string;
  /** Absent when no agent was decided (none found / the user must choose). */
  provider?: ChatProviderName;
  /** True when the reply will arrive in one piece (every agent but claude). */
  wholeReply: boolean;
  /**
   * The model to price this turn by. Absent for the quota-billed agents: their
   * spend is plan quota, and a dollar figure derived from a model name they
   * never ran would be invented.
   */
  ledgerModel?: string;
  /** How the agent was decided, for the chat call record. null = none was. */
  source: ChatRun["source"];
  /** How the agent bills; null = no agent was decided. */
  billing: "usd" | "quota" | null;
  /** The argv when no spawn reports one (claude's is built inside the call). */
  command: string[];
  /** Folder put in front of the child's PATH, if any — `--version` needs it too. */
  commandDir?: string;
}

/** The chat call record's taps (see chat-run-recorder.ts). */
interface ChatTurnTaps {
  onRawLine?: (line: string) => void;
  onSpawn?: (argv: string[]) => void;
  onExit?: (code: number | null) => void;
}

export interface OpenChatTurnArgs {
  homeBase: string;
  /** `undefined` = this mount did not wire a resolver → claude. */
  resolution: ChatProviderResolution | undefined;
  /** The model the request itself named (claude only). */
  bodyModel?: string;
  transcript: string;
  systemPrompt?: string;
  signal: AbortSignal;
  /** The project root claude runs in (src/chat/repo-access.ts). Claude only. */
  cwd?: string;
  /** Test seam for the claude path — replaces `streamChat`. */
  streamFactory?: (opts: StreamChatOptions) => ChatStream;
  taps?: ChatTurnTaps;
}

async function* oneError(ev: Extract<StreamEvent, { type: "error" }>): ChatStream {
  yield ev;
}

export function openChatTurn(args: OpenChatTurnArgs): ChatTurnSource {
  const res = args.resolution;
  const taps = args.taps ?? {};
  const undecided = { model: "", wholeReply: false, source: null, billing: null, command: [] };

  if (res?.kind === "none") {
    return {
      stream: oneError({ type: "error", reason: "no_provider", error: "no coding-agent command line was found" }),
      ...undecided,
    };
  }
  if (res?.kind === "choose") {
    return {
      stream: oneError({
        type: "error",
        reason: "choose_provider",
        error: "more than one coding agent was found and none is chosen for chat",
        found: res.found,
      }),
      ...undecided,
    };
  }

  if (res === undefined || res.family === "claude") {
    const model = args.bodyModel ?? res?.model;
    const claudeStream = args.streamFactory ?? streamChat;
    // claude chat takes from the chat daily cap like the other four (spec
    // §12.3); the others are counted inside streamChatViaProvider's guarded call.
    const allowed = tryConsumeQuotaCall(
      args.homeBase,
      "chat",
      new Date(),
      loadChatQuotaDailyCapSync(args.homeBase),
    );
    return {
      stream: !allowed
        ? oneError({
            type: "error",
            reason: "quota_cap",
            provider: "claude",
            error: "chat reached today's call cap",
          })
        : claudeStream({
        transcript: args.transcript,
        model,
        systemPrompt: args.systemPrompt,
        signal: args.signal,
        cwd: args.cwd,
        onRawLine: taps.onRawLine,
        onExit: taps.onExit,
      }),
      model: model ?? DEFAULT_CHAT_MODEL,
      provider: "claude",
      wholeReply: false,
      ledgerModel: model ?? DEFAULT_CHAT_MODEL,
      source: res?.source ?? "default",
      billing: "usd",
      // Without the system prompt: that travels in the record's prompt blocks.
      command: buildChatArgv(model ?? DEFAULT_CHAT_MODEL, undefined).args,
    };
  }

  return {
    stream: streamChatViaProvider({
      homeBase: args.homeBase,
      family: res.family,
      model: res.model,
      commandDir: res.commandDir,
      transcript: args.transcript,
      systemPrompt: args.systemPrompt,
      signal: args.signal,
      ...taps,
    }),
    model: res.model ?? "",
    provider: res.family,
    wholeReply: true,
    source: res.source,
    billing: providerForFamily(res.family).meta.billing,
    command: [],
    ...(res.commandDir !== undefined ? { commandDir: res.commandDir } : {}),
  };
}
