/**
 * SSR shell tests for /repo-graph.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphWebRoutes, type RepoGraphWebRouteDeps } from "../../../src/web/routes/repo-graph";
import type { GitProbe } from "../../../src/daemon/build-state";

let cwd: string;
let home: string;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "siltpoke-web-repograph-"));
  cwd = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeApp(): Hono {
  const app = new Hono();
  mountRepoGraphWebRoutes(app, { cwd, home });
  return app;
}

/** Fetch /repo-graph (optional ?repo=) and return its rendered HTML + status. */
async function getRepoGraph(query = ""): Promise<{ status: number; html: string }> {
  const res = await makeApp().fetch(new Request(`http://localhost/repo-graph${query}`));
  return { status: res.status, html: await res.text() };
}

/** Un-escape Hono's HTML-safe JSON and parse the data-initial payload. */
function parseInitial(html: string): Record<string, unknown> {
  const match = /data-initial="([^"]+)"/.exec(html);
  expect(match).not.toBeNull();
  const raw = match![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return JSON.parse(raw);
}

describe("GET /repo-graph (SSR shell)", () => {
  test("200 HTML response with island root + Repo Graph nav highlight", async () => {
    const { status, html } = await getRepoGraph();
    expect(status).toBe(200);
    expect(html).toContain('x-data="repoGraph"');
    expect(html).toContain('data-initial=');
    expect(html).toContain("Code Map");
  });

  test("payload baked into data-initial JSON parses cleanly", async () => {
    const parsed = parseInitial((await getRepoGraph()).html);
    // Nested ArchitectureProjection (`{ projection, repos, currentProjHash }`),
    // not the old flat cytoscape shape (`panels` / `mode` are gone).
    for (const key of ["projection", "repos", "currentProjHash"]) expect(parsed).toHaveProperty(key);
    for (const key of ["groups", "subdirs", "edges"]) expect(parsed.projection).toHaveProperty(key);
  });

  test("no-graph empty state points at the repo picker, not a dead command", async () => {
    const { html } = await getRepoGraph();
    expect(html).toContain("No graph indexed");
    expect(html).toContain("Pick this repo from the selector above");
    // Asserted absent on purpose: the empty state used to render a
    // `/siltpoke-index` chip — a command cut in #279, styled to look clickable
    // while being inert text. This test asserting the chip was PRESENT is what
    // kept it green for a year after the command stopped existing.
    expect(html).not.toContain("/siltpoke-index");
  });

  test("?repo=<hash> query param surfaces in baked-in currentProjHash when indexed", async () => {
    seedIndexedRepo("abcdef012345", "2026-06-09T00:00:00.000Z");
    const { html } = await getRepoGraph("?repo=abcdef012345");
    expect(html).toContain("abcdef012345");
  });

  test("?repo=<hash> not in the indexed registry → stale banner (2026-07-16: replaces silent keep-hash)", async () => {
    const { status, html } = await getRepoGraph("?repo=abcdef012345");
    expect(status).not.toBe(302);
    expect(html).toContain("no longer exists");
  });

  // ── picker-default dead-hash fallback ──
  // Fixture note: meta.json deliberately omits schemaVersion — the registry's
  // tolerant reader still yields last_indexed_ts (so enumeration + ordering
  // work), while the route's strict readMeta returns null (empty projection,
  // no graph.json needed). These tests assert REPO RESOLUTION, not rendering.
  function seedIndexedRepo(hash: string, ts: string, root = `/projects/${hash}`): void {
    const dir = join(home, "repo-memory", hash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ project_root: root, last_indexed_ts: ts }));
  }

  /** Extract the picker button's SSR label (`<b id="rg-repo-name">…</b>`). */
  function pickerLabel(html: string): string {
    const m = /id="rg-repo-name"[^>]*>([^<]*)</.exec(html);
    expect(m).not.toBeNull();
    return m![1]!;
  }

  test("zero repos indexed → picker label shows placeholder, never the dead cwd hash", async () => {
    const { html } = await getRepoGraph();
    const label = pickerLabel(html);
    expect(label).toBe("No repo indexed");
    // the dead cwd hash still rides in data-initial (it's data, not a label) —
    // assert it specifically does NOT leak into the picker button.
    expect(label).not.toBe(parseInitial(html).currentProjHash);
  });

  test("repos indexed → picker label stays the repo's basename (no-regress)", async () => {
    seedIndexedRepo("a1a1a1a1a1a1", "2026-06-09T00:00:00.000Z", "/projects/alpha-repo");
    const { html } = await getRepoGraph();
    expect(pickerLabel(html)).toBe("alpha-repo");
  });

  test("no ?repo= + unindexed cwd → falls back to the picker-order first repo (most recent), not the dead cwd hash", async () => {
    seedIndexedRepo("b0b0b0b0b0b0", "2026-06-01T00:00:00.000Z"); // older
    seedIndexedRepo("a1a1a1a1a1a1", "2026-06-09T00:00:00.000Z"); // newest → list top
    const { status, html } = await getRepoGraph();
    expect(status).toBe(200);
    expect(parseInitial(html).currentProjHash).toBe("a1a1a1a1a1a1");
  });

  test("?repo=<dead-hash> with indexed repos present → stale banner, not a 302 redirect (2026-07-16)", async () => {
    seedIndexedRepo("a1a1a1a1a1a1", "2026-06-09T00:00:00.000Z");
    const res = await makeApp().fetch(new Request("http://localhost/repo-graph?repo=deaddeaddead"));
    expect(res.status).not.toBe(302);
    expect(await res.text()).toContain("no longer exists");
  });

  test("toolbar renders all interactive controls (picker / search / help; no hide-links slider)", async () => {
    const { html } = await getRepoGraph();
    expect(html).toContain('placeholder="Jump to symbol');
    expect(html).toContain("rg-help");
    // repo picker = `rg-repo-pick` button + `rg-repo-menu` dropdown (rows hydrated client-side).
    expect(html).toContain("rg-repo-pick");
    expect(html).toContain("rg-repo-menu");
    // Hide-links slider + imports/strong legend removed 2026-07-02.
    expect(html).not.toContain("rg-edge-slider");
    expect(html).not.toContain("Hide links");
    expect(html).not.toContain("strong (&gt;15)");
  });
});

