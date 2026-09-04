/**
 * The autostart installers must bake a daemon path that EXISTS.
 *
 * Last two live sites of the family fixed in #560 and #562. `launchd.ts` and
 * `systemd.ts` computed the unit's daemon entry as
 * `new URL("../cli/daemon.ts", import.meta.url).pathname`. Both files are
 * inlined into dist/siltpoke-configure.js AND dist/siltpoke-daemon.js
 * (verified by grepping the built bundles), where that expression drops `src/`
 * and yields a path that exists nowhere.
 *
 * It survived the earlier sweep because a plugin install normally takes the
 * shim branch of resolveDaemonLauncher, so the bad value is discarded. But
 * `cmdInstallAutostart` (src/cli/daemon.ts) calls installAutostartForPlatform
 * WITHOUT writing the shim first — `writeDaemonShim` does not appear in that
 * file at all — so `bun dist/siltpoke-daemon.js install-autostart` as a first
 * action falls through to the repo branch and bakes the broken path into a
 * launchd plist / systemd unit. The daemon then never starts, and the unit
 * reports itself installed.
 *
 * `resolveDaemonEntry` is the single implementation the whole family shares.
 *
 * Run: bun test tests/installer/daemon-entry-path.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { resolveDaemonEntry } from "../../src/installer/daemon-path";

describe("resolveDaemonEntry — bundled", () => {
  test("from dist/, names the sibling daemon bundle", () => {
    expect(resolveDaemonEntry("/opt/plugin/cache/siltpoke/dist")).toBe(
      "/opt/plugin/cache/siltpoke/dist/siltpoke-daemon.js",
    );
  });

  test("never a .ts path, never a src/ path — a plugin cache ships neither", () => {
    const target = resolveDaemonEntry("/opt/plugin/cache/siltpoke/dist");
    expect(target.endsWith(".ts")).toBe(false);
    expect(target).not.toContain("/src/");
  });

  test("never climbs out of the dist directory it was handed", () => {
    const dir = "/Users/v/Projects/siltpoke/dist";
    const target = resolveDaemonEntry(dir);
    expect(target.startsWith(`${dir}/`)).toBe(true);
    expect(target).not.toContain("..");
  });

  test("the bundle it names is one the build actually emits", async () => {
    const { BUNDLES } = await import("../../scripts/build-dist");
    const wanted = basename(resolveDaemonEntry("/anything/dist"));
    const spec = BUNDLES.find((b) => basename(b.out) === wanted);
    expect(spec).toBeDefined();
    expect(spec!.entry).toBe("src/cli/daemon.ts");
  });
});

describe("resolveDaemonEntry — from source", () => {
  test("from src/installer/, targets the TypeScript daemon entry", () => {
    expect(resolveDaemonEntry("/repo/src/installer")).toBe("/repo/src/cli/daemon.ts");
  });

  test("from src/cli/ (a sibling directory), still targets it", () => {
    expect(resolveDaemonEntry("/repo/src/cli")).toBe("/repo/src/cli/daemon.ts");
  });

  test("absolute in both modes", () => {
    expect(isAbsolute(resolveDaemonEntry("/repo/dist"))).toBe(true);
    expect(isAbsolute(resolveDaemonEntry("/repo/src/installer"))).toBe(true);
  });
});

describe("the source-mode target is real in THIS checkout", () => {
  test("resolving against the real src/installer yields a file that exists", () => {
    // Anchors the source branch to the tree, so moving src/cli/daemon.ts breaks
    // a test instead of silently breaking autostart.
    const target = resolveDaemonEntry(new URL("../../src/installer", import.meta.url).pathname);
    expect(existsSync(target)).toBe(true);
    expect(basename(target)).toBe("daemon.ts");
  });
});

describe("one implementation, not a seventh copy", () => {
  test("hooks/on-stop's resolveDaemonTarget and this agree in both modes", async () => {
    // The whole reason this bug recurred six times is that each site hand-rolled
    // the rule. If these two ever disagree, the family has forked again.
    const { resolveDaemonTarget } = await import("../../src/hooks/on-stop");
    for (const dir of ["/repo/dist", "/x/y/dist", "/repo/src/installer"]) {
      expect(resolveDaemonEntry(dir)).toBe(resolveDaemonTarget(dir));
    }
  });
});
