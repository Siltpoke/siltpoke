// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Brain prompt assembly.
 *
 * 16KB hard cap, priority ordering, snippet truncation marker;
 * query-time cross-file `calls` resolution via the symbol table.
 *
 * Assembler is synchronous — caller pre-loads source bytes into
 * a Map so the assembler stays deterministic and easy to unit-test.
 *
 * Priority (top-down, drop lowest when over budget):
 *   1. system prompt header (always included)
 *   2. target node identifier + full snippet (truncated at SNIPPET_MAX_BYTES)
 *   3. containing-file marker line
 *   4. incoming callers (subgraph + source-time resolved)
 *   5. outgoing callees (subgraph + source-time resolved)
 *   6. imports list (raw strings from import edges)
 *
 * Each snippet is bounded by SNIPPET_MAX_BYTES (600 bytes). Total bundle is
 * bounded by TOTAL_BUDGET_BYTES_DEFAULT (16 KB). When either cap fires, the
 * `truncated` flag rises so the orchestrator can flag the explanation.
 */

import type { Subgraph } from "../repo-graph/subgraph";
import { viewSubgraph } from "../repo-graph/subgraph";
import type {
  NodeCandidate,
  SymbolTable,
} from "../repo-graph/symbol-table";

export const SNIPPET_MAX_BYTES = 600;
export const TOTAL_BUDGET_BYTES_DEFAULT = 16 * 1024;
const TRUNCATION_MARKER = "\n// … (truncated)\n";

export const EXPLAIN_SYSTEM_PROMPT = `You are Siltpoke's code explainer. Read the context below and produce a plain-English explanation of the target symbol.

Format requirements:
- Start with a single \`#\` heading for the target name.
- One paragraph summary (<=150 words) describing what the symbol does.
- A "Defined in" line with the [file:line] citation.
- "Calls" bullet list with [file:line] citations for callees.
- "Called by" bullet list with [file:line] citations for incoming callers.
- "Imports" bullet list referencing the imported modules.
- Total length <500 words.

Citation format: every reference to source uses the inline form [file:line] (e.g. [src/cli/doctor.ts:42]). Range form [src/cli/doctor.ts:42-87] is allowed. Do NOT invent files or line numbers.

Example output:

# runDoctor

\`runDoctor\` orchestrates the install diagnostic at [src/cli/doctor.ts:42-87]. It loads config, walks each check, and prints PASS/FAIL.

Defined in [src/cli/doctor.ts:42-87]

Calls:
- loadDoctorConfig [src/cli/doctor.config.ts:12]
- runCheck [src/cli/doctor.checks.ts:34]

Called by:
- main [src/cli/index.ts:67]

Imports:
- picocolors
- node:fs/promises
`;

export interface AssemblePromptInput {
  targetId: string;
  subgraph: Subgraph;
  symbolTable: SymbolTable;
  /** Map of repo-relative path → source content. Caller pre-loads. */
  sources: Map<string, string>;
  /** Override the 16 KB default if needed (T-smoke calibration). */
  budgetBytes?: number;
}

export interface AssemblePromptOutput {
  systemPrompt: string;
  contextBundle: string;
  includedSources: string[];
  truncated: boolean;
  totalBytes: number;
}

function truncateSnippet(content: string, maxBytes: number): {
  body: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return { body: content, truncated: false };
  }
  // Conservative truncation: take the first maxBytes - len(marker) chars.
  const markerLen = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const sliceLen = Math.max(0, maxBytes - markerLen);
  return {
    body: content.slice(0, sliceLen) + TRUNCATION_MARKER,
    truncated: true,
  };
}

interface Block {
  label: string;
  body: string;
  source?: string;
}

