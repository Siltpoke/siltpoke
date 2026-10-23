// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Active-repo resolution + the CLAUDE.md architecture-overlay reader —
 * split out of `repo-graph.tsx` (2026-09-26, Task 6 fix round 1) so
 * `repo-graph-trust.ts` can import `resolveActiveRepo`/`loadOverlay` as
 * plain values without creating an import cycle back into `repo-graph.tsx`
 * (which in turn imports `mountRepoGraphTrustRoute` FROM `repo-graph-trust.ts`
 * to mount it). `repo-graph.tsx` re-imports both from here unchanged — every
 * existing call site in that file keeps working by name.
 *
 * `RepoGraphRouteDeps` stays defined in `repo-graph.tsx` (it carries a pile of
 * route-specific overrides — index runner, Brain providers, task registry —
 * that have no business living beside a small resolver); the `type` import
 * of it below is erased by `dpdm -T` (`audit:cycles`) before cycle detection,
 * so it creates no edge back to `repo-graph.tsx` even though it's a real
 * TypeScript dependency.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { siltpokeRoot } from "../../installer/paths";
import { parseArchitectureSection } from "../../repo-graph/architecture-parser";
import { resolveRepoGraphLocation } from "../../repo-graph/proj-hash";
import { resolveRepoByHash } from "../../repo-graph/repo-registry";
import { resolveRequestProject } from "../project-context";
import type { RepoGraphRouteDeps } from "./repo-graph";

export interface ActiveRepo {
  storage_dir: string;
  project_root: string;
}

/**
 * Resolve the active repo: `?repo=<proj_hash>` if present and known, else the
 * daemon's shared per-request resolver, else the daemon's cwd. Returns null
 * when an explicit `?repo=` isn't indexed.
 */
export async function resolveActiveRepo(
  repo: string | undefined,
  deps: RepoGraphRouteDeps,
): Promise<ActiveRepo | null> {
  if (repo) {
    const loc = await resolveRepoByHash(repo, { home: deps.home });
    if (!loc || !loc.project_root) return null;
    return { storage_dir: loc.storage_dir, project_root: loc.project_root };
  }
  // No explicit repo: prefer the daemon's shared per-request resolver (fixes
  // the launchd frozen-cwd bug — deps.cwd is "/" in production, so
  // computeProjHash(cwd) never matches a real repo); fall back to the raw cwd
  // resolution when the resolver has no pinned/recent project (keeps direct-
  // cwd callers — the repo-graph test suite seeds a fixture AT deps.cwd and
  // expects it resolved without a `?repo=` — working unchanged).
  // Validate the resolver's guess against repo-graph's OWN registry via
  // resolveRepoByHash directly (this route has no pre-loaded `repos` list to
  // check against, unlike the SSR mount's `resolveDefaultProjHash` — same
  // registry, different mechanism; keep both in sync if either changes).
  const proj = await resolveRequestProject(deps.home ?? siltpokeRoot(), undefined);
  if (proj.proj_hash) {
    const loc = await resolveRepoByHash(proj.proj_hash, { home: deps.home });
    if (loc?.project_root) return { storage_dir: loc.storage_dir, project_root: loc.project_root };
  }
  const loc = resolveRepoGraphLocation(deps.cwd, { home: deps.home });
  return { storage_dir: loc.storage_dir, project_root: loc.project_root };
}

/** Read + parse the repo's CLAUDE.md §Architecture overlay (null if absent). */
export async function loadOverlay(projectRoot: string) {
  const claudeMd = join(projectRoot, "CLAUDE.md");
  if (!existsSync(claudeMd)) return null;
  try {
    return parseArchitectureSection(await readFile(claudeMd, "utf8"));
  } catch {
    return null;
  }
}
