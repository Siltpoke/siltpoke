// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Chat Runs window — turn one chat call record into what the window shows
 * (spec 2026-10-13-agent-in-use-truth §10.1). Pure: no DOM, no fetch.
 * Reading the CLI's output into steps lives in `chat-runs-steps.ts`.
 */
import type { ChatRun } from "../../../chat/run-store";
import { type Draft, fmtInt, type RunStep, readOutput, type StepKind } from "./chat-runs-steps";

export type { RunStep, StepBody, StepKind } from "./chat-runs-steps";
export type { ChatRun };

export interface TraceRow {
  name: string;
  kind: StepKind;
  startMs: number;
  durMs: number;
  /** Digits only (spec: token numbers only), or "—". */
  tokens: string;
  slowest: boolean;
}

export interface RunView {
  runId: string;
  messageId: string;
  n: number;
  outcome: ChatRun["outcome"];
  time: string;
  agent: string;
  modelShort: string;
  pick: { tag: string; long: string; chosen: boolean } | null;
  modelNote: string | null;
  runtime: string;
  result: { message: string; stuck: string | null } | null;
  why: string;
  steps: RunStep[];
  trace: { totalMs: number; rows: TraceRow[] };
  wholePrompt: string;
  rawRecord: string;
  rawOutput: string;
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** `claude-haiku-5-5` → `haiku 5.5`; `claude-sonnet-4-5-20250929` → `sonnet 4.5`.
 * Names in any other shape are shown as they are. */
export function shortModel(model: string | null): string {
  if (model === null || model.length === 0) return "model not reported";
  const bare = model.replace(/^claude-/, "");
  const m = /^([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(bare);
  return m ? `${m[1]} ${m[2]}.${m[3]}` : bare;
}

const PICK: Record<NonNullable<ChatRun["source"]>, { tag: string; long: (a: string) => string; chosen: boolean }> = {
  chosen: { tag: "from settings", long: (a) => `You picked ${a} for chat on the Settings page.`, chosen: true },
  installed: {
    tag: "only one installed",
    long: (a) => `${a} is the only coding agent installed on this computer, so chat used it.`,
    chosen: false,
  },
  recent: {
    tag: "last used",
    long: (a) => `Nothing was picked for chat on the Settings page, so chat used the agent you used most recently: ${a}.`,
    chosen: false,
  },
  default: { tag: "default", long: (a) => `This chat always uses ${a}.`, chosen: false },
};

function hhmmss(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function sentStep(run: ChatRun): Draft {
  const total = run.prompt_blocks.reduce((s, b) => s + b.chars, 0);
  return {
    kind: "sent",
    label: "Sent",
    atMs: 0,
    tokens: null,
    body: { kind: "sent", totalChars: total, blocks: run.prompt_blocks, omitted: run.prompt_omitted },
    raw: [],
    endMs: 0,
  };
}

function failureText(run: ChatRun): string {
  return run.failure_message ?? `Failed (${run.failure_reason ?? "no reason recorded"}).`;
}

function stoppedStep(run: ChatRun): Draft | null {
  if (run.outcome === "ok") return null;
  const lines = run.outcome === "cancelled" ? ["You stopped this call."] : [failureText(run)];
  if (run.exit_code !== null) lines.push(`Exit code ${run.exit_code}.`);
  return { kind: "stopped", label: "Stopped", atMs: run.total_ms, endMs: run.total_ms, tokens: null, body: { kind: "lines", lines }, raw: [] };
}

/** False for a CLI that prints only at the end: its first step is the answer
 * or the finish (qoder), all it printed is plain text (agy), or it printed
 * nothing before it stopped. Then the wait was the work, not start-up. */
function streamsFromStart(drafts: Draft[]): boolean {
  const first = drafts[1];
  if (first === undefined || first.atMs <= 0) return false;
  if (first.kind === "answer" || first.kind === "finished" || first.kind === "stopped") return false;
  const printedOnly = drafts.slice(1).every((d) => d.kind === "printed" || d.kind === "stopped");
  return !printedOnly;
}

/** When each step's work began and how long it took.
 *
 * A CLI prints a line only once that piece is done, so a step's work runs from
 * where the call had got to (`cursor`: the latest end so far) to its own last
 * line — writing an answer is the answer's time, not the step printed before
 * it (review round 1). A tool call runs to its result; one that never came back
 * runs to the end of the call. Steps that ran ALONGSIDE an earlier one —
 * parallel tool calls, a tool inside a `Task` — keep their own span instead of
 * being squeezed to 0 after it (review round 2). Sent is the CLI starting up,
 * until its first line. */
function finishSteps(run: ChatRun, drafts: Draft[]): RunStep[] {
  const total = run.total_ms;
  const sentEnd = streamsFromStart(drafts) ? (drafts[1]?.atMs ?? 0) : 0;
  let cursor = 0;
  const steps: RunStep[] = drafts.map((d) => {
    let start: number;
    let end: number;
    if (d.kind === "sent") {
      [start, end] = [0, sentEnd];
    } else if (d.kind === "stopped") {
      [start, end] = [Math.min(cursor, total), total];
    } else if (d.body.kind === "tool") {
      // No result: if the call was cut short the tool was still running; in a
      // call that finished, the result line was just not matched (or cut at
      // 2 MB) — do not stretch it over every later step.
      const cutShort = run.outcome !== "ok";
      end = d.body.result !== null ? (d.body.resultAtMs ?? d.endMs) : cutShort ? total : d.endMs;
      // In sequence: from where the call had got to (deciding to call it is
      // part of it). Alongside an earlier step: from its own call line.
      start = cursor <= d.body.calledAtMs ? cursor : d.body.calledAtMs;
    } else {
      end = d.endMs;
      // Alongside a longer step: from its own first line, not its last.
      start = cursor <= end ? cursor : Math.min(d.atMs, end);
    }
    end = Math.max(end, start);
    cursor = Math.max(cursor, end);
    const { endMs: _end, ...rest } = d;
    return { ...rest, atMs: start, tookMs: end - start };
  });
  // Sent carries the input total (what went in), when the CLI reported it.
  if (run.tokens && steps[0]) {
    const t = run.tokens;
    steps[0].tokens = `${fmtInt(t.input + (t.cache_read ?? 0) + (t.cache_write ?? 0))} tokens in`;
  }
  return steps;
}

function traceOf(steps: RunStep[], totalMs: number): RunView["trace"] {
  const rows: TraceRow[] = steps
    .filter((s) => s.kind !== "stopped" && (s.tookMs ?? 0) > 0)
    .map((s) => ({
      name: s.body.kind === "tool" ? s.body.name : s.label,
      kind: s.kind,
      startMs: s.atMs,
      durMs: s.tookMs ?? 0,
      tokens: (s.tokens ?? "").match(/[\d,]+/)?.[0] ?? "—",
      slowest: false,
    }));
  // Spec §10.1: the slowest step is marked — no threshold. One step alone is
  // not "the slowest" of anything.
  const max = Math.max(0, ...rows.map((r) => r.durMs));
  for (const r of rows) r.slowest = rows.length > 1 && r.durMs === max;
  return { totalMs, rows };
}

function runtimeLine(run: ChatRun): string {
  if (run.outcome === "cancelled") return `${secs(run.total_ms)}, then you stopped it`;
  if (run.outcome === "failed") return `${secs(run.total_ms)}, then it failed`;
  if (run.first_token_ms !== null) return `${secs(run.total_ms)} (first words after ${secs(run.first_token_ms)})`;
  return `${secs(run.total_ms)} (${run.family ?? "the agent"} sends the whole reply at once)`;
}

/** The model line under the row head (spec §10.1:
 * "Settings chose X; qoder did not report the model it used"). */
function modelNote(run: ChatRun): string | null {
  const agent = run.family ?? "the agent";
  const req = run.model_requested;
  const rep = run.model_reported;
  if (req && rep && req !== rep && !rep.startsWith(req)) return `Asked for ${req}, ${agent} reported ${rep}.`;
  if (rep === null && run.outcome === "ok") {
    return req
      ? `Settings chose ${req}; ${agent} did not report which model it actually used.`
      : `No model was set, so ${agent} picked one; it did not report which.`;
  }
  return null;
}

function resultOf(run: ChatRun, steps: RunStep[]): RunView["result"] {
  if (run.outcome === "ok") return null;
  const message = run.outcome === "cancelled" ? "You stopped this call before it finished." : failureText(run);
  const open = [...steps].reverse().find((s) => s.body.kind === "tool" && s.body.result === null);
  const stuck =
    open?.body.kind === "tool"
      ? `Still running when it stopped: ${open.body.name} ${open.body.input}, started at ${secs(open.body.calledAtMs)}.`
      : null;
  return { message, stuck };
}

const capital = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

function whyOf(run: ChatRun, steps: RunStep[]): string {
  const names = run.prompt_blocks.map((b) => b.name);
  const sent = names.length > 0 ? `what Siltpoke sent (${names.join(", ")})` : "what Siltpoke sent";
  if (run.outcome !== "ok") return `No answer. It had ${sent}.`;
  const looked = steps.flatMap((s) => (s.body.kind === "tool" ? [`${s.body.name} ${s.body.input}`] : []));
  if (looked.length > 0) return `${capital(sent)}, and what it looked up itself: ${looked.join("; ")}.`;
  if (steps.some((s) => s.kind === "started")) return `Only ${sent}. It did not open any file or run any tool.`;
  return `${capital(sent)}. ${capital(run.family ?? "the agent")} does not say whether it also read files.`;
}

/** What the agent received, in the order it received it: the system prompt
 * (blocks joined as `composeChatPrompt` joins them), then the conversation. */
function wholePrompt(run: ChatRun): string {
  const conv = run.prompt_blocks.find((b) => b.name === "conversation");
  const recall = run.prompt_blocks.find((b) => b.name === "related past chats");
  const system =
    run.prompt_blocks
      .filter((b) => b !== conv && b !== recall)
      .map((b) => b.text)
      .join("\n\n") + (recall?.text ?? "");
  const parts: string[] = [];
  if (system.length > 0) parts.push(`--- system prompt ---\n${system}`);
  if (conv) parts.push(`--- message ---\n${conv.text}`);
  return parts.join("\n\n");
}

export function buildRunView(run: ChatRun, index: number): RunView {
  const drafts = [sentStep(run), ...readOutput(run)];
  if (run.output.length === 0 && run.outcome === "ok") {
    drafts.push({
      kind: "printed",
      label: "No output captured",
      atMs: 0,
      endMs: run.total_ms,
      tokens: null,
      body: { kind: "lines", lines: ["The answer arrived, but none of the CLI's own output was captured for this call."] },
      raw: [],
    });
  }
  const stop = stoppedStep(run);
  if (stop) drafts.push(stop);
  const steps = finishSteps(run, drafts);
  const pick = run.source && run.family ? PICK[run.source] : null;
  return {
    runId: run.run_id,
    messageId: run.message_id,
    n: index + 1,
    outcome: run.outcome,
    time: hhmmss(run.started_at),
    agent: run.family ?? "no agent",
    modelShort: shortModel(run.model_reported ?? run.model_requested),
    pick: pick && run.family ? { tag: pick.tag, long: pick.long(run.family), chosen: pick.chosen } : null,
    modelNote: modelNote(run),
    runtime: runtimeLine(run),
    result: resultOf(run, steps),
    why: whyOf(run, steps),
    steps,
    trace: traceOf(steps, run.total_ms),
    wholePrompt: wholePrompt(run),
    rawRecord: JSON.stringify(run),
    rawOutput:
      run.output.map((o) => o.line).join("\n") +
      (run.output_truncated ? "\n— output cut here: the record keeps at most 2 MB per call —" : ""),
  };
}
