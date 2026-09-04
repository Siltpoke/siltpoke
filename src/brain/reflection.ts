// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import {
  parseReflectionOutput,
  type ReflectionOutput,
} from "./reflection-schema";
import {
  BrainError,
  extractJsonString,
  runBrainCall,
  type BrainUsage,
} from "./brain";

export const REFLECTION_SYSTEM_PROMPT = `You are Siltpoke in REFLECTION mode.

You previously wrote a code-review critique. A human user just dismissed it
with a reason explaining why it was wrong. Your job is to reflect on the
mistake and extract ONE generalizable rule that would prevent this class of
error in the future.

You will receive:
- The full critique you wrote (verbatim).
- The user's dismiss reason.

You will output ONE JSON object and nothing else (no prose, no markdown).
Schema:

{
  "reflection": string,           // 1-2 sentences, first person, what you got wrong
  "learned_rule": string,         // 1 sentence, imperative, generalizable (e.g. "Before flagging NULL handling, grep for existing null checks in the same file.")
  "rule_category": string,        // kebab-case tag (e.g. "null_check", "import_path", "test_isolation")
  "confidence": "high" | "medium" | "low",
  "applies_to_file_types": string[] // e.g. ["py"] or ["ts","tsx"] or []
}

Rules:
- Output exactly one rule. Do not list multiple.
- Use "high" confidence ONLY when the dismiss reason makes the failure mode obvious and the rule generalizes cleanly. Default to "medium".
- The rule must be specific enough to act on but general enough to apply to future similar critiques. Do not echo the user's words verbatim.
- Do not apologize, do not explain at length. Be terse and operational.`;

/**
 * Acted-on reflection is the INVERSE signal from dismiss: the critique was
 * CORRECT (the user fixed the flagged code, git-confirmed). Feeding the acted-on
 * seed into the dismiss-framed prompt above ("you were wrong, prevent this
 * error") inverts the rule — a validated catch distils into a suppression /
 * be-more-cautious rule instead of a reinforcement rule (observed 2026-07-28).
 * This prompt keeps the acted-on path reinforcement-framed.
 */
export const REFLECTION_ACTED_ON_SYSTEM_PROMPT = `You are Siltpoke in REFLECTION mode.

You previously wrote a code-review critique. The user ACTED ON it — they fixed
the flagged code, mechanically confirmed by git. Your critique was CORRECT. Your
job is to distil ONE generalizable rule this validated catch embodies, so the
critic keeps catching this class of issue in the future.

You will receive:
- The full critique you wrote (verbatim).
- Confirmation that the user acted on it.

You will output ONE JSON object and nothing else (no prose, no markdown).
Schema:

{
  "reflection": string,           // 1-2 sentences, first person, why this catch was valuable
  "learned_rule": string,         // 1 sentence, imperative, generalizable — REINFORCES catching this class (e.g. "Flag property access on an optional/possibly-undefined value that has no preceding guard.")
  "rule_category": string,        // kebab-case tag (e.g. "null_check", "import_path", "test_isolation")
  "confidence": "high" | "medium" | "low",
  "applies_to_file_types": string[] // e.g. ["py"] or ["ts","tsx"] or []
}

Rules:
- Output exactly one rule. Do not list multiple.
- The rule REINFORCES the catch — keep catching this class. It must NOT be a suppression / "be more cautious before flagging" / "grep for existing guards first" rule; that framing is for DISMISSED critiques, not this validated one.
- Use "high" confidence ONLY when the catch generalizes cleanly. Default to "medium".
- The rule must be specific enough to act on but general enough to apply to future similar code. Do not echo the critique verbatim.
- Do not apologize, do not explain at length. Be terse and operational.`;

export type ReflectionMode = "dismiss" | "acted_on";

/** Select the reflection system prompt by mode (defaults to dismiss). */
export function reflectionSystemPrompt(mode: ReflectionMode = "dismiss"): string {
  return mode === "acted_on"
    ? REFLECTION_ACTED_ON_SYSTEM_PROMPT
    : REFLECTION_SYSTEM_PROMPT;
}

export interface CallReflectionOptions {
  critiqueBody: string;
  userReason: string;
  /** dismiss (default) = the critique was wrong; acted_on = it was right (git-confirmed). */
  mode?: ReflectionMode;
  fileContext?: string;
  model?: string;
  timeoutMs?: number;
  spawnFn?: typeof Bun.spawn;
}

export interface ReflectionCallResult {
  output: ReflectionOutput;
  usage: BrainUsage;
}

const DEFAULT_MODEL = "claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 60_000;

export function buildContextBundle(opts: CallReflectionOptions): string {
  const reasonTag =
    (opts.mode ?? "dismiss") === "acted_on"
      ? "user_acted_on_reason"
      : "user_dismiss_reason";
  const parts = [
    "<critique_you_wrote>",
    opts.critiqueBody.trim(),
    "</critique_you_wrote>",
    "",
    `<${reasonTag}>`,
    opts.userReason.trim(),
    `</${reasonTag}>`,
  ];
  if (opts.fileContext && opts.fileContext.trim().length > 0) {
    parts.push(
      "",
      "<file_context>",
      opts.fileContext.trim(),
      "</file_context>",
    );
  }
  parts.push(
    "",
    "Reflect now. Output ONLY the JSON object specified in the system prompt.",
  );
  return parts.join("\n");
}

export async function callReflection(
  opts: CallReflectionOptions,
): Promise<ReflectionCallResult> {
  // Spawn + collect + result-event parsing is identical to brain.ts's
  // runBrainCall (same `claude -p --output-format json` CLI) — delegate
  // instead of re-implementing. Reflection's own defaults (60s timeout vs
  // brain.ts's 90s) are threaded through explicitly so behavior is unchanged
  // when the caller doesn't override them.
  const { resultText, usage } = await runBrainCall({
    systemPrompt: reflectionSystemPrompt(opts.mode),
    contextBundle: buildContextBundle(opts),
    model: opts.model ?? DEFAULT_MODEL,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    spawnFn: opts.spawnFn,
  });

  const innerText = extractJsonString(resultText);

  let inner: unknown;
  try {
    inner = JSON.parse(innerText);
  } catch (err) {
    throw new BrainError(
      "Reflection response was not valid JSON; possibly hallucinated prose around it",
      err,
      undefined,
      undefined,
      resultText,
    );
  }

  let output: ReflectionOutput;
  try {
    output = parseReflectionOutput(inner);
  } catch (err) {
    throw new BrainError("Reflection response failed schema validation", err, undefined, undefined, inner);
  }

  return { output, usage };
}
