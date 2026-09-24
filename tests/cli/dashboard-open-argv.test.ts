import { test, expect, describe } from "bun:test";
import { openDashboard, DASHBOARD_URL } from "../../src/cli/dashboard";

/**
 * WHY — `openDashboard` built its browser-open command inline:
 *
 *   const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
 *   Bun.spawn([cmd, DASHBOARD_URL]);
 *
 * `start` is a `cmd.exe` BUILTIN, not an executable on disk, so `Bun.spawn`
 * (which does not go through a shell) can never run it — `/siltpoke-dashboard`
 * printed the URL and then silently failed to open anything on Windows.
 *
 * The same repo already had this right: `editorOpener()` in
 * `src/installer/editor-detect.ts` returns `["cmd", "/c", "start", ""]`,
 * including the empty string that `start` consumes as the window TITLE — omit
 * it and `start` swallows the URL as the title and opens nothing.
 *
 * These tests assert the SPAWNED ARGV, not a helper's return value. A test that
 * only checked `editorOpener("win32")` would have passed all along while
 * `openDashboard` kept its own broken copy — the wiring is the defect, so the
 * wiring is what is asserted.
 */
describe("openDashboard — the browser-open argv", () => {
  /** Runs openDashboard against a live-daemon stub and returns the spawned argv. */
  async function argvFor(platform: NodeJS.Platform): Promise<string[] | undefined> {
    let spawned: string[] | undefined;
    await openDashboard({
      platform,
      // The daemon is "already up", so nothing else spawns and the test needs
      // no network, no pidfile and no real server.
      isDaemonUp: async () => true,
      spawnOpener: (argv) => {
        spawned = [...argv];
      },
      out: () => {},
    });
    return spawned;
  }

  test("win32 goes through cmd /c start, with the empty title argument", async () => {
    expect(await argvFor("win32")).toEqual(["cmd", "/c", "start", "", DASHBOARD_URL]);
  });

  test("darwin uses open", async () => {
    expect(await argvFor("darwin")).toEqual(["open", DASHBOARD_URL]);
  });

  test("linux uses xdg-open", async () => {
    expect(await argvFor("linux")).toEqual(["xdg-open", DASHBOARD_URL]);
  });

  test("--no-open spawns nothing at all", async () => {
    let spawned: string[] | undefined;
    await openDashboard({
      platform: "win32",
      noOpen: true,
      isDaemonUp: async () => true,
      spawnOpener: (argv) => {
        spawned = [...argv];
      },
      out: () => {},
    });
    expect(spawned).toBeUndefined();
  });
});
