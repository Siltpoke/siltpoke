// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Hono } from "hono";
import { join } from "node:path";
import { homedir } from "node:os";
import { Memory } from "../screens/Memory";
import { Layout } from "../_shared/layout";
import { loadMemoryEvents } from "../../memory/memory-log-loader";
import { readMemory, GLOBAL_ONLY } from "../../memory/memory";
import { listActiveProjects } from "../../memory/project";
import { loadRepoCard } from "../../repo-graph/repo-card";
import { resolveRequestProject } from "../../daemon/project-context";
import type { ActiveRepoView } from "../../web/primitives/ActiveReposPanel";
import type { MemoryEvent } from "../../memory/memory-log";
import type { ChatSession } from "../../memory/memory";

export interface MemoryRouteDeps {
  homeBase?: string;
  secret?: string;
}

export function mountMemoryRoutes(app: Hono, deps: MemoryRouteDeps = {}): void {
  const homeBase =
    deps.homeBase ??
    process.env.SILTPOKE_HOME ??
    join(homedir(), ".siltpoke");
  const secret = deps.secret ?? "";

  app.get("/memory", async (c) => {
    // Resolve the daemon's per-request project once (the daemon runs under
    // launchd with process.cwd() === "/" — a cwd-based resolve would always
    // read the empty "/" slice). GLOBAL_ONLY when no project resolves.
    const proj = await resolveRequestProject(homeBase, c.req.query("repo"));

    // One-time canonical ?repo= seed redirect: promote a fresh landing's
    // recency/sticky pick to an explicit URL so it's shareable/bookmarkable
    // and survives a reload without re-guessing. Guarded on the `repo` query
    // param being absent so a request that already carries ?repo= (including
    // the redirect target itself) never redirects again — no loop.
    if (c.req.query("repo") === undefined && proj.proj_hash) {
      return c.redirect(`${c.req.path}?repo=${proj.proj_hash}`, 302);
    }

    const scope = proj.project_root ?? GLOBAL_ONLY;

    // Single disk read shared by both consumers: loadMemoryEvents (facts +
    // critiques + learned_rules) and the working-memory panel (chat_sessions).
    // Injecting the cached result into loadMemoryEvents avoids a second disk
    // round-trip and prevents snapshot inconsistency between the two panels.
    let memory = await readMemory(homeBase, scope).catch(() => null);

    let events: MemoryEvent[];
    try {
      events = await loadMemoryEvents(homeBase, {
        readMemory: async () => memory,
        // Critiques are written project-local (writeCritique's stateBase =
        // <cwd>/.siltpoke), so scope the walk to the resolved project. Without
        // this the episodic half of the Memory Book is empty for every project.
        critiquesBase: proj.project_root ? join(proj.project_root, ".siltpoke") : undefined,
      });
    } catch {
      // Gracefully degrade — render empty timeline rather than a 500.
      events = [];
    }

    // Recent chat sessions for the working-memory panel (cap 5, newest-first).
    let recentChats: ChatSession[];
    try {
      recentChats = [...(memory?.chat_sessions ?? [])]
        .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
        .slice(0, 5);
    } catch {
      recentChats = [];
    }

    // Active-repos rail — enumerate every per-project store (derive-on-read,
    // $0); mark the daemon's current project. Degrade to empty on any error.
    // Join each project to its repo-graph card ($0 disk reads; null when the
    // repo was never indexed). loadRepoCard never throws.
    let activeProjects: ActiveRepoView[];
    try {
      const projects = await listActiveProjects(homeBase);
      activeProjects = projects.map((p) => ({ ...p, repo: loadRepoCard(homeBase, p.project_root) }));
    } catch {
      activeProjects = [];
    }
    const currentProjectId = proj.project_id ?? "";

    return c.html(
      <Layout title="Memory · siltpoke" secret={secret} resolvedProjHash={proj.proj_hash}>
        <Memory
          events={events}
          secret={secret}
          recentChats={recentChats}
          activeProjects={activeProjects}
          currentProjectId={currentProjectId}
          homeDir={homedir()}
          resolvedProject={{
            source: proj.source,
            displayName: proj.display_name,
            projHash: proj.proj_hash,
          }}
        />
      </Layout>,
    );
  });
}
