import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRequestProject } from "../../src/daemon/project-context";
import type { ActiveProject } from "../../src/memory/project";
import { computeProjHash } from "../../src/repo-graph/proj-hash";
import { readProjectPin } from "../../src/state/project-pin";

function proj(root: string): ActiveProject {
  return {
    project_id: `${computeProjHash(root)}0000`,
    project_root: root,
    display_name: "x",
    last_active_at: "2026-01-01T00:00:00Z",
    chat_count: 0,
    latest_summary: "",
    fact_count: 1,
  };
}

describe("resolveRequestProject", () => {
  test("persists the resolved hash as the pin on a recent resolution", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-prc-home-"));
    const a = mkdtempSync(join(tmpdir(), "siltpoke-prc-a-"));
    const deps = { listActiveProjects: async () => [proj(a)] };
    const r = await resolveRequestProject(home, undefined, deps);
    expect(r.source).toBe("recent");
    expect(await readProjectPin(home)).toBe(computeProjHash(a));
    rmSync(home, { recursive: true, force: true });
    rmSync(a, { recursive: true, force: true });
  });

  test("a later bare request resolves sticky from the persisted pin", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-prc-home-"));
    const a = mkdtempSync(join(tmpdir(), "siltpoke-prc-a-"));
    const b = mkdtempSync(join(tmpdir(), "siltpoke-prc-b-"));
    // first: explicit-select a (persists pin=a)
    const deps = { listActiveProjects: async () => [proj(a), proj(b)] };
    await resolveRequestProject(home, computeProjHash(a), deps);
    // then: bare request → sticky a, not recent
    const r = await resolveRequestProject(home, undefined, deps);
    expect(r.source).toBe("sticky");
    expect(r.project_root).toBe(a);
    rmSync(home, { recursive: true, force: true });
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  });

  test("does not persist a stale/none resolution", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-prc-home-"));
    const deps = { listActiveProjects: async () => [] };
    await resolveRequestProject(home, "ffffffffffff", deps); // stale
    expect(await readProjectPin(home)).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});