// ── Daemon-staleness strip ─────────────────────
// Drives the REAL SSR render path: the route computes the staleness signal from
// the injected boot SHA + git probe and bakes the strip into the HTML. Asserts
// all three states (behind / current / unknown) deterministically by stubbing
// the probe — no real git, no daemon, no mock of the render itself.
describe("GET /repo-graph — daemon-staleness strip", () => {
  /** A probe that reports `head` as HEAD; ancestry + count are scenario-driven. */
  function probeFor(opts: {
    ancestor: boolean | null;
    count: number | null;
  }): GitProbe {
    return {
      headSha: () => "head",
      isAncestor: () => opts.ancestor,
      countBetween: () => opts.count,
    };
  }

  async function renderWith(deps: Partial<RepoGraphWebRouteDeps>): Promise<string> {
    const app = new Hono();
    mountRepoGraphWebRoutes(app, { cwd, home, ...deps });
    const res = await app.fetch(new Request("http://localhost/repo-graph"));
    return res.text();
  }

  test("behind — strip renders with the real N", async () => {
    const html = await renderWith({
      readBootBuild: () => ({ bootSha: "boot", bootTime: null }),
      gitProbe: probeFor({ ancestor: true, count: 4 }),
    });
    expect(html).toContain('id="rg-daemon-stale"');
    // non-vacuous: the actual N (4) is in the rendered strip text, not a placeholder.
    expect(html).toContain("daemon 4 commits behind — restart to pick up changes");
  });

  test("current — no strip (no false nag on an up-to-date daemon)", async () => {
    const html = await renderWith({
      // bootSha === headSha → state "current".
      readBootBuild: () => ({ bootSha: "head", bootTime: null }),
      gitProbe: probeFor({ ancestor: true, count: 0 }),
    });
    expect(html).not.toContain('id="rg-daemon-stale"');
    expect(html).not.toContain("commits behind");
  });

  test("unknown — no strip (bootSha not an ancestor → never a number, no dashboard nag)", async () => {
    const html = await renderWith({
      readBootBuild: () => ({ bootSha: "boot", bootTime: null }),
      gitProbe: probeFor({ ancestor: false, count: null }),
    });
    expect(html).not.toContain('id="rg-daemon-stale"');
    expect(html).not.toContain("commits behind");
  });

  test("git error at render time → no strip, page still renders (Contingency 2)", async () => {
    const throwingProbe: GitProbe = {
      headSha: () => {
        throw new Error("git absent");
      },
      isAncestor: () => null,
      countBetween: () => null,
    };
    const html = await renderWith({
      readBootBuild: () => ({ bootSha: "boot", bootTime: null }),
      gitProbe: throwingProbe,
    });
    expect(html).not.toContain('id="rg-daemon-stale"');
    // the page itself still rendered (island root present) — no 500.
    expect(html).toContain('x-data="repoGraph"');
  });

  test("strip is NOT dismissible — no ✕ button (self-clears on restart)", async () => {
    const html = await renderWith({
      readBootBuild: () => ({ bootSha: "boot", bootTime: null }),
      gitProbe: probeFor({ ancestor: true, count: 2 }),
    });
    expect(html).toContain('id="rg-daemon-stale"');
    // the daemon-stale strip carries no dismiss button id.
    expect(html).not.toContain("rg-daemon-stale-dismiss");
  });
});
