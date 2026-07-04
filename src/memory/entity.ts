// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { z } from "zod";
import type { Fact } from "./memory";

export type EntityType = "person" | "place" | "hobby" | "project" | "thing" | "other";

export interface EntityRef {
  name: string;
  /** RESERVED — carried for later bridge/star-map layers; not consumed this slice. */
  type?: EntityType | null;
}

export const entityRefSchema: z.ZodType<EntityRef> = z.object({
  name: z.string(),
  type: z
    .enum(["person", "place", "hobby", "project", "thing", "other"])
    .nullable()
    .optional(),
});

/** Grouping key: lowercase + collapse internal runs of whitespace, trimmed. */
export function entityKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface EntityGroup<F = Fact> {
  key: string;
  label: string;
  facts: F[];
}

/**
 * Group active facts by entity. A multi-entity fact appears under each of its
 * entities. Facts with no entities fall into one trailing `key:""` / "未分类"
 * group. Sorted by descending fact count, then label; untagged group always last.
 *
 * Generic over `F` (anything carrying `entities?`) so non-`Fact` shapes —
 * e.g. the client-side `MemoryEventClient` projection — can reuse this same
 * pure grouping logic instead of reimplementing it (single-sourced).
 */
export function groupByEntity<F extends { entities?: EntityRef[] | null }>(
  facts: readonly F[],
): EntityGroup<F>[] {
  const tagged = new Map<string, EntityGroup<F>>();
  const untagged: F[] = [];
  for (const f of facts) {
    const refs = f.entities ?? [];
    if (refs.length === 0) {
      untagged.push(f);
      continue;
    }
    for (const ref of refs) {
      const key = entityKey(ref.name);
      if (!key) {
        untagged.push(f);
        continue;
      }
      const g = tagged.get(key) ?? { key, label: ref.name.trim(), facts: [] };
      g.facts.push(f);
      tagged.set(key, g);
    }
  }
  const groups = [...tagged.values()].sort(
    (a, b) => b.facts.length - a.facts.length || a.label.localeCompare(b.label),
  );
  if (untagged.length > 0) groups.push({ key: "", label: "未分类", facts: untagged });
  return groups;
}
