/** siltpoke-generate — SSR authored-model loading.
 *
 * The route loads `.siltpoke/arch-c4.json` from the TARGET repo's project_root
 * (file present = authored; name never consulted — the fixture repo is
 * deliberately NOT named siltpoke), Zod-validates it, and bakes
 * `authoredModel` into the island payload. Malformed file → null model + the
 * visible fail-soft banner. No file → payload null, page unchanged.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphWebRoutes } from "../../../src/web/routes/repo-graph";

const HASH = "aaaabbbbcccc";
let tmp: string;
let projectRoot: string; // deliberately NOT named "siltpoke"
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-authored-c4-"));
  projectRoot = join(tmp, "fixture-authored-repo");
  home = join(tmp, "home");
  mkdirSync(projectRoot, { recursive: true });
  const storage = join(home, "repo-memory", HASH);
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(storage, "graph.json"), JSON.stringify({
    schemaVersion: 1,
    nodes: [
      { id: "file:src/alpha/a.ts:", type: "file", name: "a.ts", path: "src/alpha/a.ts", lineRange: [1, 10] },
      { id: "function:src/alpha/a.ts:fa", type: "function", name: "fa", path: "src/alpha/a.ts", lineRange: [2, 5], signature: "export function fa(): void" },
    ],
    edges: [],
  }));
  writeFileSync(join(storage, "fingerprints.json"), JSON.stringify({ schemaVersion: 1, files: {} }));
  writeFileSync(join(storage, "meta.json"), JSON.stringify({
    schemaVersion: 1, project_root: projectRoot, proj_hash: HASH,
    last_indexed_ts: "2026-06-10T00:00:00Z", build_duration_ms: 1,
    counters: { nodes: { file: 1, function: 1, class: 0, symbol: 0 }, edges: { imports: 0 } },
  }));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const VALID_FILE = {
  schemaVersion: 1,
  N: { authbox: { kind: "cont", title: "AuthoredBox", accent: "sky", drillTo: "alpha", x: 70, y: 320, w: 170, h: 90 } },
  E: [],
  BANDS: [{ x: 54, y: 288, w: 700, h: 160, label: "AUTHBAND", color: "rgba(0,0,0,.1)", lc: "#000", note: "n" }],
  BOUNDARY: { x: 40, y: 248, w: 800, h: 300, label: "fixture-authored-repo" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};

async function get(): Promise<{ html: string; payload: Record<string, unknown> }> {
  const app = new Hono();
  mountRepoGraphWebRoutes(app, { cwd: projectRoot, home });
  const res = await app.fetch(new Request(`http://localhost/repo-graph?repo=${HASH}`));
  const html = await res.text();
  const match = /data-initial="([^"]+)"/.exec(html);
  expect(match).not.toBeNull();
  const raw = match![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return { html, payload: JSON.parse(raw) };
}

describe("SSR authored-model loading", () => {
  test("a valid .siltpoke/arch-c4.json on a NON-siltpoke-named repo lands in the payload", async () => {
    mkdirSync(join(projectRoot, ".siltpoke"), { recursive: true });
    writeFileSync(join(projectRoot, ".siltpoke", "arch-c4.json"), JSON.stringify(VALID_FILE));
    const { html, payload } = await get();
    const authored = payload.authoredModel as { N: Record<string, { title: string }> } | null;
    expect(authored).not.toBeNull();
    expect(authored!.N.authbox!.title).toBe("AuthoredBox");
    expect(html).not.toContain("rg-authored-invalid");
  });

  test("a malformed file → null model + the visible fail-soft banner", async () => {
    mkdirSync(join(projectRoot, ".siltpoke"), { recursive: true });
    writeFileSync(join(projectRoot, ".siltpoke", "arch-c4.json"), JSON.stringify({ schemaVersion: 1, N: "not-a-record" }));
    const { html, payload } = await get();
    expect(payload.authoredModel).toBeNull();
    expect(html).toContain("rg-authored-invalid");
    expect(html).toContain("Authored model invalid");
  });

  test("unparseable JSON → same fail-soft path, page still renders", async () => {
    mkdirSync(join(projectRoot, ".siltpoke"), { recursive: true });
    writeFileSync(join(projectRoot, ".siltpoke", "arch-c4.json"), "{ not json");
    const { html, payload } = await get();
    expect(payload.authoredModel).toBeNull();
    expect(html).toContain("rg-authored-invalid");
    expect(html).toContain('x-data="repoGraph"'); // page alive, never broken
  });

  test("no file → authoredModel null, no banner, page unchanged", async () => {
    const { html, payload } = await get();
    expect(payload.authoredModel).toBeNull();
    expect(html).not.toContain("rg-authored-invalid");
    expect(html).toContain('x-data="repoGraph"');
  });
});
