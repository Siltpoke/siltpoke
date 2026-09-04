// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET /memory (SSR) — the rendered timeline must carry the RESOLVED PROJECT's
 * critiques, not the home base's.
 *
 * Same defect as the /api/memory-log route: the critic writes critiques
 * project-local while this route passed a bare `homeBase` to the loader.
 * The SSR route has no injection point, so this exercises the real project
 * store, the real resolver and the real disk loader end to end.
 * See an internal design note
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mountMemoryRoutes } from "../../../src/web/routes/memory";
import { emptyProject, resolveProjectRoot, writeProject } from "../../../src/memory/project";
import { computeProjHash } from "../../../src/repo-graph/proj-hash";

const HOME_MARKER = "HOME-BASE-CRITIQUE-MARKER";
const PROJECT_MARKER = "PROJECT-CRITIQUE-MARKER";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function writeCritiqueFile(base: string, id: string, ts: string, body: string): void {
  const dir = join(base, "critiques", "archive", ts.slice(0, 10));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\ntimestamp: ${ts}\nseverity: warn\n---\n\n## Critique (for Claude)\n\n\`\`\`\n${body}\n\`\`\`\n`,
    "utf8",
  );
}

/**
 * A home base with one registered project. Each base carries one critique whose
 * body is a distinct marker, so the rendered HTML says which base was walked.
 */
async function makeFixture(): Promise<{ homeBase: string; projHash: string }> {
  const homeBase = mkdtempSync(join(tmpdir(), "siltpoke-ssr-critbase-home-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "siltpoke-ssr-critbase-proj-"));
  dirs.push(homeBase, projectRoot);

  const resolved = resolveProjectRoot(projectRoot);
  await writeProject(homeBase, resolved.project_id, emptyProject(resolved));

  writeCritiqueFile(homeBase, "c-home01", "2026-09-01T10:00:00.000Z", HOME_MARKER);
  writeCritiqueFile(
    join(projectRoot, ".siltpoke"),
    "c-proj01",
    "2026-09-02T10:00:00.000Z",
    PROJECT_MARKER,
  );

  return { homeBase, projHash: computeProjHash(resolved.project_root) };
}

describe("GET /memory critique base", () => {
  test("renders the resolved project's critiques, not the home base's", async () => {
    const { homeBase, projHash } = await makeFixture();
    const app = new Hono();
    mountMemoryRoutes(app, { homeBase });

    const res = await app.request(`/memory?repo=${projHash}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain(PROJECT_MARKER);
    expect(html).not.toContain(HOME_MARKER);
  });
});
