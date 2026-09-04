// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Drives the row via the TOP-LEVEL `runDoctorCli`, not `checkIndexStaleness`
 * directly — a check function that is never registered in `runDoctorCli`'s
 * row list would pass its own unit test while doctor silently omits it. This
 * is the dead-guard this suite is written to prevent (R12/R16).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { runDoctorCli } from "../../src/cli/doctor";
import { runIndexBuild } from "../../src/repo-graph/builder";

describe("doctor index-staleness row (via runDoctorCli)", () => {
  test("stale repo → row present, status warn", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    mkdirSync(join(repo, "src"));
    for (const n of ["a", "b", "c", "d", "e"]) {
      writeFileSync(join(repo, "src", `${n}.ts`), `export const ${n}=1;\n`);
    }
    await runIndexBuild({ cwd: repo, force: true, home });
    writeFileSync(join(repo, "src", "a.ts"), "export const a=999;\n");

    const { output } = await runDoctorCli(["--json"], { siltpokeHome: home, repoRoot: repo });
    expect(output).toContain("index staleness");
    const rows = JSON.parse(output).checks;
    const row = rows.find((r: { name: string }) => r.name.includes("index staleness"));
    expect(row).toBeDefined();
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("changed");
  });

  test("never-indexed repo → row present, status warn (open the dashboard's Code Map page and pick this repo)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));

    const { output } = await runDoctorCli(["--json"], { siltpokeHome: home, repoRoot: repo });
    const rows = JSON.parse(output).checks;
    const row = rows.find((r: { name: string }) => r.name.includes("index staleness"));
    expect(row).toBeDefined();
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("Code Map");
  });

  test("fresh repo → row status not warn, null detail (this surface's own negative)", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    mkdirSync(join(repo, "src"));
    for (const n of ["a", "b", "c"]) {
      writeFileSync(join(repo, "src", `${n}.ts`), `export const ${n}=1;\n`);
    }
    await runIndexBuild({ cwd: repo, force: true, home });
    // No edits after indexing — index should read as fresh.

    const { output } = await runDoctorCli(["--json"], { siltpokeHome: home, repoRoot: repo });
    const rows = JSON.parse(output).checks;
    const row = rows.find((r: { name: string }) => r.name.includes("index staleness"));
    expect(row).toBeDefined();
    expect(row.status).not.toBe("warn");
    expect(row.pass).toBe(true);
    expect(row.detail).toBeNull();
  });
});
