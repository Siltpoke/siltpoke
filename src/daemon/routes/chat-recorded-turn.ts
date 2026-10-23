// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * One chat turn with its call record attached (spec 2026-10-13 §5 step 1).
 *
 * The recorder needs to know which agent answers, which only `openChatTurn`
 * decides; the turn needs the recorder's taps. Both streams are lazy — nothing
 * runs until the route reads — so the taps forward to a recorder that is
 * always set by the time the first line arrives.
 */
import type { PromptBlock } from "../../chat/prompt-blocks";
import type { ChatRunStore } from "../../chat/run-store";
import { startChatRun } from "./chat-run-recorder";
import { type OpenChatTurnArgs, openChatTurn } from "./chat-turn-source";

type Recorder = ReturnType<typeof startChatRun>;

/** `<command> --version` for an agent whose command sits in `commandDir`. */
export type CliVersionLookup = (commandDir: string | undefined) => (command: string) => Promise<string | null>;

interface RecordArgs {
  store: ChatRunStore;
  sessionId: string;
  blocks: PromptBlock[];
  omitted: string[];
  /** Absent: the record's `cli_version` stays null for agents other than claude. */
  cliVersionLookup?: CliVersionLookup;
  logError: (message: string) => void;
}

export function openRecordedChatTurn(
  turnArgs: Omit<OpenChatTurnArgs, "taps">,
  record: RecordArgs,
): { turn: ReturnType<typeof openChatTurn>; rec: Recorder } {
  let rec: Recorder | null = null;
  const turn = openChatTurn({
    ...turnArgs,
    taps: {
      onRawLine: (line) => rec?.onRawLine(line),
      onSpawn: (argv) => rec?.onSpawn(argv),
      onExit: (code) => rec?.onExit(code),
    },
  });
  const started = startChatRun({
    store: record.store,
    sessionId: record.sessionId,
    family: turn.provider ?? null,
    source: turn.source,
    modelRequested: turn.model.length > 0 ? turn.model : null,
    billing: turn.billing,
    command: turn.command,
    blocks: record.blocks,
    omitted: record.omitted,
    ...(record.cliVersionLookup ? { versionOf: record.cliVersionLookup(turn.commandDir) } : {}),
    logError: record.logError,
  });
  rec = started;
  return { turn: { ...turn, stream: started.wrap(turn.stream) }, rec: started };
}
