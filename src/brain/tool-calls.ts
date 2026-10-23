// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Which tools a reviewer used during one call, read from the CLI's own output
 * (🛡 prompt-injection defence [C], probe 2026-10-18 §"结论能说到哪一步").
 *
 * Without this, "the reviewer never tried to read the file a planted note asked
 * for" rests only on the answer not quoting it — a read that was tried, blocked
 * and left unmentioned looks the same as no read.
 *
 * Only the call's NAME, its target (path / pattern / command) and whether it
 * failed are kept. The text a tool returned is not: it can be a whole file,
 * and that file can hold a secret.
 *
 * Keep this module import-free: the dashboard's browser bundle imports
 * `CODEX_NON_TOOL_ITEMS` from it (`web/client/lib/chat-runs-steps.ts`).
 */

export interface ToolCallRecord {
  /** `Read` / `Grep` / `Glob` for claude; `shell` or the item type for codex. */
  tool: string;
  /** The path, pattern or command — capped at {@link TARGET_CAP} chars. */
  target: string;
  /** True when the CLI reported the call as an error or a non-zero exit. */
  failed: boolean;
}

/**
 * What a review row says about tool calls. A list (possibly empty) = the CLI
 * reports its tool calls and these are all of them. `"not_recorded"` = this
 * provider's output carries no tool record, so an empty list would be a lie
 * that reads as "it never tried".
 */
export type ToolCallsField = ToolCallRecord[] | "not_recorded";

const TARGET_CAP = 2000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const contentOf = (ev: unknown): unknown[] => {
  const c = obj(obj(ev).message).content;
  return Array.isArray(c) ? c : [];
};
const cap = (s: string): string => (s.length > TARGET_CAP ? `${s.slice(0, TARGET_CAP)}…` : s);

function claudeTarget(input: Json): string {
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  const pattern = str(input.pattern);
  if (pattern !== undefined) return cap(path ? `${pattern} in ${path}` : pattern);
  return cap(path ?? str(input.command) ?? JSON.stringify(input));
}

/** Every content block of type `blockType` in the messages of events of type `eventType`. */
function blocksOf(events: readonly unknown[], eventType: string, blockType: string): Json[] {
  return events
    .filter((ev) => obj(ev).type === eventType)
    .flatMap((ev) => contentOf(ev).map(obj))
    .filter((b) => b.type === blockType);
}

/**
 * From a `claude -p --output-format json --verbose` event array: every
 * `tool_use` block, failed when its `tool_result` carries `is_error`.
 */
export function claudeToolCalls(events: readonly unknown[]): ToolCallRecord[] {
  const failedIds = new Set(
    blocksOf(events, "user", "tool_result")
      .filter((b) => b.is_error === true)
      .map((b) => str(b.tool_use_id)),
  );
  return blocksOf(events, "assistant", "tool_use").map((b) => ({
    tool: str(b.name) ?? "tool",
    target: claudeTarget(obj(b.input)),
    failed: str(b.id) !== undefined && failedIds.has(str(b.id)),
  }));
}

/** codex items that are not work it ran: its words, its thinking, its own plan, its own warnings. */
export const CODEX_NON_TOOL_ITEMS: ReadonlySet<string> = new Set(["agent_message", "reasoning", "todo_list", "error"]);

/**
 * What a codex item was asked to do, from its input-side fields only. Never
 * the whole item: `aggregated_output` / `result` / `error` are what the tool
 * returned. An item with none of these fields gets an empty target.
 */
function codexTarget(item: Json): string {
  const mcp = [str(item.server), str(item.tool)].filter(Boolean).join(".");
  const changed = Array.isArray(item.changes) ? item.changes.map((c) => str(obj(c).path)).filter(Boolean).join(", ") : "";
  return str(item.command) ?? (mcp || str(item.query) || changed);
}

/** One codex item that ran something, or null for any other item. */
function codexRecord(item: Json): ToolCallRecord | null {
  const type = str(item.type);
  if (type === undefined || CODEX_NON_TOOL_ITEMS.has(type)) return null;
  const exit = item.exit_code;
  const status = str(item.status);
  return {
    tool: type === "command_execution" ? "shell" : type,
    target: cap(codexTarget(item)),
    failed: (typeof exit === "number" && exit !== 0) || status === "failed" || status === "declined",
  };
}

/**
 * From `codex exec --json` events: every item that ran something — a shell
 * command (`command_execution`) or any other tool item. An item whose
 * completion line never came is kept with `failed: false`; its completion,
 * when it comes, settles `failed`. A call the kill timer cut off leaves no
 * record at all: the provider throws on the non-zero exit before reading events.
 */
export function codexToolCalls(events: readonly unknown[]): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  const order: ToolCallRecord[] = [];
  for (const ev of events) {
    const e = obj(ev);
    if (e.type !== "item.started" && e.type !== "item.completed") continue;
    const rec = codexRecord(obj(e.item));
    if (rec === null) continue;
    const id = str(obj(e.item).id);
    const seen = id !== undefined ? byId.get(id) : undefined;
    if (seen) {
      seen.failed = rec.failed;
      continue;
    }
    order.push(rec);
    if (id !== undefined) byId.set(id, rec);
  }
  return order;
}

/** One line for a terminal: what the reviewer opened or ran, or that nobody can tell. */
export function describeToolCalls(field: ToolCallsField | undefined): string {
  if (field === undefined || field === "not_recorded") return "reviewer tools: not recorded — this agent does not report them";
  if (field.length === 0) return "reviewer tools: none";
  return `reviewer tools: ${field.map((c) => `${[c.tool, c.target].filter(Boolean).join(" ")}${c.failed ? " (failed)" : ""}`).join(" · ")}`;
}
