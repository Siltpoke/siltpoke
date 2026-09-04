// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Positive control for the daemon's per-request project resolution (T6 —
 * Home dashboard).
 *
 * `getHomeData` used to call `readMemory(basePath)` with no scope, which
 * under the daemon's frozen launchd cwd (`/`) reads the empty "/" project
 * slice. This test injects `memoryScope` directly (unit-level — no
 * process.chdir needed since the route-level wiring is exercised in
 * home.route.test.ts) and asserts the scoped project's fact surfaces in the
 * returned data, not a cwd-derived slice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyGlobal, writeGlobal } from "../../../src/memory/global";
import type { Fact } from "../../../src/memory/memory";
import { emptyProject, resolveProjectRoot, writeProject } from "../../../src/memory/project";
import { getHomeData } from "../../../src/web/screens/Home.data";

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

describe("getHomeData memoryScope", () => {
  test("facts come from the scoped project, not the global/cwd slice", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-home-home-"));
    dirs.push(home);
    const projectRoot = mkdtempSync(join(tmpdir(), "siltpoke-home-proj-"));
    dirs.push(projectRoot);

    // readMemory only takes the v3 merged (project-scoped) path when
    // global.json exists — seed it so the scope actually gets exercised.
    await writeGlobal(home, emptyGlobal());

    // Same identity readMemoryV3Merged will re-derive for `memoryScope` —
    // write the project store under exactly this project_id so the two
    // resolutions land on the same file.
    const resolved = resolveProjectRoot(projectRoot);
    const p = emptyProject(resolved);
    p.facts = [makeFact({ id: "f1", text: "scoped-home-fact" })];
    await writeProject(home, resolved.project_id, p);

    const data = await getHomeData({ basePath: home, memoryScope: projectRoot });
    expect(JSON.stringify(data)).toContain("scoped-home-fact");
  });
});
