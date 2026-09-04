import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonShimPath, writeDaemonShim, writeShim } from "../../src/installer/shim";
import { resolveDaemonLauncher } from "../../src/installer/daemon-path";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "siltpoke-shim-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function runShim(shimPath: string) {
  return Bun.spawnSync(["sh", shimPath], { env: { ...process.env, HOME: home } });
}

describe("statusline shim", () => {
  test("no plugin-root pointer → prints nothing, exits 0 (blank statusline, never an error)", async () => {
    const shim = await writeShim(home);
    const r = runShim(shim);
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("");
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("pointer names a path that no longer exists (plugin uninstalled) → still silent, exit 0", async () => {
    const shim = await writeShim(home);
    writeFileSync(join(home, ".siltpoke", "plugin-root"), "/gone/siltpoke-0.1.1");
    const r = runShim(shim);
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("");
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("pointer file present but empty → silent, exit 0", async () => {
    const shim = await writeShim(home);
    writeFileSync(join(home, ".siltpoke", "plugin-root"), "");
    const r = runShim(shim);
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("");
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("HOME unset in the shim's environment → silent, exit 0 (no unbound-variable crash)", async () => {
    const shim = await writeShim(home);
    const env = { ...process.env };
    delete env.HOME;
    const r = Bun.spawnSync(["sh", shim], { env });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("");
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("empty PATH (bun/cat unresolvable) with a live pointer + bundle → silent, exit 0", async () => {
    const root = join(home, "cache", "siltpoke-9.9.9");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "siltpoke-card.js"), 'console.log("FACE");');
    const shim = await writeShim(home);
    writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
    // Interpreter invoked by absolute path so PATH="" only affects the
    // script's own internal command resolution (cat / bun), not "sh" itself.
    const r = Bun.spawnSync(["/bin/sh", shim], { env: { HOME: home, PATH: "" } });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("");
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("pointer names a live plugin root → execs that version's card bundle", async () => {
    const root = join(home, "cache", "siltpoke-9.9.9");
    mkdirSync(join(root, "dist"), { recursive: true });
    // Stand-in for the real bundle: proves the shim execs THE PATH THE POINTER NAMES.
    writeFileSync(join(root, "dist", "siltpoke-card.js"), 'console.log("FACE");');
    const shim = await writeShim(home);
    writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
    const r = runShim(shim);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe("FACE");
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });

  test("writeShim is safe to call twice in a row (upgrade re-write via tmp+rename)", async () => {
    const first = await writeShim(home);
    const second = await writeShim(home);
    expect(second).toBe(first);
    const r = runShim(second);
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("");
    expect(new TextDecoder().decode(r.stderr)).toBe("");
  });
});

describe("daemon shim", () => {
  test("pointer names a live plugin root → execs THAT version's daemon bundle, forwarding argv", async () => {
    const root = join(home, "cache", "siltpoke-9.9.9");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(
      join(root, "dist", "siltpoke-daemon.js"),
      'console.log("DAEMON " + process.argv.slice(2).join(","));',
    );
    const shim = await writeDaemonShim(home);
    writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
    const r = Bun.spawnSync(["sh", shim, "start"], { env: { ...process.env, HOME: home } });
    expect(new TextDecoder().decode(r.stdout).trim()).toBe("DAEMON start");
  });

  test("bakes no versioned plugin path into the unit's exec target", async () => {
    const shim = await writeDaemonShim(home);
    const body = readFileSync(shim, "utf8");
    expect(body).toContain(".siltpoke/plugin-root");
    expect(body).not.toContain("plugins/cache");
  });

  test("unresolvable daemon → idles instead of exiting (a keep-alive unit would respawn-storm)", async () => {
    // No plugin-root pointer. The shim must NOT return instantly with 0 —
    // launchd KeepAlive / systemd Restart=always would relaunch it every
    // ThrottleInterval seconds forever. It sleeps and retries.
    const shim = await writeDaemonShim(home);
    const proc = Bun.spawn(["sh", shim, "start"], {
      env: { ...process.env, HOME: home },
      stdout: "ignore",
      stderr: "ignore",
    });
    const exited = await Promise.race([
      proc.exited.then(() => "exited" as const),
      new Promise<"still-running">((r) => setTimeout(() => r("still-running"), 300)),
    ]);
    proc.kill();
    expect(exited).toBe("still-running");
  });
});

describe("resolveDaemonLauncher", () => {
  /** A resolvable plugin-root pointer — what the plugin's SessionStart hook writes. */
  function writePluginRoot(target?: string): string {
    const root = target ?? join(home, "cache", "siltpoke-9.9.9");
    if (!target) mkdirSync(join(root, "dist"), { recursive: true });
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
    return root;
  }

  test("plugin install (shim + resolving pointer) → the unit execs the shim, not a versioned path", async () => {
    await writeDaemonShim(home);
    writePluginRoot();
    const l = resolveDaemonLauncher("/usr/bin/bun", "/repo/src/cli/daemon.ts", home);
    expect(l).toEqual({
      program: "/bin/sh",
      script: daemonShimPath(home),
      viaShim: true,
    });
  });

  test("repo install (no shim) → unchanged: the unit execs bun against the checkout", () => {
    const l = resolveDaemonLauncher("/usr/bin/bun", "/repo/src/cli/daemon.ts", home);
    expect(l).toEqual({
      program: "/usr/bin/bun",
      script: "/repo/src/cli/daemon.ts",
      viaShim: false,
    });
  });

  // The gate is the POINTER resolving, not the shim FILE existing. The shim is
  // inert without ~/.siltpoke/plugin-root (only the plugin's SessionStart hook
  // writes it), and the file outlives the plugin that made it useful. Routing the
  // unit through a shim that can't resolve anything yields a daemon that idles,
  // gets respawned every keep-alive interval forever, and reports "installed".
  test("shim on disk but NO pointer → direct path (a leftover shim must not hijack a repo install)", async () => {
    await writeDaemonShim(home);
    const l = resolveDaemonLauncher("/usr/bin/bun", "/repo/src/cli/daemon.ts", home);
    expect(l).toEqual({
      program: "/usr/bin/bun",
      script: "/repo/src/cli/daemon.ts",
      viaShim: false,
    });
  });

  test("shim on disk but the pointer DANGLES (plugin uninstalled) → direct path", async () => {
    await writeDaemonShim(home);
    writePluginRoot(join(home, "cache", "siltpoke-gone"));
    const l = resolveDaemonLauncher("/usr/bin/bun", "/repo/src/cli/daemon.ts", home);
    expect(l.viaShim).toBe(false);
  });

  test("shim on disk but the pointer is EMPTY → direct path", async () => {
    await writeDaemonShim(home);
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "plugin-root"), "  \n");
    const l = resolveDaemonLauncher("/usr/bin/bun", "/repo/src/cli/daemon.ts", home);
    expect(l.viaShim).toBe(false);
  });
});
