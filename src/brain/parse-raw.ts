// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared raw-text → structured parse chain (single-brain identity #10, S2).
 *
 * Split out of callBrainRaw/callBrain (brain.ts) so every provider adapter and
 * the role-brain factory apply ONE parse chain to a callRaw() text result:
 *   text → extractJsonString → JSON.parse  (parseRawJson)
 *        → parseBrainOutput                (brainOutputFromText)
 * Both wrap failures in BrainError (no `failure` field — these are parse, not
 * subprocess, failures), byte-identical to the errors callBrainRaw/callBrain
 * throw today.
 */
import { BrainError, extractJsonString } from "./brain";
import { parseBrainOutput, describeSchemaIssues, type BrainOutput } from "./schema";

export function parseRawJson(text: string): unknown {
  const inner = extractJsonString(text);
  try {
    return JSON.parse(inner);
  } catch (err) {
    // `text`, not `inner`: when extraction fails, the prose AROUND the block is
    // the whole diagnostic. See BrainError.rawResponse.
    throw new BrainError(
      "Brain response was not valid JSON; possibly hallucinated prose around it",
      err,
      undefined,
      undefined,
      text,
    );
  }
}

/**
 * Name the fields a schema validation actually failed on.
 *
 * 152 of these failures sit in `~/.siltpoke/traces` and not one says which
 * field was wrong: the ZodError went into `BrainError.cause`, which nothing in
 * `src/` reads, and the raw text — in scope right where the throw happens — was
 * dropped as well. So an entire failure class was undiagnosable from history.
 *
 * PATHS AND CODES ONLY. Zod's own `message` interpolates the received value,
 * and that value is model-authored text about the user's code — the same
 * content `normal.ts` deliberately redacts out of the span input. Naming
 * `severity: invalid_value` tells you what to fix; echoing what the model
 * actually wrote would put reviewed source into a log line.
 *
 * Defensive about the error's shape rather than casting to ZodError: this runs
 * on a failure path, and a second throw from the error formatter would replace
 * a diagnosable failure with an undiagnosable one.
 */

export function brainOutputFromText(text: string): BrainOutput {
  // Held so the catch can attach the reply that was rejected. `parseRawJson`
  // throws a wrapped BrainError of its own on bad JSON, which is re-thrown
  // untouched below — so by the time this is read it is always the parsed
  // object, never a half-state.
  let parsed: unknown;
  try {
    parsed = parseRawJson(text);
    return parseBrainOutput(parsed);
  } catch (err) {
    if (err instanceof BrainError) throw err; // JSON-parse failure already wrapped
    // The generic prefix is load-bearing: `audit-absence.ts` classifies this
    // failure by `reason.includes("failed schema validation")`. The detail is
    // appended, never substituted.
    throw new BrainError(
      `Brain response failed schema validation${describeSchemaIssues(err)}`,
      err,
      undefined,
      undefined,
      parsed,
    );
  }
}
