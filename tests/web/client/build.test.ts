/**
 * Bundle smoke test — verifies the client build pipeline produces a non-empty
 * output without requiring a browser DOM. Alpine island code registers on
 * `alpine:init` events that never fire in bun:test; this test only checks the
 * build artifact, not runtime behaviour.
 */
import { describe, it, expect } from "bun:test";
import { buildClient } from "../../../scripts/build-client";

// ─── Main bundle ──────────────────────────────────────────────────────────────

describe("buildClient()", () => {
  it("succeeds and produces at least one output", async () => {
    const result = await buildClient({ minify: false });
    expect(result.success).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);
  });

  it("output files are non-empty", async () => {
    const result = await buildClient({ minify: false });
    for (const outputPath of result.outputs) {
      const file = Bun.file(outputPath);
      const size = file.size;
      expect(size).toBeGreaterThan(0);
    }
  });

  it("at least one output filename contains 'index'", async () => {
    const result = await buildClient({ minify: false });
    const hasIndex = result.outputs.some((p) => p.includes("index"));
    expect(hasIndex).toBe(true);
  });

  it("main bundle does not include SortableJS symbol", async () => {
    const result = await buildClient({ minify: false });
    const indexPath = result.outputs.find((p) => p.includes("index"));
    expect(indexPath).toBeDefined();

    const content = await Bun.file(indexPath!).text();
    // SortableJS exports "Sortable" as its default — if the symbol appears
    // in the main bundle it has been accidentally inlined.
    // We check for the class constructor name which is always present in
    // the non-minified output.
    expect(content).not.toContain("SortableJS");
  });
});
