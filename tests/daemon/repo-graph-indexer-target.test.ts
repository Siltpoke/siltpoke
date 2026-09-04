/**
 * The daemon must spawn an indexer that EXISTS in whichever way it shipped.
 *
 * The defect this pins: `defaultIndexRunner` resolved its child as
 * `join(import.meta.dir, "../../cli/index-repo.ts")`. That is correct only when
 * the daemon runs from source (`src/daemon/routes/` → `src/cli/`). The daemon
 * actually runs as `dist/siltpoke-daemon.js`, where the same expression walks
 * two levels ABOVE the repo, so every dashboard "Index a repo" spawned a path
 * that does not exist → `Module not found` → exit 1 → "index_failed".
 *
 * Measured on the live install before the fix:
 *   ps            → bun …/siltpoke//dist/siltpoke-daemon.js start
 *   dist bundle   → join115(import.meta.dir, "../../cli/index-repo.ts")
 *   resolves to   → …/ai-agents/siltpoke/cli/index-repo.ts   (does not exist)
 *   bun <that>    → error: Module not found … ; exit 1
 *
 * `src/hooks/agy-stop.ts` already carries the correct shape for exactly this
 * "ships two ways" problem (`resolveOnStopTarget`), and its own comment records
 * that spawning the source path was a previously-shipped bug there too. This is
 * the sibling site that never got the same defence.
 *
 * Run: bun test tests/daemon/repo-graph-indexer-target.test.ts
 */
import { describe, expect, test } from "bun:test";
import { basename, isAbsolute } from "node:path";
import { resolveIndexerTarget } from "../../src/daemon/routes/repo-graph";

describe("resolveIndexerTarget — bundled", () => {
  test("from dist/, targets the sibling bundle, never a src/ path", () => {
    const target = resolveIndexerTarget("/opt/plugin/cache/siltpoke/dist");
    // The plugin cache ships no src/ and no node_modules — a .ts target there is
    // unspawnable, which is the whole bug.
    expect(target.endsWith(".ts")).toBe(false);
    expect(target).not.toContain("/src/");
    expect(target).toBe("/opt/plugin/cache/siltpoke/dist/siltpoke-index-repo.js");
  });

  test("never escapes the dist directory it was given", () => {
    // The old expression walked up two levels; assert we stay put. A `..` that
    // climbs out of dist/ is the exact failure being pinned.
    const dir = "/Users/v/Projects/ai-agents/siltpoke/siltpoke/dist";
    const target = resolveIndexerTarget(dir);
    expect(target.startsWith(`${dir}/`)).toBe(true);
    expect(target).not.toContain("..");
  });
});

describe("resolveIndexerTarget — from source", () => {
  test("from src/daemon/routes/, targets the TypeScript entry", () => {
    const target = resolveIndexerTarget("/repo/src/daemon/routes");
    expect(target).toBe("/repo/src/cli/index-repo.ts");
  });

  test("returns an absolute path in both modes", () => {
    expect(isAbsolute(resolveIndexerTarget("/repo/dist"))).toBe(true);
    expect(isAbsolute(resolveIndexerTarget("/repo/src/daemon/routes"))).toBe(true);
  });
});

describe("the bundled target is actually produced by the build", () => {
  test("build-dist declares a bundle whose output basename matches the dist target", async () => {
    // Without this the resolver would point at a file the build never emits —
    // a green unit test over a target that does not exist on disk.
    const { BUNDLES } = await import("../../scripts/build-dist");
    const wanted = basename(resolveIndexerTarget("/anything/dist"));
    const outs = BUNDLES.map((b) => basename(b.out));
    expect(outs).toContain(wanted);

    // …and it must be built from the indexer entry, not something else that
    // happens to share the name.
    const spec = BUNDLES.find((b) => basename(b.out) === wanted);
    expect(spec?.entry).toBe("src/cli/index-repo.ts");
  });
});
