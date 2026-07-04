// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke approve — flip a pending fact to active.
 *
 * Inbox state machine (pending → active via /siltpoke-approve)
 *
 * Implementation: thin imperative shell over the pure-function transition core
 * in `src/memory/transitions.ts`. The core
 * handles find/status-guard/immutable update; this shell handles argv parsing,
 * I/O (read/write), and exit-code mapping.
 *
 * Usage:
 *   siltpoke approve <fact-id>
 *
 * Exit codes:
 *   0  state transition applied
 *   1  read/write error or fact not found
 *   2  fact exists but is not in pending state
 *   3  CLI flag error (missing id)
 */

import { join } from "node:path";
import type { CoreMemory } from "../memory/memory";
import { readMemory, writeMemory } from "../memory/memory";
import { approveFactCore } from "../memory/transitions";

// ---------------------------------------------------------------------------
// Output helper
// ---------------------------------------------------------------------------

export type OutputFn = (msg: string) => void;

const defaultOutput: OutputFn = (msg: string) => {
  process.stdout.write(`${msg}\n`);
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApproveFactOpts = {
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

type ParsedArgs =
  | { ok: true; id: string }
  | { ok: false; message: string };

export function parseApproveFactArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--")) {
      return { ok: false, message: `unknown flag: ${arg}` };
    }
    positional.push(arg);
  }

  if (positional.length === 0) {
    return { ok: false, message: "missing fact id — usage: siltpoke approve <fact-id>" };
  }

  return { ok: true, id: positional[0]! };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runApproveFact(opts: ApproveFactOpts): Promise<number> {
  const out = opts.output ?? defaultOutput;
  const now = opts.now ?? new Date();
  const readFn = opts.deps?.readMemory ?? readMemory;
  const writeFn = opts.deps?.writeMemory ?? writeMemory;

  // Parse args
  const parsed = parseApproveFactArgs(opts.argv);
  if (!parsed.ok) {
    out(`siltpoke approve: ${parsed.message}`);
    return 3;
  }

  const { id } = parsed;

  // Load memory
  let memory: CoreMemory | null;
  try {
    memory = await readFn(opts.homeBase);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke approve: read failed: ${msg}`);
    return 1;
  }

  // Empty memory → fact-not-found (preserves existing behavior when no file).
  if (!memory) {
    out(`siltpoke approve: fact not found: ${id}`);
    return 1;
  }

  // Delegate find/status-guard/mutation to pure core.
  const result = approveFactCore(memory, id, () => now.toISOString());

  if (!result.ok) {
    switch (result.error.kind) {
      case "not_found":
        out(`siltpoke approve: fact not found: ${id}`);
        return 1;
      case "not_pending":
        out(
          `siltpoke approve: fact ${id} is not pending (status: ${result.error.current_status})`,
        );
        return 2;
      case "not_retire_proposed":
      case "already_retired":
      case "not_retired":
        out(`siltpoke approve: unexpected error for approve operation`);
        return 1;
      default: {
        // Exhaustiveness guard — compile error if TransitionError gains a new kind.
        const _exhaustive: never = result.error;
        void _exhaustive;
        out(`siltpoke approve: unexpected error`);
        return 1;
      }
    }
  }

  try {
    await writeFn(opts.homeBase, result.memory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke approve: write failed: ${msg}`);
    return 1;
  }

  out(`approved fact ${id}: ${result.fact.text}`);
  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const rawArgs = process.argv.slice(2);
  const homeBase = join(process.env.HOME ?? "", ".siltpoke");
  const code = await runApproveFact({ argv: rawArgs, homeBase });
  process.exit(code);
}
