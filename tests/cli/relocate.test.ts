import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  home = mkdtempSync(join(tmpdir(), "siltpoke-reloc-home-"));
  oldRoot = mkdtempSync(join(tmpdir(), "siltpoke-reloc-old-"));
  newRoot = mkdtempSync(join(tmpdir(), "siltpoke-reloc-new-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(oldRoot, { recursive: true, force: true });
  rmSync(newRoot, { recursive: true, force: true });
});

describe("runRelocate", () => {
  test("returns 3 when no argument given", async () => {
    let err = "";
    const code = await runRelocate({
      argv: [],
      cwd: oldRoot,
      homeBase: home,
      out: () => {},
      err: (s) => (err += s),
    });
    expect(code).toBe(3);
    expect(err).toMatch(/missing/);
  });

  test("returns 1 when new path does not exist", async () => {
    mkdirSync(join(oldRoot, ".git"));
    const resolved = resolveProjectRoot(oldRoot);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    let err = "";
    const code = await runRelocate({
      argv: [join(newRoot, "missing-subdir")],
      cwd: oldRoot,
      homeBase: home,
      out: () => {},
      err: (s) => (err += s),
    });
    expect(code).toBe(1);
    expect(err).toMatch(/does not exist/);
  });

  test("returns 1 when no per-project memory exists yet", async () => {
    mkdirSync(join(oldRoot, ".git"));
    let err = "";
    const code = await runRelocate({
      argv: [newRoot],
      cwd: oldRoot,
      homeBase: home,
      out: () => {},
      err: (s) => (err += s),
    });
    expect(code).toBe(1);
    expect(err).toMatch(/no per-project memory/);
  });

  test("updates project_root in per-project memory.json", async () => {
    mkdirSync(join(oldRoot, ".git"));
    const resolved = resolveProjectRoot(oldRoot);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    let out = "";
    const code = await runRelocate({
      argv: [newRoot],
      cwd: oldRoot,
      homeBase: home,
      out: (s) => (out += s),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out).toContain(resolved.project_id);
    expect(out).toContain(newRoot);

    const p = await readProject(home, resolved.project_id);
    expect(p?.project_root).toBe(newRoot);
  });

  test("updates marker.json when project was resolved via marker", async () => {
    mkdirSync(join(oldRoot, ".siltpoke"));
    writeFileSync(
      join(oldRoot, ".siltpoke", "marker.json"),
      JSON.stringify({
        project_id: "stableid12345678",
        project_root: oldRoot,
        display_name: "myproj",
        written_by: "siltpoke",
        written_at: "2026-05-16T10:00:00Z",
      }),
    );
    const resolved = resolveProjectRoot(oldRoot);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    const code = await runRelocate({
      argv: [newRoot],
      cwd: oldRoot,
      homeBase: home,
      out: () => {},
      err: () => {},
      now: () => new Date("2026-05-17T00:00:00Z"),
    });
    expect(code).toBe(0);

    const marker = JSON.parse(
      readFileSync(join(oldRoot, ".siltpoke", "marker.json"), "utf8"),
    );
    expect(marker.project_id).toBe("stableid12345678");
    expect(marker.project_root).toBe(newRoot);
    expect(marker.written_at).toBe("2026-05-17T00:00:00.000Z");
  });

  test("preserves project_id across relocate", async () => {
    mkdirSync(join(oldRoot, ".git"));
    const resolved = resolveProjectRoot(oldRoot);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    await runRelocate({
      argv: [newRoot],
      cwd: oldRoot,
      homeBase: home,
      out: () => {},
      err: () => {},
    });

    const p = await readProject(home, resolved.project_id);
    expect(p?.project_id).toBe(resolved.project_id);
    expect(existsSync(join(home, "projects", resolved.project_id, "memory.json"))).toBe(true);
  });

  test("does not create a marker if one didn't exist before", async () => {
    mkdirSync(join(oldRoot, ".git"));
    const resolved = resolveProjectRoot(oldRoot);
    await writeProject(home, resolved.project_id, emptyProject(resolved));

    await runRelocate({
      argv: [newRoot],
      cwd: oldRoot,
      homeBase: home,
      out: () => {},
      err: () => {},
    });
    expect(existsSync(join(oldRoot, ".siltpoke", "marker.json"))).toBe(false);
  });
});
