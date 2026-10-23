// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What `claude -p --output-format stream-json --verbose` says about itself:
 * the model it actually ran (the keys of `result.modelUsage`), its version and
 * allowed tools (`system/init`), tokens and cost (`result`). Read from the raw
 * lines the chat call record keeps; nothing here is inferred.
 */
interface ClaudeOutputFacts {
  reportedModel: string | null;
  cliVersion: string | null;
  permittedTools: string[] | null;
  tokens: {
    input: number;
    output: number;
    cache_read: number | null;
    cache_write: number | null;
    thinking: number | null;
  } | null;
  costUsd: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The last `system/init` and the last `result` event among the lines. */
function initAndResult(lines: string[]): { init: Obj | null; result: Obj | null } {
  let init: Obj | null = null;
  let result: Obj | null = null;
  for (const line of lines) {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(ev)) continue;
    if (ev.type === "system" && ev.subtype === "init") init = ev;
    if (ev.type === "result") result = ev;
  }
  return { init, result };
}

function tokensOf(usage: Obj): NonNullable<ClaudeOutputFacts["tokens"]> {
  const details = isObj(usage.output_tokens_details) ? usage.output_tokens_details : null;
  return {
    input: num(usage.input_tokens) ?? 0,
    output: num(usage.output_tokens) ?? 0,
    cache_read: num(usage.cache_read_input_tokens),
    cache_write: num(usage.cache_creation_input_tokens),
    thinking: details ? num(details.thinking_tokens) : null,
  };
}

export function claudeOutputFacts(lines: string[]): ClaudeOutputFacts {
  const { init, result } = initAndResult(lines);
  // A call that used two models (a tool call on another one) names both.
  const usedModels = isObj(result?.modelUsage) ? Object.keys(result.modelUsage) : [];
  const tools = init?.tools;
  return {
    reportedModel: usedModels.length > 0 ? usedModels.join(", ") : str(init?.model),
    cliVersion: str(init?.claude_code_version),
    permittedTools: Array.isArray(tools) && tools.every((t) => typeof t === "string") ? (tools as string[]) : null,
    tokens: isObj(result?.usage) ? tokensOf(result.usage) : null,
    costUsd: num(result?.total_cost_usd),
  };
}
