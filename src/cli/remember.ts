// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke remember — user-initiated memory write CLI.
 *
 * Trust path: writes directly to active status.
 *
 * Usage:
 *   siltpoke remember [--type fact|goal|constraint] "claim text here"
 *
 * Exit codes:
 *   0  written successfully
 *   1  read/write/inference error
 *   3  CLI flag error (unknown flag, missing claim, malformed --type)
 */

import { join } from "node:path";
import { z } from "zod";
import { readMemory, writeMemory, newId, emptyMemory } from "../memory/memory";
import type { CoreMemory } from "../memory/memory";

// ---------------------------------------------------------------------------
// Output helper — process.stdout.write for easy test capture
// ---------------------------------------------------------------------------

export type OutputFn = (msg: string) => void;

const defaultOutput: OutputFn = (msg: string) => {
  process.stdout.write(`${msg}\n`);
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RememberType = "fact" | "goal" | "constraint";

export type RememberOpts = {
  argv: string[];
  homeBase: string;
  now?: Date;
  output?: OutputFn;
  /** @internal test seam */
  deps?: {
    readMemory?: typeof readMemory;
    writeMemory?: typeof writeMemory;
    inferTypeFn?: (claim: string) => Promise<RememberType>;
  };
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type ParsedArgs =
  | { ok: true; type?: RememberType; claim: string }
  | { ok: false; message: string };

const VALID_TYPES: ReadonlySet<string> = new Set(["fact", "goal", "constraint"]);

export function parseRememberArgs(argv: string[]): ParsedArgs {
  let type: RememberType | undefined;
  const positional: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i]!;

    if (arg === "--type") {
      i++;
      if (i >= argv.length) {
        return { ok: false, message: "--type requires a value (fact|goal|constraint)" };
      }
      const val = argv[i]!;
      if (!VALID_TYPES.has(val)) {
        return { ok: false, message: `--type must be fact, goal, or constraint (got: ${val})` };
      }
      type = val as RememberType;
    } else if (arg.startsWith("--")) {
      return { ok: false, message: `unknown flag: ${arg}` };
    } else {
      positional.push(arg);
    }

    i++;
  }

  const claim = positional.join(" ").trim();
  if (claim.length === 0) {
    return { ok: false, message: "missing claim: provide a quoted string after the flags" };
  }

  return { ok: true, type, claim };
}

// ---------------------------------------------------------------------------
// Type inference via LLM (cheap Haiku — production path)
// ---------------------------------------------------------------------------

const TYPE_INFERENCE_SYSTEM_PROMPT =
  "You categorize a user's memory claim. Reply with JSON only: {\"type\": \"fact\"} or {\"type\": \"goal\"} or {\"type\": \"constraint\"}. " +
  "No other text. fact = observable truth about the user. goal = something they want to achieve. constraint = rule/preference to always follow.";

const TYPE_INFERENCE_MODEL = "claude-haiku-4-5-20251001";
const TYPE_INFERENCE_TIMEOUT_MS = 15_000;

const TYPE_ENUM = z.enum(["fact", "goal", "constraint"]);
const inferredTypeSchema = z.object({ type: TYPE_ENUM });

/**
 * Parse the raw LLM output from the type-inference brain call.
 * Returns null when the output does not satisfy the expected shape so that
 * callers can make the fallback decision explicit rather than silently
 * defaulting inside the parser.
 */
export function parseInferredType(raw: unknown): RememberType | null {
  const parsed = inferredTypeSchema.safeParse(raw);
  if (parsed.success) return parsed.data.type;
  return null;
}

export async function inferMemoryType(claim: string): Promise<RememberType> {
  const { callBrainRaw } = await import("../brain/brain");
  const result = await callBrainRaw({
    systemPrompt: TYPE_INFERENCE_SYSTEM_PROMPT,
    contextBundle: `Classify this claim: "${claim}"`,
    model: TYPE_INFERENCE_MODEL,
    timeoutMs: TYPE_INFERENCE_TIMEOUT_MS,
  });

  const type = parseInferredType(result.output);
  if (type === null) {
    // LLM returned unexpected output — log the warning, default to "fact"
    // so the user's `siltpoke remember "..."` call still succeeds.
    console.error(
      "[siltpoke remember] type inference returned unexpected output; defaulting to fact",
    );
    return "fact";
  }
  return type;
}

