// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke reject — flip a pending fact to retired.
 *
 * Inbox state machine (pending → retired via /siltpoke-reject)
 *
 * Implementation: thin imperative shell over the pure-function transition core
 * in `src/memory/transitions.ts`. The core
 * handles find + immutable update; this shell handles argv parsing, I/O
 * (read/write), and exit-code mapping.
 *
 * Note: `retireFactCore` is permissive — it retires pending OR active facts
 * and is idempotent on already-retired. The CLI keeps strict-reject parity
 * (only `pending` → retired; everything else → exit 2 "not pending") by
 * checking fact.status upfront before delegating to the core. The HTTP layer
 * calls the core directly to get the permissive/idempotent behavior.
 *
 * Usage:
 *   siltpoke reject <fact-id>
 *
 * Exit codes:
 *   0  state transition applied
 *   1  read/write error or fact not found
 *   2  fact exists but is not in pending state
 *   3  CLI flag error (missing id)
 */

import { readMemory, writeMemory } from "../memory/memory";
import { retireFactCore } from "../memory/transitions";
import {
  defaultOutput,
  loadMemoryOrReport,
  parseSingleFactIdArg,
  runFactCliMain,
  writeMemoryOrReport,
  type OutputFn,
  type ParsedFactIdArgs,
} from "./fact-cli-shared";

export type { OutputFn };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RejectFactOpts = {
  argv: string[];
  homeBase: string;
  now?: Date;
  output?: OutputFn;
  /** @internal test seam */
  deps?: {
    readMemory?: typeof readMemory;
    writeMemory?: typeof writeMemory;
  };
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseRejectFactArgs(argv: string[]): ParsedFactIdArgs {
  return parseSingleFactIdArg(argv, "reject");
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runRejectFact(opts: RejectFactOpts): Promise<number> {
  const out = opts.output ?? defaultOutput;
  const readFn = opts.deps?.readMemory ?? readMemory;
  const writeFn = opts.deps?.writeMemory ?? writeMemory;

  // Parse args
  const parsed = parseRejectFactArgs(opts.argv);
  if (!parsed.ok) {
    out(`siltpoke reject: ${parsed.message}`);
    return 3;
  }

  const { id } = parsed;

  // Load memory (read error or empty store both report "fact not found").
  const loaded = await loadMemoryOrReport(readFn, opts.homeBase, "reject", id, out);
  if (!loaded.ok) return loaded.exitCode;
  const { memory } = loaded;

  const existing = memory.facts.find((f) => f.id === id);
  if (!existing) {
    out(`siltpoke reject: fact not found: ${id}`);
    return 1;
  }

  // CLI strict-reject parity: only `pending` is allowed to transition.
  // (HTTP layer calls the core directly to get the permissive path.)
  if (existing.status !== "pending") {
    out(`siltpoke reject: fact ${id} is not pending (status: ${existing.status})`);
    return 2;
  }

  // Delegate the mutation to the pure core.
  const result = retireFactCore(memory, id);

  // After the upfront pending-guard, `result.ok` is guaranteed true and the
  // memory reference is fresh — but narrow defensively rather than asserting.
  if (!result.ok) {
    // Unreachable under current core semantics; map conservatively to exit 1.
    out(`siltpoke reject: unexpected transition error for ${id}`);
    return 1;
  }

  const writeErr = await writeMemoryOrReport(writeFn, opts.homeBase, result.memory, "reject", out);
  if (writeErr !== null) return writeErr;

  out(`rejected fact ${id}: ${result.fact.text}`);
  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await runFactCliMain(runRejectFact);
}
