// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * siltpoke tag-entities — on-demand CLI trigger for the entity-tagging
 * janitor (Task 4's `tagUntaggedEntities`). Normally runs automatically
 * during consolidate; this lets the janitor be run manually (e.g. to
 * tag a live memory.json without waiting for the next consolidate pass).
 *
 * Usage:
 *   bun src/cli/tag-entities.ts
 *
 * Exit codes:
 *   0  ran successfully (whether or not anything was tagged)
 *   1  no memory store found
 */

import { join } from "node:path";
import { readMemory, writeMemory } from "../memory/memory";
import { tagUntaggedEntities } from "../memory/tag-entities";
import type { CoreMemory } from "../memory/memory";

export type OutputFn = (msg: string) => void;

export interface TagEntitiesCliOpts {
  out?: OutputFn;
  readMemory?: typeof readMemory;
  writeMemory?: typeof writeMemory;
  tagFn?: typeof tagUntaggedEntities;
  homeBase?: string;
}

function isUntagged(f: { status: string; entities?: { name: string }[] }): boolean {
  return f.status === "active" && (f.entities ?? []).length === 0;
}

export async function runTagEntities(opts: TagEntitiesCliOpts = {}): Promise<number> {
  const out = opts.out ?? ((s: string) => process.stdout.write(s));
  const read = opts.readMemory ?? readMemory;
  const write = opts.writeMemory ?? writeMemory;
  const tag = opts.tagFn ?? tagUntaggedEntities;
  const homeBase = opts.homeBase ?? join(process.env.HOME ?? "", ".siltpoke");

  let before: CoreMemory | null;
  try {
    before = await read(homeBase);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke tag-entities: read failed: ${msg}\n`);
    return 1;
  }

  if (before === null) {
    out("no memory store found\n");
    return 1;
  }

  const untaggedCount = before.facts.filter(isUntagged).length;
  if (untaggedCount === 0) {
    out("nothing to tag\n");
    return 0;
  }

  const after = await tag(before, { homeBase });

  // The janitor is idempotent: on a malformed/failed LLM reply it degrades to
  // returning the SAME memory object unchanged (tag-entities.ts). Only write
  // when something actually changed — a no-op write would round-trip the whole
  // store (global.json/project.json under the v3 layout) for nothing.
  const remainingUntagged = after.facts.filter(isUntagged).length;
  const tagged = untaggedCount - remainingUntagged;

  if (tagged === 0) {
    out("nothing to tag\n");
    return 0;
  }

  try {
    await write(homeBase, after);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    out(`siltpoke tag-entities: write failed: ${msg}\n`);
    return 1;
  }

  out(`tagged ${tagged} facts\n`);
  return 0;
}

if (import.meta.main) {
  const homeBase = join(process.env.HOME ?? "", ".siltpoke");
  const code = await runTagEntities({ homeBase });
  process.exit(code);
}
