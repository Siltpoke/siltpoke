// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Positive control for the daemon's per-request project resolution (T5).
 *
 * The daemon runs detached under launchd, so process.cwd() === "/". Before
 * this fix, `/memory` read `readMemory(homeBase)` — an un-scoped read that
 * resolves `process.cwd()` internally and returns the empty "/" project
 * slice. This test forces `process.cwd()` to "/" and asserts the route still
 * surfaces the pinned project's facts via `resolveRequestProject`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountMemoryRoutes } from "../../../src/web/routes/memory";
import { emptyProject, writeProject, resolveProjectRoot } from "../../../src/memory/project";
import { writeProjectPin } from "../../../src/state/project-pin";
import { writeGlobal, emptyGlobal } from "../../../src/memory/global";
import { computeProjHash } from "../../../src/repo-graph/proj-hash";
import type { Fact } from "../../../src/memory/memory";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
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

describe("/memory under cwd=/", () => {
  test("reads the pinned project's facts, not the / slice", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-mem-home-"));
    dirs.push(home);
    const projectRoot = mkdtempSync(join(tmpdir(), "siltpoke-mem-proj-"));
    dirs.push(projectRoot);

    // readMemory only takes the v3 merged (project-scoped) path when
    // global.json exists — seed it so the scope actually gets exercised.
    await writeGlobal(home, emptyGlobal());

    // Same identity resolveMemoryV3Merged will re-derive for `scope` — write
    // the project store under exactly this project_id so the two resolutions
    // land on the same file.
    const resolved = resolveProjectRoot(projectRoot);
    const p = emptyProject(resolved);
    p.facts = [makeFact({ id: "f1", text: "pinned-project-fact" })];
    await writeProject(home, resolved.project_id, p);

    // Pin keyed by the 12-char repo-graph hash (what resolveDaemonProject
    // matches against), not the project_id.
    await writeProjectPin(home, computeProjHash(projectRoot));

    const realCwd = process.cwd();
    process.chdir("/"); // simulate launchd
    try {
      const app = new Hono();
      mountMemoryRoutes(app, { homeBase: home, secret: "" });
      // A bare "/memory" (no ?repo=) now 302s once — the one-time canonical
      // seed redirect promotes the pinned project's proj_hash into the URL
      // (see src/web/routes/memory.tsx). Follow it exactly once: this also
      // pins down that the redirect target itself renders the pinned
      // project's content rather than looping or falling back to "/".
      let res = await app.request("/memory");
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location).toContain("?repo=");
      res = await app.request(location);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("pinned-project-fact");
    } finally {
      process.chdir(realCwd);
    }
  });
});
