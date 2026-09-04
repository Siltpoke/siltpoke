// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET /api/memory-log — critiques must be read from the RESOLVED PROJECT's
 * .siltpoke, not from the home base.
 *
 * The critic writes every critique project-local
 * (`stateBase = join(event.cwd, ".siltpoke")`, src/hooks/handle-stop.ts), while
 * this route passed a bare `homeBase` to the critique loader — so the Memory
 * Book's episodic half was empty by construction for every project
 * (measured: 1128 entries project-local, 1 from the home base;
 * an internal design note).
 *
 * These tests use the REAL loadAllCritiqueEntries against REAL files on disk —
 * a stubbed loader would prove nothing about which directory is walked.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mountMemoryLogRoute } from "../../../src/daemon/routes/memory-log";
import type { MemoryEvent } from "../../../src/memory/memory-log";

const SECRET = "test-secret-critiques-base";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Write one parseable critique file into `<base>/critiques/archive/<day>/<id>.md`. */
function writeCritiqueFile(base: string, id: string, ts: string, body: string): void {
  const day = ts.slice(0, 10);
  const dir = join(base, "critiques", "archive", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\ntimestamp: ${ts}\nseverity: warn\n---\n\n## Critique (for Claude)\n\n\`\`\`\n${body}\n\`\`\`\n`,
    "utf8",
  );
}

function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/**
 * A home base carrying exactly one critique, and a project root carrying two.
 * The counts differ so a result can never be attributed to the wrong base by
 * coincidence.
 */
function makeBases(): { homeBase: string; projectRoot: string } {
  const homeBase = makeTempDir("siltpoke-critbase-home-");
  const projectRoot = makeTempDir("siltpoke-critbase-proj-");
  writeCritiqueFile(homeBase, "c-home01", "2026-09-01T10:00:00.000Z", "home-base critique body");
  const projectBase = join(projectRoot, ".siltpoke");
  writeCritiqueFile(projectBase, "c-proj01", "2026-09-02T10:00:00.000Z", "project critique one");
  writeCritiqueFile(projectBase, "c-proj02", "2026-09-02T11:00:00.000Z", "project critique two");
  return { homeBase, projectRoot };
}

async function fetchEvents(app: Hono, path: string): Promise<MemoryEvent[]> {
  const res = await app.request(path, { headers: { "X-Siltpoke-Secret": SECRET } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { events: MemoryEvent[] };
  return body.events;
}

describe("/api/memory-log critique base", () => {
  test("serves the resolved project's critiques, not the home base's", async () => {
    const { homeBase, projectRoot } = makeBases();
    const app = new Hono();
    mountMemoryLogRoute(app, {
      homeBase,
      secret: SECRET,
      readMemory: async () => null,
      // loadCritiques intentionally NOT injected — the real disk loader runs.
      resolveScope: async () => projectRoot,
    });

    const events = await fetchEvents(app, "/api/memory-log?repo=abcdef012345");
    const episodicIds = events.filter((e) => e.type === "episodic").map((e) => e.id).sort();

    expect(episodicIds).toEqual(["c-proj01", "c-proj02"]);
    expect(episodicIds).not.toContain("c-home01");
  });

  test("falls back to the home base's critiques when no project resolves", async () => {
    // Positive control: proves the home fixture IS parseable, so its absence
    // above is the base path and not a broken fixture.
    const { homeBase } = makeBases();
    const app = new Hono();
    mountMemoryLogRoute(app, {
      homeBase,
      secret: SECRET,
      readMemory: async () => null,
      resolveScope: async () => null,
    });

    const events = await fetchEvents(app, "/api/memory-log");
    const episodicIds = events.filter((e) => e.type === "episodic").map((e) => e.id);

    expect(episodicIds).toEqual(["c-home01"]);
  });
});