// ---------------------------------------------------------------------------
// Memory mutation helpers (pure — return new CoreMemory)
// ---------------------------------------------------------------------------

function pushFact(memory: CoreMemory, claim: string, now: Date): { memory: CoreMemory; id: string } {
  const id = newId("f");
  const ts = now.toISOString();
  const fact = {
    id,
    text: claim,
    source_session_id: null,
    confidence: 1.0,
    status: "active" as const,
    created_at: ts,
    last_seen_at: ts,
    supersedes: null,
    superseded_by: null,
    pinned: true,
    recall_count: 0,
    retired_reason: null,
    // A /remember fact is a user-asserted, pinned hard constraint —
    // provenance stream "remember", stability "permanent", confirmed at creation.
    stability: "permanent" as const,
    learned_from: { stream: "remember" as const, session_id: null },
    kind: null,
    last_confirmed_at: ts,
    expires_at: null,
    // Provenance for the /memory "Why" line — without it the row falls back to
    // "no source recorded (early memory)", mislabeling a fresh /remember fact as
    // a legacy sourceless one (same fix as chat capture's save_reason).
    save_reason: "you asked me to remember this",
    invalid_at: null,
    events: [],
  };
  return {
    memory: { ...memory, facts: [...memory.facts, fact] },
    id,
  };
}

function pushGoal(memory: CoreMemory, claim: string, now: Date): { memory: CoreMemory; id: string } {
  const id = newId("g");
  const goal = {
    id,
    text: claim,
    created_at: now.toISOString(),
    status: "active" as const,
  };
  return {
    memory: {
      ...memory,
      user_profile: {
        ...memory.user_profile,
        goals: [...memory.user_profile.goals, goal],
      },
    },
    id,
  };
}

function pushConstraint(memory: CoreMemory, claim: string): { memory: CoreMemory } {
  return {
    memory: {
      ...memory,
      user_profile: {
        ...memory.user_profile,
        constraints: [...memory.user_profile.constraints, claim],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runRemember(opts: RememberOpts): Promise<number> {
  const out = opts.output ?? defaultOutput;
  const now = opts.now ?? new Date();
  const readFn = opts.deps?.readMemory ?? readMemory;
  const writeFn = opts.deps?.writeMemory ?? writeMemory;
  const inferFn = opts.deps?.inferTypeFn ?? inferMemoryType;

  // Parse args
  const parsed = parseRememberArgs(opts.argv);
  if (!parsed.ok) {
    out(`siltpoke remember: ${parsed.message}`);
    return 3;
  }

  // Infer type if not provided
  let type: RememberType;
  try {
    type = parsed.type ?? (await inferFn(parsed.claim));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke remember: type inference failed: ${msg}`);
    return 1;
  }

  // Load memory
  let memory: CoreMemory;
  try {
    memory = (await readFn(opts.homeBase)) ?? emptyMemory();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke remember: read failed: ${msg}`);
    return 1;
  }

  // Mutate and write
  let newId_: string | undefined;
  let updated: CoreMemory;

  switch (type) {
    case "fact": {
      const r = pushFact(memory, parsed.claim, now);
      updated = r.memory;
      newId_ = r.id;
      break;
    }
    case "goal": {
      const r = pushGoal(memory, parsed.claim, now);
      updated = r.memory;
      newId_ = r.id;
      break;
    }
    case "constraint": {
      const r = pushConstraint(memory, parsed.claim);
      updated = r.memory;
      break;
    }
  }

  try {
    await writeFn(opts.homeBase, updated);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke remember: write failed: ${msg}`);
    return 1;
  }

  // Terminal output
  if (type === "constraint") {
    out(`remembered: ${parsed.claim} (type: constraint)`);
  } else {
    out(`remembered: ${parsed.claim} (type: ${type}, id: ${newId_})`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const rawArgs = process.argv.slice(2);
  const homeBase = join(process.env.HOME ?? "", ".siltpoke");
  const code = await runRemember({ argv: rawArgs, homeBase });
  process.exit(code);
}
