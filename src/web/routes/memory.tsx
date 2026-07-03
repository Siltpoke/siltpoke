// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Hono } from "hono";
import { join } from "node:path";
import { homedir } from "node:os";
import { Memory } from "../screens/Memory";
import { Layout } from "../_shared/layout";
import { loadMemoryEvents } from "../../memory/memory-log-loader";
import { readMemory } from "../../memory/memory";
import { listActiveProjects, resolveProjectRoot } from "../../memory/project";
import { loadRepoCard } from "../../repo-graph/repo-card";
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
    // Single disk read shared by both consumers: loadMemoryEvents (facts +
    // critiques + learned_rules) and the working-memory panel (chat_sessions).
    // Injecting the cached result into loadMemoryEvents avoids a second disk
    // round-trip and prevents snapshot inconsistency between the two panels.
    let memory = await readMemory(homeBase).catch(() => null);

    let events: MemoryEvent[];
    try {
      events = await loadMemoryEvents(homeBase, {
        readMemory: async () => memory,
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
    let currentProjectId = "";
    try {
      currentProjectId = resolveProjectRoot(process.cwd()).project_id;
    } catch {
      currentProjectId = "";
    }

    return c.html(
      <Layout title="Memory · siltpoke">
        <Memory
          events={events}
          secret={secret}
          recentChats={recentChats}
          activeProjects={activeProjects}
          currentProjectId={currentProjectId}
          homeDir={homedir()}
        />
      </Layout>,
    );
  });
}
