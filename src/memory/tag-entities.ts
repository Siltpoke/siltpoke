// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * tagUntaggedEntities — consolidate janitor that batch-tags any active facts
 * with no entities (legacy facts predating the entity model + `/remember`
 * facts that never threaded entities through extraction).
 *
 * Mirrors the gated+ledgered Haiku-call precedent in `extract-facts.ts`: ONE
 * batched call maps every untagged fact id to its entities, never throws,
 * and degrades to "leave untagged" on any failure or malformed reply.
 *
 * Idempotent: when there is nothing untagged, returns the SAME memory
 * object and makes no Brain call at all (no a-call-for-nothing spend).
 */

import { z } from "zod";
import type { callBrainRaw } from "../brain/brain";
import { makeRoleRawBrain } from "../brain/role-brain";
import { ledgerBrainCall } from "../state/usage";
import type { CoreMemory, Fact } from "./memory";

const TAG_TIMEOUT_MS = 60_000;
const TAG_SESSION_ID = "entity-janitor";

const TAG_SYSTEM_PROMPT =
  "For each fact below, list the named entities it is about — people, places, " +
  "hobbies, projects, things — as a canonical short name + type " +
  "(person|place|hobby|project|thing|other). Empty list if a fact names nothing. " +
  'Reply with ONLY JSON: {"tags": [{"id": "<fact id>", "entities": [{"name": "...", "type": "..."}]}]}.';

const tagSchema = z.object({
  tags: z.array(
    z.object({
      id: z.string(),
      entities: z.array(
        z.object({
          name: z.string(),
          type: z
            .enum(["person", "place", "hobby", "project", "thing", "other"])
            .nullable()
            .optional(),
        }),
      ),
    }),
  ),
});

export interface TagEntitiesDeps {
  homeBase: string;
  callBrainRaw?: typeof callBrainRaw;
  ledger?: typeof ledgerBrainCall;
}

export async function tagUntaggedEntities(
  memory: CoreMemory,
  deps: TagEntitiesDeps,
): Promise<CoreMemory> {
  const brain = deps.callBrainRaw ?? makeRoleRawBrain(deps.homeBase, "extract");
  const ledger = deps.ledger ?? ledgerBrainCall;

  const untagged = memory.facts.filter(
    (f) => f.status === "active" && (f.entities ?? []).length === 0,
  );
  if (untagged.length === 0) return memory;

  const bundle = untagged.map((f) => `${f.id}\t${f.text}`).join("\n");

  let raw: Awaited<ReturnType<typeof brain>>;
  try {
    raw = await brain({
      systemPrompt: TAG_SYSTEM_PROMPT,
      contextBundle: bundle,
      timeoutMs: TAG_TIMEOUT_MS,
    });
  } catch {
    return memory;
  }

  // Ledger the spend the moment the call returns, before parsing — same
  // honesty precedent as extract-facts.ts (a malformed reply still cost
  // tokens). ledgerBrainCall.session_id is a required string; this janitor
  // runs outside any chat session, so it gets its own fixed marker. No static
  // `model` anymore — see extract-facts.ts for the cost-honesty rationale.
  await ledger(deps.homeBase, {
    kind: "chat_capture",
    session_id: TAG_SESSION_ID,
    usage: raw.usage,
  });

  const parsed = tagSchema.safeParse(raw.output);
  if (!parsed.success) return memory;

  const byId = new Map(parsed.data.tags.map((t) => [t.id, t.entities]));
  const facts: Fact[] = memory.facts.map((f) => {
    const tags = byId.get(f.id);
    return tags && tags.length > 0 ? { ...f, entities: tags } : f;
  });
  return { ...memory, facts };
}
