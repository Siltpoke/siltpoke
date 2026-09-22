/**
 * The REAL indexer child, started from a folder inside a repo, must write its
 * index under the very hash the endpoint's `done` event names.
 *
 * Why a real spawn: the route tests inject a stub runner, and the stub cannot
 * disagree with the route about where the index lands — that disagreement is
 * the whole bug. The route hashed the picked folder; the child walked up to
 * `.git` and wrote the repo under the repo root's hash; the dashboard followed
 * `done` to a hash nothing had been written under and said "This project no
 * longer exists" (2026-09-13, GildedRose-Refactoring-Kata/TypeScript). Only the
 * two real halves together can see that. As of 2026-09-14 the index lands on
 * the picked folder itself, not the enclosing repo.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";

const SECRET = "test-secret-token";
let allowRoot: string;
let home: string;

beforeEach(() => {
  allowRoot = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-idx-real-root-")));
  home = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-idx-real-home-")));
  writeFileSync(join(home, "config.json"), JSON.stringify({ index: { allowRoots: [allowRoot] } }));
});

afterEach(() => {
  rmSync(allowRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("POST /api/repo-graph/index — real child, folder inside a repo", () => {
  test("the index is stored under the hash `done` names, and it is the picked folder's own index", async () => {
    const repo = join(allowRoot, "kata");
    const sub = join(repo, "TypeScript");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "app.ts"), "export function update(): number {\n  return 1;\n}\n");
    writeFileSync(join(repo, "root.ts"), "export const outside = 2;\n");

    // No indexRunner → the production runner, spawning src/cli/index-repo.ts.
    const app = new Hono();
    mountRepoGraphRoutes(app, { cwd: repo, home, secret: SECRET });
    const res = await app.fetch(
      new Request("http://localhost/api/repo-graph/index", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
        body: JSON.stringify({ path: sub }),
      }),
    );
    const body = await res.text();
    const done = /event: done\ndata: (.+)/.exec(body);
    // Quote the stream on failure — an `error` frame carries the child's own
    // last stderr line, which is the only clue to why a spawn went wrong.
    expect(done, body).not.toBeNull();
    const hash = (JSON.parse(done![1]!) as { hash: string }).hash;

    const metaPath = join(home, "repo-memory", hash, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { project_root: string; proj_hash: string; repo_root?: string };
    expect(meta.project_root).toBe(sub);
    expect(meta.proj_hash).toBe(hash);
    expect(meta.repo_root).toBe(repo);
    const graph = JSON.parse(readFileSync(join(home, "repo-memory", hash, "graph.json"), "utf8")) as {
      nodes: Array<{ type: string; path: string }>;
    };
    expect(graph.nodes.filter((n) => n.type === "file").map((n) => n.path)).toEqual(["app.ts"]);
  }, 60_000);
});
