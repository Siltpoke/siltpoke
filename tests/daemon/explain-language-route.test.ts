/**
 * Defect [41], the daemon half: both routes that run an explanation read the
 * language from the SAME siltpoke home the daemon was given.
 *
 * `runExplain` falls back to `siltpokeRoot()` when it is not told the home. The
 * two routes passed the home for the cost ledger and not for anything else, so
 * a daemon started on another home would bill one directory and read the
 * language from another. The language here is zh-CN precisely because the
 * default is English: a route that reads the wrong directory fails this test
 * instead of passing by accident.
 *
 * Run: bun test tests/daemon/explain-language-route.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { resolveRepoGraphLocation } from "../../src/repo-graph/proj-hash";
import { writeFingerprints, writeGraph, writeMeta, writeQueryIndex } from "../../src/repo-graph/store";
import { emptyCounters, emptyFingerprints } from "../../src/repo-graph/types";

const SECRET = "test-secret";
const NODE = "function:src/a.ts:doThing";
const FILE = "file:src/a.ts:";

let tmp: string;
let cwd: string;
let home: string;
/** Every system prompt the fake Brain was handed. */
let prompts: string[];
/** Every working directory the fake Brain was told to run in (defect [83]). */
let cwds: Array<string | undefined>;
/** The project root the active graph records. */
let projectRoot: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-explain-lang-route-"));
  cwd = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ name: "Bangbang", species: "cat", language: "zh-CN" }));
  prompts = [];
  cwds = [];
  const { storage_dir, project_root, proj_hash } = resolveRepoGraphLocation(cwd, { home });
  projectRoot = project_root;
  await writeGraph(storage_dir, {
    schemaVersion: 1,
    nodes: [
      { id: FILE, type: "file", name: "a.ts", path: "src/a.ts", lineRange: [1, 3] },
      { id: NODE, type: "function", name: "doThing", path: "src/a.ts", lineRange: [1, 3] },
    ],
    edges: [{ id: `${FILE}::contains::${NODE}`, source: FILE, target: NODE, type: "contains", weight: 1 }],
  });
  await writeQueryIndex(storage_dir, {
    schemaVersion: 1,
    name_to_node_ids: { doThing: [NODE] },
    path_to_node_ids: { "src/a.ts": [FILE, NODE] },
  });
  await writeFingerprints(storage_dir, emptyFingerprints());
  await writeMeta(storage_dir, {
    schemaVersion: 1,
    project_root,
    proj_hash,
    last_indexed_ts: "2026-06-01T10:00:00.000Z",
    build_duration_ms: 1,
    counters: emptyCounters(),
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function app(): Hono {
  const a = new Hono();
  mountRepoGraphRoutes(a, {
    cwd,
    home,
    secret: SECRET,
    explainSourceProvider: async () => "export function doThing() {\n  return 1;\n}\n",
    explainBrainProvider: async ({ systemPrompt, cwd: brainCwd }) => {
      prompts.push(systemPrompt);
      cwds.push(brainCwd);
      return {
        markdown: "# doThing\n\nDoes the thing at [src/a.ts:1].\n",
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: 0.001 },
      };
    },
  });
  return a;
}

const post = (a: Hono, path: string, body: unknown) =>
  a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Siltpoke-Secret": SECRET },
    body: JSON.stringify(body),
  });

describe("the language the daemon's explain routes send (defect [41])", () => {
  test("the trace card's purpose uses the given home's language", async () => {
    const res = await post(app(), "/api/repo-graph/trace/purpose", { node: NODE });
    expect(res.status).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("in Simplified Chinese (中文)");
  });

  test("the detached explain uses the given home's language", async () => {
    const res = await post(app(), "/api/repo-graph/explain", { target: "src/a.ts:doThing" });
    expect(res.ok).toBe(true);
    // The run is detached: wait for the Brain to be called, with a ceiling.
    for (let i = 0; i < 200 && prompts.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("in Simplified Chinese (中文)");
  });
});

describe("the folder the daemon's explain routes run the Brain in (defect [83])", () => {
  test("the trace card's purpose runs in the active project", async () => {
    const res = await post(app(), "/api/repo-graph/trace/purpose", { node: NODE });
    expect(res.status).toBe(200);
    expect(cwds).toEqual([projectRoot]);
    expect(projectRoot).not.toBe(process.cwd());
  });

  test("the detached explain runs in the active project", async () => {
    const res = await post(app(), "/api/repo-graph/explain", { target: "src/a.ts:doThing" });
    expect(res.ok).toBe(true);
    for (let i = 0; i < 200 && cwds.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(cwds).toEqual([projectRoot]);
  });
});
