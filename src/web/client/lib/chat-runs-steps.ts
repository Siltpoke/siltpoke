// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Chat Runs window — read a call's stdout lines into steps (spec
 * 2026-10-13-agent-in-use-truth §10.1 "What happened"). Pure.
 *
 * The CLI's output is kept whole in the record; here every line becomes part
 * of exactly one step, so nothing printed is dropped from the view — a line
 * this file does not recognise becomes a "Printed" step with its raw text.
 */
import { CODEX_NON_TOOL_ITEMS } from "../../../brain/tool-calls";
import type { ChatRun } from "../../../chat/run-store";

export type StepKind =
  | "sent"
  | "hooks"
  | "started"
  | "thought"
  | "tool"
  | "answer"
  | "limit"
  | "finished"
  | "printed"
  | "stopped";

export type StepBody =
  | { kind: "sent"; totalChars: number; blocks: Array<{ name: string; chars: number; text: string }>; omitted: string[] }
  | { kind: "lines"; lines: string[] }
  | { kind: "quote"; text: string | null; note: string | null }
  | { kind: "tool"; name: string; input: string; calledAtMs: number; result: string | null; resultAtMs: number | null }
  | { kind: "answer"; text: string }
  | { kind: "text"; text: string };

export interface RunStep {
  kind: StepKind;
  /** Plain-words title: Sent / Hooks / Started / Thought / Used a tool / … */
  label: string;
  atMs: number;
  /** Time until the next step started (the last step runs to the call's end). */
  tookMs: number | null;
  /** Token count in words (`1,491 tokens out`), or null when the line carries none. */
  tokens: string | null;
  body: StepBody;
  /** The exact stdout lines this step was read from (empty for Sent / Stopped). */
  raw: string[];
}

/** A step as read from the output. `endMs` = when its last line was printed
 * (for a tool: when its result came back) — the end of the work it shows. */
export type Draft = Omit<RunStep, "tookMs"> & { endMs: number };

export const fmtInt = (n: number): string => n.toLocaleString("en-US");
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

type Json = Record<string, unknown>;

