import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderUnit, uninstallAutostart } from "../../src/installer/systemd";

const UNIT_PATH =
  "/home/x/.bun/bin:/home/x/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

describe("renderUnit", () => {
  test("includes absolute bun + daemon script paths in ExecStart", () => {
    const unit = renderUnit({
      bunPath: "/home/x/.bun/bin/bun",
      daemonScript: "/abs/cli/daemon.ts",
      daemonPath: UNIT_PATH,
    });
    expect(unit).toContain("ExecStart=/home/x/.bun/bin/bun /abs/cli/daemon.ts start");
  });

  test("sets Restart=always and RestartSec=10", () => {
    const unit = renderUnit({
      bunPath: "/x",
      daemonScript: "/y",
      daemonPath: UNIT_PATH,
    });
    expect(unit).toMatch(/Restart=always/);
    expect(unit).toMatch(/RestartSec=10/);
  });

  test("has [Unit], [Service], [Install] sections", () => {
    const unit = renderUnit({
      bunPath: "/x",
      daemonScript: "/y",
      daemonPath: UNIT_PATH,
    });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("escapes spaces in ExecStart paths", () => {
    const unit = renderUnit({
      bunPath: "/Users/a b/.bun/bin/bun",
      daemonScript: "/abs path/cli/daemon.ts",
      daemonPath: UNIT_PATH,
    });
    expect(unit).toContain(
      "ExecStart=/Users/a\\x20b/.bun/bin/bun /abs\\x20path/cli/daemon.ts start",
    );
  });

  // --- T4 (🔌 systemd-PATH, ACs 8/9) ---

  test("injects Environment=PATH= with the bun + fallback dirs (AC8)", () => {
    const unit = renderUnit({
      bunPath: "/home/x/.bun/bin/bun",
      daemonScript: "/abs/cli/daemon.ts",
      daemonPath: UNIT_PATH,
    });
    // Quoted so a home dir containing a space doesn't break systemd's
    // whitespace-split parsing of Environment= (parity with ExecStart escaping).
    expect(unit).toContain(`Environment="PATH=${UNIT_PATH}"`);
    expect(unit).toContain("/home/x/.bun/bin");
    expect(unit).toContain("/opt/homebrew/bin");
    expect(unit).toContain("/usr/local/bin");
  });

  test("idempotent: same inputs render byte-identical output (AC9)", () => {
    const input = {
      bunPath: "/home/x/.bun/bin/bun",
      daemonScript: "/abs/cli/daemon.ts",
      daemonPath: UNIT_PATH,
    };
    expect(renderUnit(input)).toBe(renderUnit(input));
  });

  test("SILTPOKE_HOME flows into StandardOutput/StandardError append paths", () => {
    const prev = process.env.SILTPOKE_HOME;
    process.env.SILTPOKE_HOME = "/scratch";
    try {
      const unit = renderUnit({
        bunPath: "/x",
        daemonScript: "/y",
        daemonPath: UNIT_PATH,
      });
      expect(unit).toContain("StandardOutput=append:/scratch/logs/daemon.log");
      expect(unit).toContain("StandardError=append:/scratch/logs/daemon.err");
      expect(unit).not.toContain(".siltpoke/logs");
    } finally {
      if (prev === undefined) {
        delete process.env.SILTPOKE_HOME;
      } else {
        process.env.SILTPOKE_HOME = prev;
      }
    }
  });
});

function fakeExec(status = 0) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    exec: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status };
    },
  };
}

describe("uninstallAutostart (systemd)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siltpoke-systemd-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("removes existing unit + disable --now + daemon-reload (AC10)", async () => {
    const unitPath = join(dir, "siltpoked.service");
    writeFileSync(unitPath, "[Unit]");
    const { calls, exec } = fakeExec();
    const r = await uninstallAutostart({ exec, unitPath });
    expect(r).toEqual({ removed: true });
    expect(existsSync(unitPath)).toBe(false);
    expect(calls).toEqual([
      {
        cmd: "systemctl",
        args: ["--user", "disable", "--now", "siltpoked.service"],
      },
      { cmd: "systemctl", args: ["--user", "daemon-reload"] },
    ]);
  });

  test("no-op silently when unit absent — no systemctl call, removed:false", async () => {
    const { calls, exec } = fakeExec();
    const r = await uninstallAutostart({
      exec,
      unitPath: join(dir, "siltpoked.service"),
    });
    expect(r).toEqual({ removed: false });
    expect(calls).toEqual([]);
  });

  test("systemctl failure is ignored — unit still removed + daemon-reload still runs", async () => {
    const unitPath = join(dir, "siltpoked.service");
    writeFileSync(unitPath, "[Unit]");
    const { calls, exec } = fakeExec(1); // systemctl exits non-zero
    const r = await uninstallAutostart({ exec, unitPath });
    expect(r).toEqual({ removed: true });
    expect(existsSync(unitPath)).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
