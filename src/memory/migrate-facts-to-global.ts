// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// One-time idempotent sweep: relocate stranded user-level facts to the global store.
//
// Before global.facts existed (Leg B / T1), every fact — including user-level
// `style` (language/tone) and `profile` (identity) facts — was stranded in a
// per-project slice. Under launchd (daemon cwd=/) those slices are unreadable,
// so the pet came back with 0 facts. This sweep moves already-stranded
// style/profile facts out of every project slice into the cwd-independent
// global store, so a user's existing facts reappear after upgrade with no
// re-entry. Called at daemon startup right AFTER `ensureFactKinds` (so untagged
// facts are classified style|profile before this classifies them for routing).
//
// Idempotent + write-only-if-changed: nothing stranded → no writes at all;
// running twice is a cheap read-only no-op. Fail-open at the call-site (a sweep
// error must never block daemon start), matching `ensureFactKinds`.
import { dedupeFactsById, isGlobalFact, type Fact } from "./memory";
import { readGlobal, writeGlobal, emptyGlobal } from "./global";
import { listActiveProjects, readProject, writeProject } from "./project";
import type { ProjectMemory } from "./schema-v3";

/**
 * Sweep every per-project slice for user-level facts (`isGlobalFact`) and move
 * them into `global.facts`, deduped by id (global wins on collision). Returns
 * whether anything was migrated (mirrors `ensureFactKinds`'s wrote-flag return).
 *
 * Order guarantees safety: build + write the new global FIRST, then prune each
 * project slice — a fact is removed from its project slice only after it is
 * safely persisted in global.
 */
export async function migrateFactsToGlobal(homeBase: string): Promise<boolean> {
  // `listActiveProjects` enumerates every store under `<home>/projects/` and
  // yields [] on a missing dir (never throws) — the empty/absent-projects no-op.
  const projects = await listActiveProjects(homeBase);
  if (projects.length === 0) return false;

  // Collect each slice's user-level facts + the pruned remainder to write back.
  const slices: { projectId: string; project: ProjectMemory; pruned: Fact[] }[] = [];
  const collected: Fact[] = [];
  for (const { project_id } of projects) {
    const project = await readProject(homeBase, project_id);
    if (!project) continue;
    const globalFacts = project.facts.filter(isGlobalFact);
    if (globalFacts.length === 0) continue;
    const pruned = project.facts.filter((f) => !isGlobalFact(f));
    slices.push({ projectId: project_id, project, pruned });
    collected.push(...globalFacts);
  }

  // Nothing stranded anywhere → idempotent no-op, make NO writes.
  if (collected.length === 0) return false;

  // Existing global wins on id collision (concat global-first, dedupe keeps first).
  const global = (await readGlobal(homeBase)) ?? emptyGlobal();
  const mergedFacts = dedupeFactsById([...global.facts, ...collected]);

  // Write global FIRST, and ONLY if it actually gained facts. A concat that is
  // global-first + first-wins dedupe can only grow the array, so an unchanged
  // length means every collected fact was already in global (nothing new) — skip
  // the global write, but still prune the stranded project copies below.
  if (mergedFacts.length !== global.facts.length) {
    await writeGlobal(homeBase, { ...global, facts: mergedFacts });
  }

  // Then prune the relocated facts from each project slice.
  for (const { projectId, project, pruned } of slices) {
    await writeProject(homeBase, projectId, { ...project, facts: pruned });
  }

  return true;
}
