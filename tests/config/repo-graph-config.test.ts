import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoGraphConfig } from "../../src/config/repo-graph-config";

describe("loadRepoGraphConfig", () => {
  test("missing file → default 0.20", async () => {
    const home = mkdtempSync(join(tmpdir(), "rgcfg-"));
    expect((await loadRepoGraphConfig(home)).staleness_warn_pct).toBe(0.2);
  });
  test("reads repo_graph.staleness_warn_pct from config.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "rgcfg-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ repo_graph: { staleness_warn_pct: 0.35 } }));
    expect((await loadRepoGraphConfig(home)).staleness_warn_pct).toBe(0.35);
  });
  test("malformed → default", async () => {
    const home = mkdtempSync(join(tmpdir(), "rgcfg-"));
    writeFileSync(join(home, "config.json"), "{ not json");
    expect((await loadRepoGraphConfig(home)).staleness_warn_pct).toBe(0.2);
  });
});
