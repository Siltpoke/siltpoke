// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [73]: a `claude -p` child that siltpoke itself spawned loads the user's
// installed plugin and fires its hooks. Two faults, both pinned here:
//   (a) hooks/session-start.sh wrote $HOME/.siltpoke/plugin-root and ignored
//       SILTPOKE_HOME, so even an isolated run rewrote the real pointer;
//   (b) no hook wrapper exited early under SILTPOKE_INTERNAL=1, so the child's
//       Stop hook appended telemetry rows (recursion_guard, not_a_git_repo).
//
// Every run uses a sandbox HOME + a stub `bun` on a minimal PATH. The real home
// is never reachable: the scripts only ever see the sandbox.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const HOOKS = join(REPO, "hooks");

let sandbox: string;
let home: string;
let stubDir: string;
let stubLog: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "siltpoke-child-"));
  home = join(sandbox, "home");
  stubDir = join(sandbox, "stub");
  stubLog = join(sandbox, "stub-calls.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  // The stub records that it ran and writes nothing else.
  writeFileSync(join(stubDir, "bun"), `#!/bin/sh\necho "$1" >> "${stubLog}"\ncat >/dev/null\n`);
  chmodSync(join(stubDir, "bun"), 0o755);
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

/** Every path under the sandbox (minus the stub and its log) with its size. */
function snapshot(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (p === stubLog || p === stubDir) continue;
      const st = statSync(p);
      out.push(`${p.slice(sandbox.length)}|${st.isDirectory() ? "d" : st.size}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(sandbox);
  return out.sort().join("\n");
}

function run(script: string, env: Record<string, string>, payload = "{}") {
  const proc = Bun.spawnSync(["/bin/sh", join(HOOKS, script)], {
    stdin: new TextEncoder().encode(payload),
    env: {
      PATH: `${stubDir}:/usr/bin:/bin`,
      HOME: home,
      CLAUDE_PLUGIN_ROOT: REPO,
      ANTIGRAVITY_PLUGIN_ROOT: REPO,
      ...env,
    },
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

const stubCalls = () => (existsSync(stubLog) ? readFileSync(stubLog, "utf8") : "");

describe("hooks honour SILTPOKE_HOME", () => {
  test("session-start.sh: plugin-root lands under SILTPOKE_HOME, not HOME/.siltpoke", () => {
    const sp = join(sandbox, "sp");
    const r = run("session-start.sh", { SILTPOKE_HOME: sp });
    expect(r.code).toBe(0);
    expect(readFileSync(join(sp, "plugin-root"), "utf8")).toBe(REPO);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("an empty SILTPOKE_HOME counts as unset (same as siltpokeRoot)", () => {
    run("session-start.sh", { SILTPOKE_HOME: "" });
    expect(readFileSync(join(home, ".siltpoke", "plugin-root"), "utf8")).toBe(REPO);
  });

  test("stop.sh: the first-run nudge marker lands under SILTPOKE_HOME", () => {
    const sp = join(sandbox, "sp");
    const r = run("stop.sh", { SILTPOKE_HOME: sp });
    expect(r.out).toContain("Siltpoke installed");
    expect(existsSync(join(sp, ".setup-nudged"))).toBe(true);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("the recorded bun-path pointer is read from SILTPOKE_HOME", () => {
    const sp = join(sandbox, "sp");
    mkdirSync(sp, { recursive: true });
    writeFileSync(join(sp, "config.json"), "{}");
    const recorded = join(sandbox, "recorded-bun");
    writeFileSync(recorded, `#!/bin/sh\necho recorded >> "${stubLog}"\ncat >/dev/null\n`);
    chmodSync(recorded, 0o755);
    writeFileSync(join(sp, "bun-path"), recorded);
    // No bun on PATH: only the pointer under SILTPOKE_HOME can supply one.
    run("stop.sh", { SILTPOKE_HOME: sp, PATH: "/usr/bin:/bin" });
    expect(stubCalls()).toContain("recorded");
  });
});

describe("a siltpoke-spawned child (SILTPOKE_INTERNAL=1) writes nothing", () => {
  const hooks = ["session-start.sh", "stop.sh", "agy-stop.sh", "codex-stop.sh", "codex-session-start.sh"];

  for (const script of hooks) {
    test(`${script}: sandbox is unchanged and bun is never invoked`, () => {
      const before = snapshot();
      const r = run(script, { SILTPOKE_INTERNAL: "1", SILTPOKE_HOME: join(sandbox, "sp") });
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
      expect(snapshot()).toBe(before);
      expect(stubCalls()).toBe("");
    });

    test(`${script}: control — without the marker the same run does reach bun or write`, () => {
      const sp = join(sandbox, "sp");
      mkdirSync(sp, { recursive: true });
      writeFileSync(join(sp, "config.json"), "{}");
      const before = snapshot();
      run(script, { SILTPOKE_HOME: sp });
      expect(stubCalls() !== "" || snapshot() !== before).toBe(true);
    });
  }

  test("the marker must be exactly \"1\" — other values leave the hooks live", () => {
    const sp = join(sandbox, "sp");
    run("session-start.sh", { SILTPOKE_INTERNAL: "0", SILTPOKE_HOME: sp });
    expect(existsSync(join(sp, "plugin-root"))).toBe(true);
  });
});
