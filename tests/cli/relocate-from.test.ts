import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runRelocate } from "../../src/cli/relocate";
import {
  resolveProjectRoot,
  emptyProject,
  writeProject,
  readProject,
} from "../../src/memory/project";

let home: string;
let oldRoot: string;
let newRoot: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-relfrom-home-"));
  oldRoot = mkdtempSync(join(tmpdir(), "siltpoke-relfrom-old-"));
  newRoot = mkdtempSync(join(tmpdir(), "siltpoke-relfrom-new-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(oldRoot, { recursive: true, force: true });
  rmSync(newRoot, { recursive: true, force: true });
});

function hashId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

describe("runRelocate --from", () => {
  test("rejects --from without a value", async () => {
    let err = "";
    const code = await runRelocate({
      argv: ["--from"],
      cwd: oldRoot,
      homeBase: home,
      out: () => {},
      err: (s) => (err += s),
    });
    expect(code).toBe(3);
    expect(err).toMatch(/--from requires/);
  });

  test("uses --from path's hash to look up the project", async () => {
    // Seed memory at the OLD git-derived project_id.
    mkdirSync(join(oldRoot, ".git"));
    const oldResolved = resolveProjectRoot(oldRoot);
    await writeProject(home, oldResolved.project_id, emptyProject(oldResolved));

    // Now simulate: user moved the directory and cwd no longer resolves to
    // the same project_id. Pass --from <oldRoot> to recover.
    let out = "";
    const code = await runRelocate({
      argv: ["--from", oldRoot, newRoot],
      cwd: newRoot,
      homeBase: home,
      out: (s) => (out += s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out).toContain(oldResolved.project_id);

    // Memory still at the old project_id, with project_root flipped.
    const p = await readProject(home, oldResolved.project_id);
    expect(p?.project_root).toBe(newRoot);
  });

  test("recomputes hash exactly matching internal hashId", async () => {
    // The CLI's hash must match what resolveProjectRoot would have produced.
    mkdirSync(join(oldRoot, ".git"));
    const oldResolved = resolveProjectRoot(oldRoot);
    expect(hashId(oldRoot)).toBe(oldResolved.project_id);
  });

  test("--from doesn't require a marker — works for plain git renames", async () => {
    mkdirSync(join(oldRoot, ".git"));
    const oldResolved = resolveProjectRoot(oldRoot);
    await writeProject(home, oldResolved.project_id, emptyProject(oldResolved));

    // newRoot has no .git and no marker — fallback resolution.
    const code = await runRelocate({
      argv: ["--from", oldRoot, newRoot],
      cwd: newRoot,
      homeBase: home,
      out: () => {},
      err: () => {},
    });
    expect(code).toBe(0);
  });

  test("returns 1 with helpful hint if no memory at the new resolved id (no --from given)", async () => {
    mkdirSync(join(oldRoot, ".git"));
    const oldResolved = resolveProjectRoot(oldRoot);
    await writeProject(home, oldResolved.project_id, emptyProject(oldResolved));

    let err = "";
    const code = await runRelocate({
      argv: [newRoot],
      cwd: newRoot,
      homeBase: home,
      out: () => {},
      err: (s) => (err += s),
    });
    expect(code).toBe(1);
    expect(err).toMatch(/try --from/);
  });

  test("output shows the project's PREVIOUS project_root, not just the resolved one", async () => {
    mkdirSync(join(oldRoot, ".git"));
    const oldResolved = resolveProjectRoot(oldRoot);
    const seeded = emptyProject(oldResolved);
    await writeProject(home, oldResolved.project_id, seeded);

    let out = "";
    await runRelocate({
      argv: ["--from", oldRoot, newRoot],
      cwd: newRoot,
      homeBase: home,
      out: (s) => (out += s),
      err: () => {},
    });
    expect(out).toContain(oldRoot);
    expect(out).toContain(newRoot);
    expect(out).toContain(oldResolved.project_id);
  });
});
