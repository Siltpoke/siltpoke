import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureProject,
  readProject,
  writeProject,
  emptyProject,
  resolveProjectRoot,
  projectMemoryPath,
  type ResolvedProject,
} from "../../src/memory/project";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function resolved(id: string, root: string, name: string): ResolvedProject {
  return { project_id: id, project_root: root, display_name: name, source: "git" };
}

describe("ensureProject", () => {
  // Registers an empty-but-valid store when none exists.
  test("creates an empty store when none exists (created:true, zero facts)", async () => {
    const r = resolved("abc123def456aaaa", "/code/demo", "demo");
    const result = await ensureProject(home, r);

    expect(result.created).toBe(true);
    expect(result.project_id).toBe("abc123def456aaaa");

    const store = await readProject(home, r.project_id);
    expect(store).not.toBeNull();
    expect(store?.facts).toEqual([]);
    expect(existsSync(projectMemoryPath(home, r.project_id))).toBe(true);
  });

  // A re-register over an existing fact-bearing store is a no-op.
  test("does not clobber an existing store (created:false, facts survive)", async () => {
    const r = resolved("keep0000keep0000", "/code/keep", "keep");
    const seeded = emptyProject(r);
    seeded.facts = [
      {
        id: "f1",
        text: "user prefers tabs",
        source_session_id: null,
        confidence: 1,
        created_at: "2026-06-01T00:00:00Z",
        last_seen_at: "2026-06-01T00:00:00Z",
        supersedes: null,
      } as unknown as (typeof seeded.facts)[number],
    ];
    await writeProject(home, r.project_id, seeded);

    const result = await ensureProject(home, r);

    expect(result.created).toBe(false);
    const store = await readProject(home, r.project_id);
    expect(store?.facts).toHaveLength(1);
    expect(store?.facts[0]?.text).toBe("user prefers tabs");
  });

  // Hash-identity — a cwd string registers under the [:16] project_id,
  // the same identity the repo-graph card resolves against.
  test("accepts a cwd string and registers under resolveProjectRoot's [:16] id", async () => {
    const repo = mkdtempSync(join(tmpdir(), "siltpoke-repo-"));
    mkdirSync(join(repo, ".git"), { recursive: true });

    const result = await ensureProject(home, repo);
    const expectedId = resolveProjectRoot(repo).project_id;

    expect(expectedId).toHaveLength(16);
    expect(result.created).toBe(true);
    expect(result.project_id).toBe(expectedId);
    expect(existsSync(projectMemoryPath(home, expectedId))).toBe(true);

    rmSync(repo, { recursive: true, force: true });
  });

  // Truthful success signal — writeProject swallows fs errors, so a silent write
  // failure must surface as a throw (not a false `created:true`). Force failure by
  // making `<home>/projects` a FILE so the store dir mkdir fails.
  test("throws when the store fails to persist (no false created:true)", async () => {
    writeFileSync(join(home, "projects"), "not a dir");
    const r = resolved("fail0000fail0000", "/code/fail", "fail");
    await expect(ensureProject(home, r)).rejects.toThrow(/did not persist/);
  });
});
