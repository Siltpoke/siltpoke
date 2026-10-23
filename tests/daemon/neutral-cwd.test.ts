// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The daemon lives in the filesystem root, whoever starts it.
 *
 * Every `claude -p` the daemon spawns inherits its folder, and claude loads
 * that folder's project settings. launchd starts it in `/`, but the dashboard
 * command, `daemon-restart` and a Stop hook that finds it down pass no cwd —
 * so the daemon used to live in whatever project the user was in, from a
 * codex or agy session one claude never asked them to trust.
 *
 * The real-entry test starts the daemon from inside a project folder WITH A
 * RELATIVE SILTPOKE_HOME (the e2e suite's shape — CI caught the first version
 * of this change failing on exactly that) and reads the running process's cwd
 * from the OS.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { PATH_ENV_VARS, moveToNeutralCwd } from "../../src/daemon/neutral-cwd";

const REPO = join(import.meta.dir, "..", "..");

describe("moveToNeutralCwd", () => {
  test("moves to the root of the current path", () => {
    const seen: string[] = [];
    const root = moveToNeutralCwd((d) => seen.push(d), "/Users/x/clone/repo", {});
    expect(root).toBe("/");
    expect(seen).toEqual(["/"]);
  });

  test("never moves into the folder it was started in", () => {
    const seen: string[] = [];
    moveToNeutralCwd((d) => seen.push(d), "/Users/x/clone/repo", {});
    expect(seen).not.toContain("/Users/x/clone/repo");
  });

  test("relative path variables become absolute against the starting folder; others are untouched", () => {
    const env: NodeJS.ProcessEnv = {
      SILTPOKE_HOME: "./.playwright-tmp/siltpoke",
      SILTPOKE_TEST_KNOWLEDGE_DOCS_ROOT: "fixture",
      SILTPOKE_QUESTS_YAML: "/abs/q.yaml",
      SILTPOKE_ENV: "test",
    };
    moveToNeutralCwd(() => {}, "/work/repo", env);
    expect(env.SILTPOKE_HOME).toBe("/work/repo/.playwright-tmp/siltpoke");
    expect(env.SILTPOKE_TEST_KNOWLEDGE_DOCS_ROOT).toBe("/work/repo/fixture");
    expect(env.SILTPOKE_QUESTS_YAML).toBe("/abs/q.yaml");
    expect(env.SILTPOKE_ENV).toBe("test");
  });

  // Every SILTPOKE_* name anywhere in src/ — however it is read (dot, bracket,
  // a const holding the name, destructuring) — must be classified. A new name
  // fails here until someone decides whether it holds a path.
  const NOT_PATHS = new Set([
    "SILTPOKE_ARCH_HARD_CAP_USD", "SILTPOKE_ARCH_MODEL", "SILTPOKE_ARCH_SOFT_CAP_USD", "SILTPOKE_ARCH_TIMEOUT_MS",
    "SILTPOKE_BRAIN_TIMEOUT_MS", "SILTPOKE_CALLER_RESOLVER", "SILTPOKE_CAPTURE_CASE1", "SILTPOKE_DAEMON_PORT",
    "SILTPOKE_DISABLE_RESPAWN", "SILTPOKE_EMBED_STUB", "SILTPOKE_ENV", "SILTPOKE_EVAL_PAID",
    "SILTPOKE_EXPLAIN_HARD_CAP_USD", "SILTPOKE_EXPLAIN_MODEL", "SILTPOKE_EXPLAIN_SOFT_CAP_USD", "SILTPOKE_HOST",
    "SILTPOKE_INTERNAL", "SILTPOKE_PERF_TRACE", "SILTPOKE_REVIEWER_PROVIDER", "SILTPOKE_RUBRIC_DEDUP",
    "SILTPOKE_SECRET", "SILTPOKE_SUPPRESSION_DISABLE_RESPAWN", "SILTPOKE_SUPPRESSION_ENABLED",
    "SILTPOKE_TEST_FAULT", "SILTPOKE_TEST_MOCK_STREAM", "SILTPOKE_TOOL_AUGMENTED", "SILTPOKE_YES",
    // Not environment variables: a shell variable in a comment, two consts, two fixture names.
    "SILTPOKE_DIR", "SILTPOKE_SHIM", "SILTPOKE_TOOLS", "SILTPOKE_HOME_RESOLVER", "SILTPOKE_HOME_RESOLVER_MODIFIED",
  ]);

  test("every SILTPOKE_* name in src/ is classified as a path or not", () => {
    const names = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/SILTPOKE_[A-Z0-9_]+/g)) names.add(m[0]);
        }
      }
    };
    walk(join(REPO, "src"));
    expect(names.has("SILTPOKE_HOME")).toBe(true);
    const paths = PATH_ENV_VARS as readonly string[];
    expect([...names].filter((n) => !paths.includes(n) && !NOT_PATHS.has(n)).sort()).toEqual([]);
    expect(paths.filter((n) => NOT_PATHS.has(n))).toEqual([]);
  });
});

describe("siltpokeRoot", () => {
  test("a relative SILTPOKE_HOME comes back absolute, against the current folder", async () => {
    const { siltpokeRoot } = await import("../../src/installer/paths");
    const got = siltpokeRoot({ SILTPOKE_HOME: "./rel/.siltpoke" });
    expect(got).toBe(join(process.cwd(), "rel", ".siltpoke"));
  });
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
    });
  });
}

async function cwdOf(pid: number): Promise<string> {
  if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
  const p = Bun.spawn(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const line = out.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : "";
}

describe.skipIf(process.platform === "win32")("the real daemon entry", () => {
  test("started from inside a project, it runs in the filesystem root", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "siltpoke-neutral-cwd-"));
    const project = join(scratch, "cloned-repo");
    const home = join(scratch, "home");
    mkdirSync(join(project, ".claude"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const port = await freePort();
    const proc = Bun.spawn([process.execPath, join(REPO, "src/cli/daemon.ts"), "start"], {
      cwd: project,
      stdout: "ignore",
      stderr: "ignore",
      env: {
        ...process.env,
        HOME: home,
        // Relative, as the e2e suite passes it: "relative to where I started you".
        SILTPOKE_HOME: "./state/.siltpoke",
        SILTPOKE_DAEMON_PORT: String(port),
        PORT: String(port),
      },
    });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        await new Promise((r) => setTimeout(r, 100));
        up = await fetch(`http://127.0.0.1:${port}/api/ping`).then((r) => r.ok, () => false);
      }
      expect(up).toBe(true);
      const cwd = await cwdOf(proc.pid);
      expect(cwd).toBe(parse(realpathSync(project)).root);
      expect(cwd).not.toBe(realpathSync(project));
      // The relative home still meant the project's folder, not `/state/…`.
      expect(existsSync(join(project, "state", ".siltpoke", "secret"))).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20_000);
});