function parse(line: string): Json | null {
  try {
    const v: unknown = JSON.parse(line);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

const obj = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One tool call's input in a single readable line. */
function toolInput(name: string, input: Json): string {
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  if (name === "Read" && path) {
    const off = num(input.offset);
    const lim = num(input.limit);
    return off !== null && lim !== null ? `${path}, lines ${off}–${off + lim}` : path;
  }
  if ((name === "Grep" || name === "Glob") && str(input.pattern)) {
    return `“${str(input.pattern)}” in ${path ?? "the current folder"}`;
  }
  if (name === "Bash" && str(input.command)) return str(input.command) ?? "";
  if (path) return path;
  const s = JSON.stringify(input);
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => str(obj(c).text) ?? JSON.stringify(c)).join("\n");
  return JSON.stringify(content ?? null);
}

const step = (kind: StepKind, label: string, atMs: number, body: StepBody, raw: string[], tokens: string | null = null): Draft => ({
  kind,
  label,
  atMs,
  endMs: atMs,
  tokens,
  body,
  raw,
});

const printed = (atMs: number, line: string): Draft => step("printed", "Printed", atMs, { kind: "text", text: line }, [line]);

/** Mutable state while reading one call's lines. */
class Reader {
  readonly out: Draft[] = [];
  private readonly pendingTools = new Map<string, Draft>();
  /** A Thought opened by `thinking_tokens` counts, waiting for its words. */
  private thinking: Draft | null = null;

  private last(): Draft | undefined {
    return this.out[this.out.length - 1];
  }

  plain(t: number, line: string): void {
    const prev = this.last();
    if (prev?.kind === "printed" && prev.body.kind === "text") {
      prev.body = { kind: "text", text: `${prev.body.text}\n${line}` };
      prev.raw.push(line);
      prev.endMs = t;
    } else {
      this.out.push(printed(t, line));
    }
  }

  hook(t: number, line: string, j: Json): void {
    const name = str(j.hook_name) ?? "hook";
    const output = str(j.output) ?? "";
    const desc =
      str(j.subtype) === "hook_started"
        ? `${name} started`
        : `${name} finished${output.length > 0 ? `, printed ${fmtInt(output.length)} chars` : ""}${str(j.stderr) ? " (with an error message)" : ""}`;
    const prev = this.last();
    if (prev?.kind === "hooks" && prev.body.kind === "lines") {
      prev.body.lines.push(desc);
      prev.raw.push(line);
      prev.endMs = t;
    } else {
      this.out.push(step("hooks", "Hooks", t, { kind: "lines", lines: [desc] }, [line]));
    }
  }

  init(t: number, line: string, j: Json): void {
    const tools = arr(j.tools).filter((x): x is string => typeof x === "string");
    const lines = [`Model: ${str(j.model) ?? "not reported"}`];
    if (str(j.cwd)) lines.push(`Working folder: ${str(j.cwd)}`);
    lines.push(
      tools.length > 0
        ? `Allowed to use ${tools.length} tools: ${tools.join(", ")} (what it actually used is below)`
        : "Allowed tools: not reported",
    );
    this.out.push(step("started", "Started", t, { kind: "lines", lines }, [line]));
  }

  thinkingCount(t: number, line: string, j: Json): void {
    if (this.thinking === null) {
      this.thinking = step("thought", "Thought", t, { kind: "quote", text: null, note: null }, []);
      this.out.push(this.thinking);
    }
    this.thinking.raw.push(line);
    this.thinking.endMs = t;
    const est = num(j.estimated_tokens);
    if (est !== null) this.thinking.tokens = `~${fmtInt(est)} thinking tokens`;
  }

  assistant(t: number, line: string, j: Json): void {
    const msg = obj(j.message);
    const outTok = num(obj(msg.usage).output_tokens);
    // The line's raw text goes on the first step it produced.
    let raw: string[] = [line];
    let placed = false;
    for (const block of arr(msg.content)) {
      const c = obj(block);
      const ct = str(c.type);
      if (ct === "thinking" || ct === "redacted_thinking") {
        const text = str(c.thinking) ?? "";
        const s = this.thinking ?? step("thought", "Thought", t, { kind: "quote", text: null, note: null }, []);
        if (this.thinking === null) this.out.push(s);
        s.body = {
          kind: "quote",
          text: text.length > 0 ? text : null,
          note: text.length > 0 ? null : "The CLI did not include the words of this thought, only that it thought.",
        };
        s.raw.push(...raw);
        s.endMs = t;
      } else if (ct === "text") {
        this.out.push(
          step("answer", "Answered", t, { kind: "answer", text: str(c.text) ?? "" }, raw, outTok !== null ? `${fmtInt(outTok)} tokens out` : null),
        );
      } else if (ct === "tool_use") {
        const name = str(c.name) ?? "tool";
        const s = step("tool", "Used a tool", t, { kind: "tool", name, input: toolInput(name, obj(c.input)), calledAtMs: t, result: null, resultAtMs: null }, raw);
        this.out.push(s);
        const id = str(c.id);
        if (id) this.pendingTools.set(id, s);
      } else {
        continue;
      }
      this.thinking = null;
      placed = true;
      raw = [];
    }
    if (!placed) this.out.push(printed(t, line));
  }

  toolResults(t: number, line: string, j: Json): void {
    let placed = false;
    for (const block of arr(obj(j.message).content)) {
      const c = obj(block);
      const id = str(c.tool_use_id) ?? "";
      const s = str(c.type) === "tool_result" ? this.pendingTools.get(id) : undefined;
      if (s?.body.kind !== "tool") continue;
      s.body = { ...s.body, result: toolResultText(c.content), resultAtMs: t };
      s.endMs = t;
      if (!placed) s.raw.push(line);
      placed = true;
      this.pendingTools.delete(id);
    }
    if (!placed) this.out.push(printed(t, line));
  }

  rateLimit(t: number, line: string, j: Json): void {
    const info = obj(j.rate_limit_info);
    const lines = [`Usage limit: ${str(info.status) ?? "unknown"}`];
    for (const [name, w] of Object.entries(obj(info.unifiedWindows))) {
      const u = num(obj(w).utilization);
      if (u !== null) lines.push(`${name.replace(/_/g, "-")} window ${Math.round(u * 100)}% used`);
    }
    this.out.push(step("limit", "Checked usage limit", t, { kind: "lines", lines }, [line]));
  }

  result(t: number, line: string, j: Json): void {
    const usage = obj(j.usage);
    const lines: string[] = [];
    const dur = num(j.duration_ms);
    if (dur !== null) lines.push(`${secs(dur)} by the CLI's own clock`);
    const inTok =
      (num(usage.input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0);
    const outTok = num(usage.output_tokens);
    if (outTok !== null) lines.push(`${fmtInt(inTok)} tokens in · ${fmtInt(outTok)} tokens out`);
    const cost = num(j.total_cost_usd);
    if (cost !== null) lines.push(`$${cost.toFixed(4)} at API prices`);
    const models = Object.keys(obj(j.modelUsage));
    if (models.length > 0) lines.push(`Model actually used: ${models.join(", ")}`);
    const isError = j.is_error === true || (str(j.subtype) ?? "success") !== "success";
    if (isError && str(j.result)) lines.push(`Error: ${str(j.result)}`);
    // An agent that prints only this one block (qoder) carries the answer here.
    if (!isError && str(j.result) && !this.out.some((d) => d.kind === "answer")) {
      this.out.push(step("answer", "Answered", t, { kind: "answer", text: str(j.result) ?? "" }, []));
    }
    const tokens = outTok !== null ? `total: ${fmtInt(inTok)} tokens in · ${fmtInt(outTok)} out` : null;
    this.out.push(step("finished", "Finished", t, { kind: "lines", lines }, [line], tokens));
  }

  /** codex `--json`: `thread.started`, `item.started` / `item.completed`
   * (agent_message / reasoning / anything it ran), and `turn.completed`. */
  codex(t: number, line: string, j: Json): boolean {
    const type = str(j.type);
    const item = obj(j.item);
    const itemType = str(item.type);
    if (type === "thread.started") {
      this.out.push(step("started", "Started", t, { kind: "lines", lines: ["Codex reports every command it runs (shown below)"] }, [line]));
      return true;
    }
    // Every other item codex emits is work it did: a shell command
    // (`command_execution`), or a tool such as an MCP call. Shown as a tool
    // step so nothing it ran hides in a "Printed" line.
    if ((type === "item.started" || type === "item.completed") && itemType && !CODEX_NON_TOOL_ITEMS.has(itemType)) {
      this.codexTool(t, line, type, item, itemType);
      return true;
    }
    if (type === "item.completed" && itemType === "agent_message") {
      this.out.push(step("answer", "Answered", t, { kind: "answer", text: str(item.text) ?? "" }, [line]));
      return true;
    }
    if (type === "item.completed" && itemType === "reasoning") {
      this.out.push(step("thought", "Thought", t, { kind: "quote", text: str(item.text), note: null }, [line]));
      return true;
    }
    if (type === "turn.completed") {
      const u = obj(j.usage);
      const inTok = num(u.input_tokens);
      const outTok = num(u.output_tokens);
      const both = inTok !== null && outTok !== null;
      const lines = both ? [`${fmtInt(inTok)} tokens in · ${fmtInt(outTok)} tokens out`] : [];
      const tokens = both ? `total: ${fmtInt(inTok)} tokens in · ${fmtInt(outTok)} out` : null;
      this.out.push(step("finished", "Finished", t, { kind: "lines", lines }, [line], tokens));
      return true;
    }
    return false;
  }

  /** A codex item that ran something: opened at `item.started`, filled at `item.completed`. */
  private codexTool(t: number, line: string, type: string, item: Json, itemType: string): void {
    const id = `codex:${str(item.id) ?? ""}`;
    const open = this.pendingTools.get(id);
    if (type === "item.started" || open === undefined) {
      const name = itemType === "command_execution" ? "Shell" : itemType;
      const input = str(item.command) ?? toolInput(name, item);
      const s = step("tool", "Used a tool", t, { kind: "tool", name, input, calledAtMs: t, result: null, resultAtMs: null }, [line]);
      this.out.push(s);
      if (type === "item.started") {
        if (str(item.id)) this.pendingTools.set(id, s);
        return;
      }
      this.fillCodexTool(s, t, item);
      return;
    }
    open.raw.push(line);
    this.fillCodexTool(open, t, item);
    this.pendingTools.delete(id);
  }

  private fillCodexTool(s: Draft, t: number, item: Json): void {
    if (s.body.kind !== "tool") return;
    const output = str(item.aggregated_output) ?? (item.result !== undefined ? toolResultText(item.result) : "");
    const exit = num(item.exit_code);
    const status = str(item.status);
    const notes = [exit !== null && exit !== 0 ? `exit code ${exit}` : null, status && status !== "completed" ? status : null].filter(
      (x): x is string => x !== null,
    );
    s.body = { ...s.body, result: notes.length > 0 ? `${output}${output ? "\n" : ""}(${notes.join(", ")})` : output, resultAtMs: t };
    s.endMs = t;
  }
}

/** Read the CLI's stdout lines into steps. Every line lands in exactly one step. */
export function readOutput(run: ChatRun): Draft[] {
  const r = new Reader();
  for (const { t_ms: t, line } of run.output) {
    const j = parse(line);
    if (j === null) {
      r.plain(t, line);
      continue;
    }
    const type = str(j.type);
    const sub = str(j.subtype);
    if (type === "system" && (sub === "hook_started" || sub === "hook_response")) r.hook(t, line, j);
    else if (type === "system" && sub === "init") r.init(t, line, j);
    else if (type === "system" && sub === "thinking_tokens") r.thinkingCount(t, line, j);
    else if (type === "assistant") r.assistant(t, line, j);
    else if (type === "user") r.toolResults(t, line, j);
    else if (type === "rate_limit_event") r.rateLimit(t, line, j);
    else if (type === "result") r.result(t, line, j);
    else if (!r.codex(t, line, j)) r.out.push(printed(t, line));
  }
  return r.out;
}
