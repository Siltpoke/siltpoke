/**
 * The Stop hook must respawn a daemon script that EXISTS in whichever way it
 * shipped.
 *
 * `respawnDaemonDetached` resolved its target as
 * `new URL("../cli/daemon.ts", import.meta.url).pathname`. Measured:
 *
 *   from file:///repo/src/hooks/on-stop.ts  →  /repo/src/cli/daemon.ts   ✅
 *   from file:///repo/dist/siltpoke-stop.js →  /repo/cli/daemon.ts       ❌ no src/
 *
 * on-stop.ts is bundled into dist/siltpoke-stop.js (scripts/build-dist.ts), so
 * every built install resolved a path that exists nowhere. The spawn then dies
 * with `Module not found` — and the failure is doubly invisible: the call is
 * wrapped in a best-effort try/catch, and the child is spawned with all three
 * stdio streams ignored. Net effect on a built install: once the daemon is down
 * it can never come back by itself, silently.
 *
 * This is the same defect family as resolveIndexerTarget and
 * resolveOnStopTarget in agy-stop.ts — a bundled file doing `..` arithmetic
 * into a src/-relative path.
 *
 * Why the existing suite missed it: tests/hooks/on-stop-respawn.test.ts asserts
 * `calls[0][0] === "bun"` and `calls[0][2] === "start"` — it steps over index
 * [1], the script path, which is the only part that was wrong.
 *
 * Run: bun test tests/hooks/on-stop-respawn-target.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { resolveDaemonTarget } from "../../src/hooks/on-stop";

describe("resolveDaemonTarget — bundled", () => {
  test("from dist/, targets the sibling daemon bundle", () => {
    expect(resolveDaemonTarget("/opt/plugin/cache/siltpoke/dist")).toBe(
      "/opt/plugin/cache/siltpoke/dist/siltpoke-daemon.js",
    );
  });

  test("never a .ts path and never a src/ path — a plugin cache has neither", () => {
    const target = resolveDaemonTarget("/opt/plugin/cache/siltpoke/dist");
    expect(target.endsWith(".ts")).toBe(false);
    expect(target).not.toContain("/src/");
  });

  test("never climbs out of the dist directory it was given", () => {
    // The old expression climbed one level too far. Pin that it stays put.
    const dir = "/Users/v/Projects/siltpoke/dist";
    const target = resolveDaemonTarget(dir);
    expect(target.startsWith(`${dir}/`)).toBe(true);
    expect(target).not.toContain("..");
  });

  test("the bundle it names is one the build actually produces", async () => {
    // Guards against pointing at a filename the build never emits — a green
    // unit test over a file that does not exist on disk.
    const { BUNDLES } = await import("../../scripts/build-dist");
    const wanted = basename(resolveDaemonTarget("/anything/dist"));
    const spec = BUNDLES.find((b) => basename(b.out) === wanted);
    expect(spec).toBeDefined();
    expect(spec!.entry).toBe("src/cli/daemon.ts");
  });
});

describe("resolveDaemonTarget — from source", () => {
  test("from src/hooks/, targets the TypeScript daemon entry", () => {
    expect(resolveDaemonTarget("/repo/src/hooks")).toBe("/repo/src/cli/daemon.ts");
  });

  test("absolute in both modes", () => {
    expect(isAbsolute(resolveDaemonTarget("/repo/dist"))).toBe(true);
    expect(isAbsolute(resolveDaemonTarget("/repo/src/hooks"))).toBe(true);
  });
});

describe("the source-mode target is real, here, right now", () => {
  test("resolving against THIS checkout's src/hooks yields a file that exists", () => {
    // The unit tests above use synthetic dirs; this one anchors the source
    // branch to the real tree, so a future move of src/cli/daemon.ts breaks a
    // test instead of breaking respawn silently.
    const target = resolveDaemonTarget(new URL("../../src/hooks", import.meta.url).pathname);
    expect(existsSync(target)).toBe(true);
    expect(basename(target)).toBe("daemon.ts");
  });
});
