// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The `--output-schema` file codex is handed, and the two shape conversions
 * around it. Moved out of codex.ts, unchanged, because that file crossed the
 * 400-line cap and in this repo a file over its cap gets split, not re-pinned.
 *
 * Also the home of `schemaCacheDir`, which is where defect `[26]`'s sibling path
 * lives: this path rides argv on EVERY codex call as `--output-schema <path>`,
 * so it needs the same `cleanTempBases()` filter that defends the prompt path.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../utils/atomic-write";
import { brainOutputSchema } from "../schema";
import { cleanTempBases } from "../system-prompt-file";

/**
 * Revision-pass item 2: content-hash filename, write-once idempotent rewrite.
 *
 * Defect `[26]`, the sibling path a cross-check caught: moving only the rubric
 * out of argv would have left the codex fix inert on exactly the machine shape
 * that made the first version of the `claude` fix inert — `os.tmpdir()` honours
 * `%TEMP%`, and a Windows account name may legally contain `&`, `^`, `%`, `(`,
 * `)`. So the base comes from the same `cleanTempBases()` filter that defends the
 * other path. Off Windows its first entry IS `tmpdir()`, so nothing moves there;
 * the `?? tmpdir()` covers the impossible case of every base being dirty, where a
 * wrong-but-present directory beats throwing.
 */
function schemaCacheDir(): string {
  const clean = cleanTempBases()[0];
  if (clean !== undefined) return join(clean, "siltpoke-codex-schemas");
  // No usable base. Falling back means handing codex an argv entry Windows will
  // refuse — and the operator would see byte-for-byte the error defect `[26]`
  // produces, so the conclusion available to them would be "the fix did not
  // ship". Say which, exactly as the sibling path does on its own last resort.
  console.error(
    "[siltpoke] no writable temp directory whose path is free of cmd.exe special" +
      " characters — codex's --output-schema argument will carry one, which" +
      " Windows will refuse (defect [26]).",
  );
  return join(tmpdir(), "siltpoke-codex-schemas");
}

/**
 * OpenAI strict structured-output requires EVERY property listed in
 * `required` (optionals must instead union with null) — live-verified
 * 2026-07-07: raw z.toJSONSchema output got 400 invalid_json_schema
 * ("Missing 'line'"). Recursively: required := all keys; previously-optional
 * properties get a null branch. The adapter strips those nulls back out
 * before zod parsing (stripNulls below), so brainOutputSchema is untouched.
 */
export function toOpenAiStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toOpenAiStrictSchema);
  if (typeof node !== "object" || node === null) return node;
  const obj = { ...(node as Record<string, unknown>) };
  for (const key of Object.keys(obj)) {
    if (key !== "properties") obj[key] = toOpenAiStrictSchema(obj[key]);
  }
  if (obj.type === "object" && typeof obj.properties === "object" && obj.properties !== null) {
    const props: Record<string, unknown> = {};
    const previouslyRequired = new Set(
      Array.isArray(obj.required) ? (obj.required as string[]) : [],
    );
    for (const [key, value] of Object.entries(obj.properties as Record<string, unknown>)) {
      const strict = toOpenAiStrictSchema(value);
      props[key] = previouslyRequired.has(key)
        ? strict
        : { anyOf: [strict, { type: "null" }] };
    }
    obj.properties = props;
    obj.required = Object.keys(props);
  }
  return obj;
}

/** Strip null-valued keys (the strict-schema optionals) before zod parsing —
 * brainOutputSchema expresses optionality as absence, not null.
 * COUPLING: safe only while brainOutputSchema has zero .nullable() fields
 * (true today — final-pass review 2026-07-07); a future nullable field would
 * be silently dropped here. Revisit this pair together. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) continue;
    out[k] = stripNulls(v);
  }
  return out;
}

/**
 * The reply shape codex is asked for: `brainOutputSchema` minus the fields
 * siltpoke writes itself. `truncated` and `repaired` are dropped from any model
 * reply anyway (`stripSystemAuthoredFields` in schema.ts), and strict mode makes
 * every offered property one the model MUST emit — so offering them asked the
 * model to forge them. Worse, `truncated` is a `z.record`, whose JSON Schema
 * carries `propertyNames`, which OpenAI strict mode refuses: from #692 on, every
 * codex review got `400 invalid_json_schema` (defect `[78]`).
 */
const codexReplySchema = brainOutputSchema.omit({ truncated: true, repaired: true });

/** zod v4 native JSON-Schema for --output-schema (no new dependency — spec §2),
 * post-processed to OpenAI strict shape. Lazily computed once per process;
 * the schema is invariant at runtime, so re-hashing + rewriting per call
 * would be pure wasted sync IO. */
let cachedSchemaPath: string | undefined;
export function schemaFilePath(): string {
  if (cachedSchemaPath && existsSync(cachedSchemaPath)) return cachedSchemaPath;
  const json = JSON.stringify(toOpenAiStrictSchema(z.toJSONSchema(codexReplySchema)));
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  const path = join(schemaCacheDir(), `${hash}.json`);
  if (!existsSync(path)) atomicWrite(path, json);
  cachedSchemaPath = path;
  return path;
}
