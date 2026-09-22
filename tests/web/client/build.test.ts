/**
 * Bundle smoke test — verifies the client build pipeline produces a non-empty
 * output without requiring a browser DOM. Alpine island code registers on
 * `alpine:init` events that never fire in bun:test; this test only checks the
 * build artifact, not runtime behaviour.
 *
 * Every build here goes to a TEMP dir, never `public/static`. That file is
 * tracked, is a runtime asset the published package must carry, and
 * `check:client` blocks a PR on `git diff --exit-code` over it. Before the
 * `outdir` option existed these four builds wrote it directly and unminified,
 * so any `bun test` left the working tree dirty (measured 517,983 -> 896,916
 * bytes) and a later `git add -A` shipped the unminified copy. `ci:local` is
 * structurally blind to it: its gate order runs `check:client` BEFORE `test`,
 * so the bundle is verified and then dirtied. The last test in this file is the
 * guard against that regression.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClient, DEFAULT_OUTDIR } from "../../../scripts/build-client";

const SHIPPED_BUNDLE = join(DEFAULT_OUTDIR, "index.js");

let outdir: string;
/** Byte snapshot of the tracked bundle, taken BEFORE any build in this file runs. */
let shippedBefore: Buffer | null = null;

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "siltpoke-client-build-"));
  if (existsSync(SHIPPED_BUNDLE)) shippedBefore = readFileSync(SHIPPED_BUNDLE);
});

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

// ─── Main bundle ──────────────────────────────────────────────────────────────

describe("buildClient()", () => {
  it("succeeds and produces at least one output", async () => {
    const result = await buildClient({ minify: false, outdir });
    expect(result.success).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);
  });

  it("output files are non-empty", async () => {
    const result = await buildClient({ minify: false, outdir });
    for (const outputPath of result.outputs) {
      const file = Bun.file(outputPath);
      const size = file.size;
      expect(size).toBeGreaterThan(0);
    }
  });

  it("at least one output filename contains 'index'", async () => {
    const result = await buildClient({ minify: false, outdir });
    const hasIndex = result.outputs.some((p) => p.includes("index"));
    expect(hasIndex).toBe(true);
  });

  it("main bundle does not include SortableJS symbol", async () => {
    const result = await buildClient({ minify: false, outdir });
    const indexPath = result.outputs.find((p) => p.includes("index"));
    expect(indexPath).toBeDefined();

    const content = await Bun.file(indexPath!).text();
    // SortableJS exports "Sortable" as its default — if the symbol appears
    // in the main bundle it has been accidentally inlined.
    // We check for the class constructor name which is always present in
    // the non-minified output.
    expect(content).not.toContain("SortableJS");
  });

  it("writes only into the given outdir — never the tracked public/static tree", async () => {
    const result = await buildClient({ minify: false, outdir });
    expect(result.outputs.length).toBeGreaterThan(0); // positive control
    for (const outputPath of result.outputs) {
      expect(outputPath.startsWith(outdir)).toBe(true);
      expect(outputPath.startsWith(DEFAULT_OUTDIR)).toBe(false);
    }
  });

  // Declared LAST on purpose: bun:test runs a file's tests in declaration order,
  // so by the time this runs, every build above has already happened. It is the
  // regression guard for the defect this file caused: its own unminified builds
  // used to overwrite the tracked bundle and leave the working tree dirty.
  it("leaves the tracked public/static/index.js byte-identical", () => {
    // Not `if (shippedBefore)` — an absent tracked bundle would make this test
    // pass while proving nothing, which is exactly the vacuous shape to avoid.
    // The file is tracked, so it is always present in a real checkout.
    expect(existsSync(SHIPPED_BUNDLE)).toBe(true);
    expect(shippedBefore).not.toBeNull();
    expect(shippedBefore!.length).toBeGreaterThan(0); // positive control
    const shippedAfter = readFileSync(SHIPPED_BUNDLE);
    expect(shippedAfter.length).toBe(shippedBefore!.length);
    expect(shippedAfter.equals(shippedBefore!)).toBe(true);
  });
});
