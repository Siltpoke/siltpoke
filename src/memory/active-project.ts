// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @module active-project — the single per-request project resolver for the daemon.
 *
 * The daemon runs detached under launchd, so process.cwd() === "/". This module
 * replaces cwd-based project resolution: a request resolves its project from an
 * explicit ?repo= hash, else a server-side pin, else the most-recently-active
 * repo (liveness-filtered), else global. Reads may use any source; writes are
 * accepted only for `explicit`/`sticky` (see isWriteEligible).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeProjHash } from "../repo-graph/proj-hash";
import { type ActiveProject, listActiveProjects as realListActiveProjects } from "./project";

export type DaemonProjectSource = "explicit" | "sticky" | "recent" | "stale" | "none";

export interface DaemonProject {
  project_id: string | null;
  proj_hash: string | null;
  project_root: string | null;
  display_name: string | null;
  source: DaemonProjectSource;
}

export interface ResolveDaemonProjectInput {
  home: string;
  /** proj_hash from ?repo= — an intentional explicit selection. */
  explicitProjHash?: string;
  /** proj_hash from the server-side pin (last viewed) — a sticky selection. */
  pinnedProjHash?: string;
}

export interface ResolveDaemonProjectDeps {
  listActiveProjects: (home: string) => Promise<ActiveProject[]>;
}

const NONE: DaemonProject = {
  project_id: null,
  proj_hash: null,
  project_root: null,
  display_name: null,
  source: "none",
};

/** A write may only target the user's intentional selection, never a recency guess. */
export function isWriteEligible(source: DaemonProjectSource): boolean {
  return source === "explicit" || source === "sticky";
}

/** Real content = facts OR a repo-graph store. An index-only registration is not "active". */
function hasContent(home: string, p: ActiveProject): boolean {
  if (p.fact_count > 0) return true;
  return existsSync(join(home, "repo-memory", computeProjHash(p.project_root)));
}

function toDaemonProject(p: ActiveProject, source: DaemonProjectSource): DaemonProject {
  return {
    project_id: p.project_id,
    proj_hash: computeProjHash(p.project_root),
    project_root: p.project_root,
    display_name: p.display_name,
    source,
  };
}

function matchLive(projects: ActiveProject[], projHash: string): ActiveProject | undefined {
  return projects.find(
    (p) => existsSync(p.project_root) && computeProjHash(p.project_root) === projHash,
  );
}

export async function resolveDaemonProject(
  input: ResolveDaemonProjectInput,
  deps: ResolveDaemonProjectDeps = { listActiveProjects: realListActiveProjects },
): Promise<DaemonProject> {
  const { home, explicitProjHash, pinnedProjHash } = input;
  const projects = await deps.listActiveProjects(home).catch(() => [] as ActiveProject[]);

  // 1. explicit — reverse-match against the authoritative projects store.
  if (explicitProjHash) {
    const match = matchLive(projects, explicitProjHash);
    if (match) return toDaemonProject(match, "explicit");
    // 2. stale — explicit hash that matches no live project. Never falls through.
    return { ...NONE, source: "stale" };
  }

  // 3. sticky — server-side pin.
  if (pinnedProjHash) {
    const match = matchLive(projects, pinnedProjHash);
    if (match) return toDaemonProject(match, "sticky");
    // dead pin → fall through to recent
  }

  // 4. recent — liveness-filtered, deterministic order.
  const live = projects
    .filter((p) => existsSync(p.project_root) && hasContent(home, p))
    .sort((a, b) => {
      if (a.last_active_at === b.last_active_at) return a.project_id < b.project_id ? -1 : 1;
      if (a.last_active_at === "") return 1;
      if (b.last_active_at === "") return -1;
      return a.last_active_at < b.last_active_at ? 1 : -1;
    });
  const newest = live[0];
  if (newest) return toDaemonProject(newest, "recent");

  // 5. none.
  return NONE;
}
