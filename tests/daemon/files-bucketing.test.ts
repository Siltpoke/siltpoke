/** B-fix: files/search endpoints must resolve buckets by the KEYSPACE'S OWN
 * definition (bucket = projection path prefix), not a private "segment after
 * the root" heuristic.
 *
 * RED on pre-fix code: a repo whose files live at TOP LEVEL (`scripts/x.py`,
 * no `src/`) — the plc shape — gets `subdirIdOfPath("scripts/x.py") =
 * "x.py"` ≠ bucket id `scripts` → /files returns 0 files for a bucket the
 * projection says holds them ("badge says N, door opens to 0").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(hash: string, nodes: unknown[], edges: unknown[] = []): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-files-bucket-"));
  tmps.push(home);
  const root = join(home, "proj");
  mkdirSync(root, { recursive: true });
  const storage = join(home, "repo-memory", hash);
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(storage, "graph.json"), JSON.stringify({ schemaVersion: 1, nodes, edges }));
  writeFileSync(join(storage, "fingerprints.json"), JSON.stringify({ schemaVersion: 1, files: {} }));
  writeFileSync(join(storage, "queryIndex.json"), JSON.stringify({
    schemaVersion: 1,
    name_to_node_ids: Object.fromEntries(
      (nodes as Array<{ type: string; name: string; id: string }>)
        .filter((n) => n.type === "file")
        .map((n) => [n.name, [n.id]]),
    ),
    path_to_node_ids: {},
  }));
  writeFileSync(join(storage, "meta.json"), JSON.stringify({
    schemaVersion: 1, project_root: root, proj_hash: hash,
    last_indexed_ts: "2026-06-10T00:00:00Z", build_duration_ms: 1,
    counters: { nodes: { file: 2, function: 2, class: 0, symbol: 0 }, edges: { imports: 0 } },
  }));
  return { home, root };
}

function fileNode(path: string) {
  return { id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, 20] };
}
function fnNode(path: string, name: string) {
  return { id: `function:${path}:${name}`, type: "function", name, path, lineRange: [2, 8], signature: `def ${name}()` };
}

function mount(home: string): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: home, home, secret: "s" });
  return app;
}

describe("files endpoint resolves buckets by the keyspace, not a path-shape heuristic", () => {
  test("TOP-LEVEL-files repo (plc shape): /files?subdir=<bucket id> returns its files (≥1)", async () => {
    const { home } = seed("aaaa11112222", [
      fileNode("scripts/builder_stats.py"),
      fnNode("scripts/builder_stats.py", "collect"),
      fileNode("scripts/validate.py"),
      fnNode("scripts/validate.py", "validate"),
    ]);
    const res = await mount(home).request("/api/repo-graph/files?repo=aaaa11112222&subdir=scripts");
    const body = (await res.json()) as { data: { files: Array<{ path: string }> } };
    // pre-fix subdirIdOfPath("scripts/x.py")="x.py" ≠
    // "scripts" → files:[] — the badge-says-N-door-opens-0 bug.
    expect(body.data.files.length).toBeGreaterThanOrEqual(1);
    expect(body.data.files.map((f) => f.path).sort()).toEqual([
      "scripts/builder_stats.py",
      "scripts/validate.py",
    ]);
  });

  test("regression: 3-level src/<subdir>/<file> repo keeps working", async () => {
    const { home } = seed("bbbb33334444", [
      fileNode("src/alpha/a.ts"),
      fnNode("src/alpha/a.ts", "fa"),
      fileNode("src/beta/b.ts"),
      fnNode("src/beta/b.ts", "fb"),
    ]);
    const res = await mount(home).request("/api/repo-graph/files?repo=bbbb33334444&subdir=alpha");
    const body = (await res.json()) as { data: { files: Array<{ path: string }> } };
    expect(body.data.files.map((f) => f.path)).toEqual(["src/alpha/a.ts"]);
  });

  test("search hits on a top-level repo carry the KEYSPACE bucket id (drill target)", async () => {
    const { home } = seed("cccc55556666", [
      fileNode("scripts/builder_stats.py"),
      fnNode("scripts/builder_stats.py", "collect"),
      fileNode("scripts/validate.py"),
      fnNode("scripts/validate.py", "validate"),
    ]);
    const res = await mount(home).request("/api/repo-graph/search?repo=cccc55556666&q=builder_stats");
    const body = (await res.json()) as { data: { hits: Array<{ kind: string; subdir: string; path?: string }> } };
    const fileHit = body.data.hits.find((h) => h.kind === "file");
    expect(fileHit).toBeDefined();
    // ── RED: pre-fix subdir = "builder_stats.py" (the filename), not the bucket.
    expect(fileHit!.subdir).toBe("scripts");
  });
});

// ── Reverse guard, daemon+web scope (extends subdir-resolve's discipline:
// the explain-layer guard only covered the readout; the THIRD private copy
// — daemon's subdirIdOfPath — lived because no guard looked here). ──────────
import { readFileSync, readdirSync, statSync } from "node:fs";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}
const SRC = join(import.meta.dir, "../../src");

describe("reverse guard — no private bucket derivation / display-route lies outside the keyspace", () => {
  test("the deleted subdirIdOfPath never returns as an IDENTIFIER (src/, whole tree)", () => {
    for (const f of walk(SRC)) {
      const code = readFileSync(f, "utf8");
      // identifier USE (call or decl), not the historical mention in a comment
      const used = /(?:function\s+subdirIdOfPath|subdirIdOfPath\s*\()/.test(code);
      expect({ file: f.slice(SRC.length), used }).toEqual({ file: f.slice(SRC.length), used: false });
    }
  });

  test('no "src/"-prefixed display-route string building in daemon/web (buckets are not all under src/)', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (!/\/(daemon|web)\//.test(f)) continue;
      const code = readFileSync(f, "utf8");
      code.split("\n").forEach((line, i) => {
        const stripped = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        // ANY string literal ending in `src/` that concatenates/interpolates an
        // id is a display-route lie — incl. mid-string forms ("What src/" + …).
        if (/src\/["'`]\s*\+|src\/\$\{/.test(stripped)) offenders.push(`${f.slice(SRC.length)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
