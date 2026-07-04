// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// One-time idempotent backfill of the fact `kind` field.
//
// The Brain/critic recall reads the PERSISTED `kind` (style vs profile); this
// seeds it once for legacy / untagged facts so the classifier never runs on the
// injection path. Called at daemon startup: it writes only when something is
// untagged, so after the first run it's a cheap no-op read.
import { readMemory, writeMemory } from "./memory";
import { backfillFactKind } from "./recall";

/**
 * Ensure every fact has a `kind`. Reads the store, classifies any untagged fact,
 * and persists — but ONLY when at least one fact needed tagging (idempotent:
 * a fully-tagged store is left untouched, no write). Returns whether it wrote.
 */
export async function ensureFactKinds(homeBase: string): Promise<boolean> {
  const memory = await readMemory(homeBase);
  if (!memory) return false;
  const needsTag = memory.facts.some(
    (f) => f.kind !== "style" && f.kind !== "profile",
  );
  if (!needsTag) return false;
  await writeMemory(homeBase, backfillFactKind(memory));
  return true;
}
