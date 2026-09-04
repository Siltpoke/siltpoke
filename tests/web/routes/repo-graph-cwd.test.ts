/**
 * `/repo-graph` SSR default resolution + stale banner (daemon cwd-durable
 * project resolution track, task 9).
 *
 * The daemon runs detached under launchd where process.cwd() === "/", so the
 * old default resolution (`resolveRepoGraphLocation(cwd, { home })` when no
 * `?repo=` is given) computed a proj_hash for "/" that never matches a real
 * repo. This pins the replacement: the SSR route now prefers the shared
 * per-request resolver (`resolveRequestProject`) for its default, and renders
 * an honest "no longer exists" banner (not a silent 302 to repos[0]) when an
 * explicit `?repo=` doesn't match anything in the indexed registry.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphWebRoutes } from "../../../src/web/routes/repo-graph";
import { emptyProject, writeProject, resolveProjectRoot } from "../../../src/memory/project";
import { writeProjectPin } from "../../../src/state/project-pin";
import { writeGlobal, emptyGlobal } from "../../../src/memory/global";
import { computeProjHash } from "../../../src/repo-graph/proj-hash";
import { writeMeta } from "../../../src/repo-graph/store";
import { emptyCounters } from "../../../src/repo-graph/types";
import type { Fact } from "../../../src/memory/memory";

test("dead ?repo= renders stale banner, not a 302 fallthrough", async () => {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-rg-home-"));
  try {
    const app = new Hono();
    mountRepoGraphWebRoutes(app, { cwd: "/", home });
    const res = await app.request("/repo-graph?repo=ffffffffffff", { redirect: "manual" });
    expect(res.status).not.toBe(302);
    expect(await res.text()).toContain("no longer exists");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeFact(overrides: Partial<Fact> & Pick<Fact, "id" | "text">): Fact {
  return {
    source_session_id: null,
    confidence: 0.9,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    last_seen_at: "2026-01-01T00:00:00Z",
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    ...overrides,
  };
}

test("no ?repo= resolves the PINNED project, not repos[0], under cwd=/", async () => {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-rg-home2-"));
  const projectRootA = mkdtempSync(join(tmpdir(), "siltpoke-rg-proj-a-"));
  const projectRootB = mkdtempSync(join(tmpdir(), "siltpoke-rg-proj-b-"));
  try {
    const hashA = computeProjHash(projectRootA);
    const hashB = computeProjHash(projectRootB);

    // Index BOTH repos so `repos[0]` (the fallback the fix must beat) is
    // deterministically repo B: enumerateRepos sorts recency-first, so B's
    // last_indexed_ts must be strictly newer than A's — this is what makes
    // "resolved to the pin" distinguishable from "just picked repos[0]".
    await writeMeta(join(home, "repo-memory", hashA), {
      schemaVersion: 1,
      project_root: projectRootA,
      proj_hash: hashA,
      last_indexed_ts: "2026-01-01T00:00:00.000Z",
      build_duration_ms: 1,
      counters: emptyCounters(),
      building: false,
    });
    await writeMeta(join(home, "repo-memory", hashB), {
      schemaVersion: 1,
      project_root: projectRootB,
      proj_hash: hashB,
      last_indexed_ts: "2026-06-01T00:00:00.000Z",
      build_duration_ms: 1,
      counters: emptyCounters(),
      building: false,
    });

    // Seed the session registry + pin so resolveRequestProject (the shared
    // per-request resolver) resolves project A as "sticky" — mirrors
    // memory-cwd.test.ts's pin+project fixture construction verbatim.
    await writeGlobal(home, emptyGlobal());
    const resolved = resolveProjectRoot(projectRootA);
    const p = emptyProject(resolved);
    p.facts = [makeFact({ id: "f1", text: "pinned-project-fact" })];
    await writeProject(home, resolved.project_id, p);
    await writeProjectPin(home, hashA);

    const realCwd = process.cwd();
    process.chdir("/"); // simulate launchd
    try {
      const app = new Hono();
      mountRepoGraphWebRoutes(app, { cwd: "/", home });
      const res = await app.request("/repo-graph");
      const html = await res.text();
      // Non-vacuous positive control: under the shared enumerateRepos
      // comparator (recency-first), repos[0] is B, not A. If the route
      // ignored resolveRequestProject and fell back to cwd/repos[0] (the
      // pre-fix behavior), this would render currentProjHash=B — so the
      // assertion fails without the fix.
      expect(html).toContain(`currentProjHash&quot;:&quot;${hashA}`);
      expect(html).not.toContain(`currentProjHash&quot;:&quot;${hashB}`);
    } finally {
      process.chdir(realCwd);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRootA, { recursive: true, force: true });
    rmSync(projectRootB, { recursive: true, force: true });
  }
});
