/**
 * Unify repo stores — `/siltpoke-index` must ALSO register the repo in the
 * memory-project store so it appears in the dashboard Memory rail.
 *
 * Exercises the real CLI subprocess (`import.meta.main`) end-to-end with an
 * isolated SILTPOKE_HOME so the index and the register both land in a temp dir.
 */
import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listActiveProjects, resolveProjectRoot } from "../../src/memory/project";

let tmp: string;
let projectRoot: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-index-reg-"));
  projectRoot = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(projectRoot, "src", "foo.ts"), "export function foo() { return 1; }\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "index-repo.ts");

describe("/siltpoke-index registers the repo in the Memory rail", () => {
  test("an indexed repo appears in listActiveProjects", async () => {
    // Before: no memory-project store exists for this repo.
    expect(await listActiveProjects(home)).toEqual([]);

    const proc = Bun.spawn(["bun", CLI], {
      cwd: projectRoot,
      env: { ...process.env, SILTPOKE_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).toBe(0);

    // After: the repo is registered and joins its repo-graph identity.
    // The subprocess's process.cwd() canonicalizes symlinks (macOS /var → /private/var),
    // so resolve the identity against the realpath the subprocess actually used.
    const canonical = realpathSync(projectRoot);
    const list = await listActiveProjects(home);
    const expectedId = resolveProjectRoot(canonical).project_id;
    expect(list.map((p) => p.project_id)).toContain(expectedId);
    const row = list.find((p) => p.project_id === expectedId);
    expect(row?.project_root).toBe(canonical);
  }, 30_000);
});