export function assemblePrompt(
  input: AssemblePromptInput,
): AssemblePromptOutput {
  const budget = input.budgetBytes ?? TOTAL_BUDGET_BYTES_DEFAULT;
  const view = viewSubgraph(input.subgraph);
  const target = input.subgraph.target;
  let truncated = input.subgraph.truncated;

  const blocks: Block[] = [];
  blocks.push({
    label: "TARGET",
    body: `## TARGET\n${target.type} ${target.name} at ${target.path}:${target.lineRange[0]}-${target.lineRange[1]}\n`,
  });

  // 1. Target source snippet
  const targetSource = input.sources.get(target.path);
  if (targetSource !== undefined) {
    const { body, truncated: snTrunc } = truncateSnippet(
      targetSource,
      SNIPPET_MAX_BYTES,
    );
    if (snTrunc) truncated = true;
    blocks.push({
      label: "TARGET_SOURCE",
      body: `### Source [${target.path}]\n\`\`\`\n${body}\n\`\`\`\n`,
      source: target.path,
    });
  }

  // 2. Containing file marker
  if (view.containingFile && view.containingFile.path !== target.path) {
    blocks.push({
      label: "CONTAINER",
      body: `### Containing file: ${view.containingFile.path}\n`,
    });
  }

  // 3 + 4. Cross-file callees + callers — graph edges first, then optional
  // source-time identifier scan to fill in callees from raw source.
  const seenSources = new Set<string>([target.path]);
  const sourceTimeCallees = targetSource
    ? resolveCallsFromSource(targetSource, input.symbolTable, {
        excludeSelfName: target.name,
        cap: 50,
      })
    : [];

  const allCallees: NodeCandidate[] = dedupeCandidates([
    ...view.outgoingCalls,
    ...sourceTimeCallees,
  ]);
  const allCallers = view.incomingCalls;

  if (allCallers.length > 0) {
    const lines = allCallers.map((c) => `- ${c.name} [${c.path}:${c.lineRange[0]}]`);
    blocks.push({
      label: "CALLERS",
      body: `### Called by\n${lines.join("\n")}\n`,
    });
  }
  if (allCallees.length > 0) {
    const lines = allCallees.map((c) => `- ${c.name} [${c.path}:${c.lineRange[0]}]`);
    blocks.push({
      label: "CALLEES",
      body: `### Calls\n${lines.join("\n")}\n`,
    });
  }

  // 5. Caller / callee snippets (lower-priority — gets dropped first under budget pressure)
  for (const c of [...allCallers, ...allCallees]) {
    if (seenSources.has(c.path)) continue;
    const src = input.sources.get(c.path);
    if (src === undefined) continue;
    seenSources.add(c.path);
    const { body, truncated: snTrunc } = truncateSnippet(src, SNIPPET_MAX_BYTES);
    if (snTrunc) truncated = true;
    blocks.push({
      label: `NEIGHBOR(${c.name})`,
      body: `### Neighbor source [${c.path}]\n\`\`\`\n${body}\n\`\`\`\n`,
      source: c.path,
    });
  }

  // 6. Imports list (raw import-edge strings)
  if (view.importsFrom.length > 0) {
    const lines = view.importsFrom.map((s) => `- ${s}`);
    blocks.push({
      label: "IMPORTS",
      body: `### Imports\n${lines.join("\n")}\n`,
    });
  }

  // Total budget enforcement: high-priority blocks (TARGET, TARGET_SOURCE,
  // CONTAINER, CALLERS, CALLEES, IMPORTS) are kept; NEIGHBOR_* are dropped
  // first when over budget.
  let assembled = "";
  const includedSources: string[] = [];
  for (const block of blocks) {
    const candidate = assembled + block.body;
    if (Buffer.byteLength(candidate, "utf8") > budget) {
      truncated = true;
      // Skip this block (and any following ones if they keep blowing budget).
      continue;
    }
    assembled = candidate;
    if (block.source) includedSources.push(block.source);
  }

  return {
    systemPrompt: EXPLAIN_SYSTEM_PROMPT,
    contextBundle: assembled,
    includedSources,
    truncated,
    totalBytes: Buffer.byteLength(assembled, "utf8"),
  };
}

function dedupeCandidates(list: NodeCandidate[]): NodeCandidate[] {
  const seen = new Set<string>();
  const out: NodeCandidate[] = [];
  for (const c of list) {
    if (seen.has(c.nodeId)) continue;
    seen.add(c.nodeId);
    out.push(c);
  }
  return out;
}

const IDENTIFIER_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

export interface ResolveCallsOptions {
  excludeSelfName: string;
  cap: number;
}

/**
 * Cheap source-time call resolution: scans the function body for
 * `identifier(` patterns and looks each up in the symbol table. First
 * matching candidate per name wins (caller can disambiguate later if it
 * matters). Capped at `cap` resolutions to bound prompt size.
 *
 * Heuristic only — not a true scope-aware resolver. Treats every
 * `foo(` literal as a potential call, which means JSX/macros/string
 * literals may produce false positives. Good enough for prompt assembly
 * (over-inclusion just bloats the bundle; evidence-guard catches false
 * citations downstream).
 */
export function resolveCallsFromSource(
  source: string,
  symbolTable: SymbolTable,
  opts: ResolveCallsOptions,
): NodeCandidate[] {
  if (source.length === 0) return [];
  const seenNames = new Set<string>();
  const out: NodeCandidate[] = [];
  for (const m of source.matchAll(IDENTIFIER_RE)) {
    const name = m[1];
    if (name === opts.excludeSelfName) continue;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const candidates = symbolTable.name_to_candidates.get(name);
    if (!candidates || candidates.length === 0) continue;
    out.push(candidates[0]);
    if (out.length >= opts.cap) break;
  }
  return out;
}
