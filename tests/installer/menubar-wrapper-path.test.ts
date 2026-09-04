/**
 * The menu-bar shim must point at a renderer that EXISTS.
 *
 * Seventh and last site of the family fixed across #560 / #562 / this PR:
 * `resolveWrapperPath()` computed `join(import.meta.dir, "..", "face",
 * "wrapper.ts")`. menubar-setup.ts is reachable from src/cli/plugin-cli.ts's
 * `menubar` verb, which is bundled into dist/siltpoke-cli.js — and from there
 * that expression yields `<parent-of-dist>/face/wrapper.ts`, which exists in no
 * plugin cache (no `src/`, no `face/`).
 *
 * Lower severity than the two that shipped broken, and worth saying why rather
 * than overstating it: plugin-cli passes `rendererPath` explicitly whenever
 * `resolveCardPath()` finds dist/siltpoke-card.js, which a well-formed build
 * always emits. So this is the DEGRADED-build fallback, not the mainline path.
 * But "the primary resolver normally works" is exactly the reasoning under
 * which the other six sites went unfixed, so it gets the same treatment: the
 * shim it writes would otherwise claim success while pointing nowhere.
 *
 * Run: bun test tests/installer/menubar-wrapper-path.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { resolveWrapperPath } from "../../src/installer/menubar-setup";

describe("resolveWrapperPath — bundled", () => {
  test("from dist/, names the sibling card bundle", () => {
    expect(resolveWrapperPath("/opt/plugin/cache/siltpoke/dist")).toBe(
      "/opt/plugin/cache/siltpoke/dist/siltpoke-card.js",
    );
  });

  test("never a .ts path and never a src/ path — a plugin cache ships neither", () => {
    const target = resolveWrapperPath("/opt/plugin/cache/siltpoke/dist");
    expect(target.endsWith(".ts")).toBe(false);
    expect(target).not.toContain("/src/");
    expect(target).not.toContain("/face/");
  });

  test("never climbs out of the dist directory it was handed", () => {
    const dir = "/Users/v/Projects/siltpoke/dist";
    const target = resolveWrapperPath(dir);
    expect(target.startsWith(`${dir}/`)).toBe(true);
    expect(target).not.toContain("..");
  });

  test("the bundle it names is one the build actually emits", async () => {
    const { BUNDLES } = await import("../../scripts/build-dist");
    const wanted = basename(resolveWrapperPath("/anything/dist"));
    const spec = BUNDLES.find((b) => basename(b.out) === wanted);
    expect(spec).toBeDefined();
    expect(spec!.entry).toBe("src/face/wrapper.ts");
  });
});

describe("resolveWrapperPath — from source", () => {
  test("from src/installer/, targets the TypeScript renderer", () => {
    expect(resolveWrapperPath("/repo/src/installer")).toBe("/repo/src/face/wrapper.ts");
  });

  test("absolute in both modes", () => {
    expect(isAbsolute(resolveWrapperPath("/repo/dist"))).toBe(true);
    expect(isAbsolute(resolveWrapperPath("/repo/src/installer"))).toBe(true);
  });

  test("the source-mode target is real in THIS checkout", () => {
    const target = resolveWrapperPath(new URL("../../src/installer", import.meta.url).pathname);
    expect(existsSync(target)).toBe(true);
    expect(basename(target)).toBe("wrapper.ts");
  });
});
