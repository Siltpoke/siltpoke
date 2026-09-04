import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWriteEligible, resolveDaemonProject } from "../../src/memory/active-project";
import type { ActiveProject } from "../../src/memory/project";
import { computeProjHash } from "../../src/repo-graph/proj-hash";

function proj(root: string, over: Partial<ActiveProject> = {}): ActiveProject {
  return {
    project_id: `${computeProjHash(root)}0000`, // 16-char stand-in
    project_root: root,
    display_name: root.split("/").pop() ?? root,
    last_active_at: "2026-01-01T00:00:00Z",
    chat_count: 0,
    latest_summary: "",
    fact_count: 1,
    ...over,
  };
}

describe("resolveDaemonProject", () => {
  // Note: liveness uses existsSync(project_root); create real dirs so live projects pass.
  function realHome(): { home: string; a: string; b: string } {
    const h = mkdtempSync(join(tmpdir(), "siltpoke-ap-home-"));
    const a = mkdtempSync(join(tmpdir(), "siltpoke-ap-a-"));
    const b = mkdtempSync(join(tmpdir(), "siltpoke-ap-b-"));
    return { home: h, a, b };
  }

  test("explicit: reverse-matches proj_hash against listActiveProjects", async () => {
    const { home, a, b } = realHome();
    const deps = { listActiveProjects: async () => [proj(a), proj(b)] };
    const r = await resolveDaemonProject({ home, explicitProjHash: computeProjHash(b) }, deps);
    expect(r.source).toBe("explicit");
    expect(r.project_root).toBe(b);
    expect(r.proj_hash).toBe(computeProjHash(b));
    rmSync(home, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
  });

  test("stale: explicit hash matching no live project", async () => {
    const { home, a } = realHome();
    const deps = { listActiveProjects: async () => [proj(a)] };
    const r = await resolveDaemonProject({ home, explicitProjHash: "ffffffffffff" }, deps);
    expect(r.source).toBe("stale");
    expect(r.project_root).toBeNull();
    rmSync(home, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true });
  });

  test("sticky: pin reverse-matches when no explicit", async () => {
    const { home, a, b } = realHome();
    const deps = { listActiveProjects: async () => [proj(a), proj(b)] };
    const r = await resolveDaemonProject({ home, pinnedProjHash: computeProjHash(a) }, deps);
    expect(r.source).toBe("sticky");
    expect(r.project_root).toBe(a);
    rmSync(home, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
  });

  test("recent: newest live+content-bearing project when no explicit/pin", async () => {
    const { home, a, b } = realHome();
    const deps = { listActiveProjects: async () => [
      proj(a, { last_active_at: "2026-01-01T00:00:00Z" }),
      proj(b, { last_active_at: "2026-02-01T00:00:00Z" }),
    ] };
    const r = await resolveDaemonProject({ home }, deps);
    expect(r.source).toBe("recent");
    expect(r.project_root).toBe(b);
    rmSync(home, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
  });

  test("recent: excludes content-empty (fact_count 0, no repo-graph) projects", async () => {
    const { home, a, b } = realHome();
    const deps = { listActiveProjects: async () => [
      proj(a, { last_active_at: "2026-03-01T00:00:00Z", fact_count: 0 }), // empty, newest
      proj(b, { last_active_at: "2026-01-01T00:00:00Z", fact_count: 2 }), // has facts, older
    ] };
    const r = await resolveDaemonProject({ home }, deps);
    expect(r.source).toBe("recent");
    expect(r.project_root).toBe(b); // empty-newest a is filtered out
    rmSync(home, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true });
  });

  test("recent: excludes dead roots (project_root gone from disk)", async () => {
    const { home, a } = realHome();
    const dead = "/tmp/siltpoke-ap-deleted-xyz";
    const deps = { listActiveProjects: async () => [proj(dead, { last_active_at: "2026-09-01T00:00:00Z" }), proj(a)] };
    const r = await resolveDaemonProject({ home }, deps);
    expect(r.project_root).toBe(a);
    rmSync(home, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true });
  });

  test("none: no live projects", async () => {
    const { home } = realHome();
    const deps = { listActiveProjects: async () => [] };
    const r = await resolveDaemonProject({ home }, deps);
    expect(r.source).toBe("none");
    expect(r.project_root).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  test("dead pin falls through to recent", async () => {
    const { home, a } = realHome();
    const deps = { listActiveProjects: async () => [proj(a)] };
    const r = await resolveDaemonProject({ home, pinnedProjHash: "ffffffffffff" }, deps);
    expect(r.source).toBe("recent");
    expect(r.project_root).toBe(a);
    rmSync(home, { recursive: true, force: true }); rmSync(a, { recursive: true, force: true });
  });
});

describe("isWriteEligible", () => {
  test("explicit and sticky are write-eligible; recent/stale/none are not", () => {
    expect(isWriteEligible("explicit")).toBe(true);
    expect(isWriteEligible("sticky")).toBe(true);
    expect(isWriteEligible("recent")).toBe(false);
    expect(isWriteEligible("stale")).toBe(false);
    expect(isWriteEligible("none")).toBe(false);
  });
});
