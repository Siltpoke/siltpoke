// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Task 9 (index-staleness-surfacing slice ②) — config-path E2E, R7.
 *
 * Every other staleness test in this slice injects the threshold directly
 * into `stalenessVerdict(s, warnPct)` or exercises a surface with the
 * DEFAULT config (no `<home>/config.json` written at all). None of them
 * prove the configured value actually flows from a real on-disk
 * `config.json` through `loadRepoGraphConfig` into the two live surfaces
 * (dashboard endpoint + doctor CLI). A surface that silently hardcoded 0.20
 * instead of calling `loadRepoGraphConfig` would still pass every existing
 * test in this slice — this file is the one that would catch it.
 *
 * Fixture: a real repo with 4 indexed files, 1 edited after indexing
 * (wrong_ratio = 0.25). At the built-in default (0.20) that is "stale"
 * (0.25 >= 0.20). With a real `config.json` setting
 * `repo_graph.staleness_warn_pct = 0.9` written into `<home>/config.json`,
 * the SAME on-disk repo must read as "drifting" (0.25 < 0.9) on BOTH
 * surfaces below. If either surface ignores the config and keeps the
 * hardcoded 0.20 default, this test goes red (level stays "stale").
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { runDoctorCli } from "../../src/cli/doctor";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { computeProjHash } from "../../src/repo-graph/proj-hash";
import { runIndexBuild } from "../../src/repo-graph/builder";

/** Real `<home>/config.json` with the configured staleness_warn_pct. */
function writeConfig(home: string, stalenessWarnPct: number): void {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ repo_graph: { staleness_warn_pct: stalenessWarnPct } }, null, 2),
  );
}

/** Seed 4 real files, build the real index, then edit 1 of them so
 *  wrong_ratio lands at exactly 0.25 (1/4) — "stale" at the 0.20 default,
 *  "drifting" at a configured 0.90. Mirrors seedAndDrift from
 *  tests/daemon/repo-graph-staleness-route.test.ts. */
async function seedQuarterDrift(home: string, repo: string): Promise<void> {
  mkdirSync(join(repo, "src"), { recursive: true });
  const names = ["a", "b", "c", "d"];
  for (const name of names) {
    writeFileSync(join(repo, "src", `${name}.ts`), `export const ${name}=1;\n`);
  }
  await runIndexBuild({ cwd: repo, force: true, home });
  writeFileSync(join(repo, "src", "a.ts"), "export const a=999;\n");
}

describe("staleness config-path E2E (real config.json, ≥2 surfaces, R7)", () => {
  test("surface 1 — dashboard endpoint honors configured 0.90, not the 0.20 default", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    writeConfig(home, 0.9);
    await seedQuarterDrift(home, repo);

    const app = new Hono();
    mountRepoGraphRoutes(app, { cwd: repo, home });
    const res = await app.request(`/api/repo-graph/staleness?repo=${computeProjHash(repo)}`);
    const body = (await res.json()) as {
      success: boolean;
      data: { level: string; counts: { wrong_ratio: number } };
    };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Sanity: the real fixture really is at 25% wrong (else this proves nothing).
    expect(body.data.counts.wrong_ratio).toBeCloseTo(0.25, 5);
    // The load-bearing assertion: at the 0.20 default this would be "stale".
    // "drifting" here is only reachable if the endpoint read the 0.90 from
    // <home>/config.json via loadRepoGraphConfig — not a hardcoded 0.20.
    expect(body.data.level).toBe("drifting");
    expect(body.data.level).not.toBe("stale");
  });

  test("surface 2 — doctor CLI honors configured 0.90, not the 0.20 default", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    writeConfig(home, 0.9);
    await seedQuarterDrift(home, repo);

    const { output } = await runDoctorCli(["--json"], { siltpokeHome: home, repoRoot: repo });
    const rows = JSON.parse(output).checks as Array<{
      name: string;
      status?: string;
      detail: string | null;
    }>;
    const row = rows.find((r) => r.name.includes("index staleness"));
    expect(row).toBeDefined();
    // Load-bearing: the "stale" headline reads "N% out of date — re-index
    // recommended"; "drifting" reads "N% drifted since indexing". At the
    // 0.20 default this fixture would produce the "out of date" headline.
    expect(row?.detail).toContain("drifted since indexing");
    expect(row?.detail).not.toContain("out of date");
  });

  test("control — same fixture WITHOUT the config override reads stale on both surfaces", async () => {
    // Proves the fixture itself really does cross the default 0.20 gate,
    // so the two tests above are distinguishing configured-vs-default
    // behavior rather than just always landing on "drifting" regardless.
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    // Deliberately no writeConfig() call — no <home>/config.json at all,
    // so loadRepoGraphConfig falls back to its built-in 0.20 default.
    await seedQuarterDrift(home, repo);

    const app = new Hono();
    mountRepoGraphRoutes(app, { cwd: repo, home });
    const res = await app.request(`/api/repo-graph/staleness?repo=${computeProjHash(repo)}`);
    const body = (await res.json()) as { data: { level: string } };
    expect(body.data.level).toBe("stale");

    const { output } = await runDoctorCli(["--json"], { siltpokeHome: home, repoRoot: repo });
    const rows = JSON.parse(output).checks as Array<{ name: string; detail: string | null }>;
    const row = rows.find((r) => r.name.includes("index staleness"));
    expect(row?.detail).toContain("out of date");
  });
});
