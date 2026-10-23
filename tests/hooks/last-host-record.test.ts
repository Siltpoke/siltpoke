// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [49], step 1 (spec an internal design note §2):
// every hook wrapper records WHICH coding agent it is running in, so the
// dashboard daemon — a separate process that never sees SILTPOKE_HOST — can
// later answer "which agent did this user use last".
//
// The record is `<siltpoke home>/last-host`: line 1 the family, line 2 the
// absolute path of that family's command as this session saw it (may be empty).
//
// Every run uses a sandbox HOME and a minimal PATH holding only stubs, so the
// real home is never reachable.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAMILIES } from "../../src/brain/brain-config";
import { HOST_BINARY } from "../../src/installer/last-host";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const HOOKS = join(REPO, "hooks");

let sandbox: string;
let home: string;
let stubDir: string;

function stub(name: string) {
  writeFileSync(join(stubDir, name), "#!/bin/sh\ncat >/dev/null 2>&1\nexit 0\n");
  chmodSync(join(stubDir, name), 0o755);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "siltpoke-last-host-"));
  home = join(sandbox, "home");
  stubDir = join(sandbox, "stub");
  mkdirSync(home, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  stub("bun");
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

/** Run a wrapper with ONLY the env given here — no *_PLUGIN_ROOT unless the test names one. */
function run(script: string, env: Record<string, string>) {
  const proc = Bun.spawnSync(["/bin/sh", join(HOOKS, script)], {
    stdin: new TextEncoder().encode("{}"),
    env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home, ...env },
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

const recordPath = (dir = join(home, ".siltpoke")) => join(dir, "last-host");
const record = (dir?: string) => readFileSync(recordPath(dir), "utf8");

describe("session-start.sh records the host", () => {
  test("qoder: family on line 1, the command's absolute path on line 2", () => {
    stub("qodercli");
    const r = run("session-start.sh", { QODER_PLUGIN_ROOT: REPO });
    expect(r.code).toBe(0);
    expect(record()).toBe(`qoder\n${join(stubDir, "qodercli")}\n`);
  });

  test("codebuddy", () => {
    stub("codebuddy");
    run("session-start.sh", { CODEBUDDY_PLUGIN_ROOT: REPO });
    expect(record()).toBe(`codebuddy\n${join(stubDir, "codebuddy")}\n`);
  });

  test("plain Claude Code", () => {
    stub("claude");
    run("session-start.sh", { CLAUDE_PLUGIN_ROOT: REPO });
    expect(record()).toBe(`claude\n${join(stubDir, "claude")}\n`);
  });

  test("a fork that also exports CLAUDE_PLUGIN_ROOT is recorded as the fork", () => {
    stub("qodercli");
    stub("claude");
    run("session-start.sh", { QODER_PLUGIN_ROOT: REPO, CLAUDE_PLUGIN_ROOT: REPO });
    expect(record().split("\n")[0]).toBe("qoder");
  });

  test("the command is not on PATH: family still recorded, line 2 empty", () => {
    run("session-start.sh", { CODEBUDDY_PLUGIN_ROOT: REPO });
    expect(record()).toBe("codebuddy\n\n");
  });

  test("no host variable at all: nothing is written — never `claude` as a guess", () => {
    const r = run("session-start.sh", {});
    expect(r.code).toBe(0);
    expect(existsSync(recordPath())).toBe(false);
    // Positive control: the same run DID get far enough to write the pointer,
    // so the absence above is the family rule and not an early exit.
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
  });

  test("lands under SILTPOKE_HOME, not HOME/.siltpoke", () => {
    const sp = join(sandbox, "sp");
    run("session-start.sh", { CODEBUDDY_PLUGIN_ROOT: REPO, SILTPOKE_HOME: sp });
    expect(record(sp).split("\n")[0]).toBe("codebuddy");
    expect(existsSync(recordPath())).toBe(false);
  });

  test("a later session in another host replaces the record", () => {
    run("session-start.sh", { QODER_PLUGIN_ROOT: REPO });
    run("session-start.sh", { CODEBUDDY_PLUGIN_ROOT: REPO });
    expect(record().split("\n")[0]).toBe("codebuddy");
    // No tmp file left behind, whatever it was called.
    expect(readdirSync(join(home, ".siltpoke")).filter((n) => n.startsWith("last-host")).sort()).toEqual(["last-host"]);
  });

  test("an unwritable siltpoke home: exit 0 and not one byte on stdout or stderr", () => {
    // A FILE where the directory should be: mkdir and every write below it fail.
    writeFileSync(join(home, ".siltpoke"), "");
    const r = run("session-start.sh", { CODEBUDDY_PLUGIN_ROOT: REPO });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });
});

describe("every other wrapper records its host too", () => {
  test("stop.sh: before setup has run (no config.json)", () => {
    stub("codebuddy");
    const r = run("stop.sh", { CODEBUDDY_PLUGIN_ROOT: REPO });
    expect(r.code).toBe(0);
    expect(record()).toBe(`codebuddy\n${join(stubDir, "codebuddy")}\n`);
  });

  test("stop.sh: after setup too (config.json present, the bundle runs)", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    const r = run("stop.sh", { CODEBUDDY_PLUGIN_ROOT: REPO });
    expect(r.code).toBe(0);
    expect(record().split("\n")[0]).toBe("codebuddy");
  });

  // Root ignores directory permissions, so the write below would succeed.
  test.skipIf(process.getuid?.() === 0)("stop.sh: a siltpoke home that exists but cannot be written — silent, exit 0", () => {
    // A different failure from the file-in-place case above: mkdir succeeds
    // here, so it is the write itself that fails, and its error is the shell's
    // own ("cannot create …"), which a plain `2>/dev/null` on printf misses.
    const dir = join(home, ".siltpoke");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      const r = run("stop.sh", { CODEBUDDY_PLUGIN_ROOT: REPO });
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(r.out).toBe("");
      expect(existsSync(recordPath())).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("stop.sh: no host variable ⇒ nothing written", () => {
    run("stop.sh", {});
    expect(existsSync(recordPath())).toBe(false);
    // Positive control: the run got PAST the record, to the setup nudge, so the
    // absence above is the family rule and not a crash before it.
    expect(existsSync(join(home, ".siltpoke", ".setup-nudged"))).toBe(true);
  });

  test("a wrapper shipped without the helper still runs, silently, and records nothing", () => {
    // Every wrapper sources the helper behind `-r`. Under dash a failed `.` ends
    // the script with an error line in the user's session — so the guard has to
    // hold when the file is simply not there (a partial copy, an older package).
    const bare = join(sandbox, "bare-hooks");
    mkdirSync(bare, { recursive: true });
    copyFileSync(join(HOOKS, "stop.sh"), join(bare, "stop.sh"));
    for (const shell of ["/bin/sh", "/bin/dash"].filter((s) => existsSync(s))) {
      const proc = Bun.spawnSync([shell, join(bare, "stop.sh")], {
        stdin: new TextEncoder().encode("{}"),
        env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home, CODEBUDDY_PLUGIN_ROOT: REPO, SILTPOKE_INTERNAL: "" },
      });
      expect(proc.exitCode).toBe(0);
      expect(proc.stderr.toString()).toBe("");
      expect(existsSync(recordPath())).toBe(false);
    }
  });
});

// The helper holds its own family → command table, because a shell file cannot
// import the TypeScript one. Nothing else would notice the two drifting apart.
describe("hooks/lib/record-host.sh agrees with HOST_BINARY, family by family", () => {
  for (const family of FAMILIES) {
    test(family, () => {
      stub(HOST_BINARY[family]);
      const proc = Bun.spawnSync(
        ["/bin/sh", "-c", '. "$1"; siltpoke_record_host "$2"', "sh", join(HOOKS, "lib", "record-host.sh"), family],
        { env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home } },
      );
      expect(proc.exitCode).toBe(0);
      expect(record()).toBe(`${family}\n${join(stubDir, HOST_BINARY[family])}\n`);
    });
  }

  test("a name outside the five records nothing", () => {
    for (const name of ["antigravity", "qodercli", "", "claude code"]) {
      Bun.spawnSync(
        ["/bin/sh", "-c", '. "$1"; siltpoke_record_host "$2"', "sh", join(HOOKS, "lib", "record-host.sh"), name],
        { env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home } },
      );
    }
    expect(existsSync(recordPath())).toBe(false);
  });

  test("codex-session-start.sh", () => {
    stub("codex");
    run("codex-session-start.sh", {});
    expect(record()).toBe(`codex\n${join(stubDir, "codex")}\n`);
  });

  test("codex-stop.sh", () => {
    run("codex-stop.sh", {});
    expect(record().split("\n")[0]).toBe("codex");
  });

  test("agy-stop.sh", () => {
    stub("agy");
    run("agy-stop.sh", { ANTIGRAVITY_PLUGIN_ROOT: REPO });
    expect(record()).toBe(`agy\n${join(stubDir, "agy")}\n`);
  });
});

describe("a session siltpoke itself spawned records nothing (SILTPOKE_INTERNAL=1)", () => {
  const cases: Array<[string, Record<string, string>]> = [
    ["session-start.sh", { CODEBUDDY_PLUGIN_ROOT: REPO }],
    ["stop.sh", { CODEBUDDY_PLUGIN_ROOT: REPO }],
    ["codex-session-start.sh", {}],
    ["codex-stop.sh", {}],
    ["agy-stop.sh", { ANTIGRAVITY_PLUGIN_ROOT: REPO }],
  ];
  for (const [script, env] of cases) {
    test(script, () => {
      // The user's real record, written by their own qoder session.
      mkdirSync(join(home, ".siltpoke"), { recursive: true });
      writeFileSync(recordPath(), "qoder\n\n");
      const r = run(script, { ...env, SILTPOKE_INTERNAL: "1" });
      expect(r.code).toBe(0);
      expect(record()).toBe("qoder\n\n");
    });
  }
});

// The Windows path: hooks/siltpoke-hook.ps1 hands both events to this one
// TypeScript guard, so it has to keep the same record the shell wrappers do.
// Driven as a real process, like tests/hooks/hook-guard-runtime.test.ts.
describe("the Windows hook guard (src/hooks/hook-guard.ts) records the host", () => {
  const guard = join(REPO, "src", "hooks", "hook-guard.ts");

  async function runGuard(args: string[], env: Record<string, string>) {
    const sp = join(sandbox, "sp");
    const proc = Bun.spawn([process.execPath, guard, ...args], {
      env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home, SILTPOKE_HOME: sp, ...env },
      stdin: new TextEncoder().encode("{}"),
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    return { code: await proc.exited, err, file: recordPath(sp) };
  }

  test("stop: family and command path", async () => {
    stub("codebuddy");
    const r = await runGuard(["stop"], { CODEBUDDY_PLUGIN_ROOT: REPO });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(readFileSync(r.file, "utf8")).toBe(`codebuddy\n${join(stubDir, "codebuddy")}\n`);
  });

  test("session-start", async () => {
    const r = await runGuard(["session-start"], { QODER_PLUGIN_ROOT: REPO });
    expect(readFileSync(r.file, "utf8").split("\n")[0]).toBe("qoder");
  });

  test("no host variable: nothing written", async () => {
    const r = await runGuard(["stop"], {});
    expect(r.code).toBe(0);
    expect(existsSync(r.file)).toBe(false);
  });

  test("SILTPOKE_INTERNAL=1: nothing written", async () => {
    const r = await runGuard(["stop"], { CODEBUDDY_PLUGIN_ROOT: REPO, SILTPOKE_INTERNAL: "1" });
    expect(existsSync(r.file)).toBe(false);
  });

  test("--self-test is a probe, not a turn: nothing written", async () => {
    const r = await runGuard(["stop", "--self-test"], { CODEBUDDY_PLUGIN_ROOT: REPO });
    expect(r.code).toBe(0);
    expect(existsSync(r.file)).toBe(false);
  });
});

// Spec §12.4: `last-host` holds one line, so the Settings page could only show
// the last agent. Every write also touches `<home>/hosts-seen/<family>` (an
// empty file; its mtime is when that agent was last seen).
describe("hooks/lib/record-host.sh also records every agent seen", () => {
  const seenDir = () => join(home, ".siltpoke", "hosts-seen");
  const recordAs = (family: string) =>
    Bun.spawnSync(
      ["/bin/sh", "-c", '. "$1"; siltpoke_record_host "$2"', "sh", join(HOOKS, "lib", "record-host.sh"), family],
      { env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home } },
    );

  test("codex then claude: both are in hosts-seen, last-host is claude", () => {
    stub("codex");
    stub("claude");
    expect(recordAs("codex").exitCode).toBe(0);
    expect(recordAs("claude").exitCode).toBe(0);
    expect(readdirSync(seenDir()).sort()).toEqual(["claude", "codex"]);
    expect(record().split("\n")[0]).toBe("claude");
  });

  test("the first write seeds the agent already in last-host, with last-host's time", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(recordPath(), "qoder\n\n");
    const old = new Date("2026-09-01T10:00:00Z");
    utimesSync(recordPath(), old, old);
    recordAs("agy");
    expect(readdirSync(seenDir()).sort()).toEqual(["agy", "qoder"]);
    expect(statSync(join(seenDir(), "qoder")).mtime.getTime()).toBe(old.getTime());
  });

  // Small item [10]: two agents starting at once both find hosts-seen/ missing.
  // The later seed ran after the other had touched that family as seen NOW and
  // put it back to last-host's old time. Driven at the interleaving itself: the
  // folder is made and the family freshly touched, then the late seed runs.
  test("a late seed never sets back a family already marked seen", () => {
    const sp = join(home, ".siltpoke");
    mkdirSync(join(sp, "hosts-seen"), { recursive: true });
    writeFileSync(recordPath(), "qoder\n\n");
    const old = new Date("2026-09-01T10:00:00Z");
    utimesSync(recordPath(), old, old);
    writeFileSync(join(sp, "hosts-seen", "qoder"), "");
    const fresh = statSync(join(sp, "hosts-seen", "qoder")).mtime.getTime();
    const r = Bun.spawnSync(
      ["/bin/sh", "-c", '. "$1"; _siltpoke_seed_seen "$2" "$3"', "sh", join(HOOKS, "lib", "record-host.sh"), sp, join(sp, "hosts-seen")],
      { env: { PATH: "/usr/bin:/bin", HOME: home } },
    );
    expect(r.exitCode).toBe(0);
    expect(statSync(join(sp, "hosts-seen", "qoder")).mtime.getTime()).toBe(fresh);
    // Control: with no file yet, the same call does seed at last-host's time.
    rmSync(join(sp, "hosts-seen", "qoder"));
    Bun.spawnSync(
      ["/bin/sh", "-c", '. "$1"; _siltpoke_seed_seen "$2" "$3"', "sh", join(HOOKS, "lib", "record-host.sh"), sp, join(sp, "hosts-seen")],
      { env: { PATH: "/usr/bin:/bin", HOME: home } },
    );
    expect(statSync(join(sp, "hosts-seen", "qoder")).mtime.getTime()).toBe(old.getTime());
  });

  test("a damaged last-host seeds nothing", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(recordPath(), "../../etc\n\n");
    recordAs("agy");
    expect(readdirSync(seenDir())).toEqual(["agy"]);
  });

  test("a name outside the five touches nothing", () => {
    recordAs("antigravity");
    expect(existsSync(seenDir())).toBe(false);
  });

  // Review Focus 5: two agents ending a turn in the same instant. Real
  // processes, started together — a Promise.all over the sync TS writer
  // would run one after another and prove nothing.
  test("twenty writers at once, two agents: both seen, no tmp file left, last-host whole", async () => {
    stub("codex");
    stub("claude");
    const procs = Array.from({ length: 20 }, (_, i) =>
      Bun.spawn(
        [
          "/bin/sh",
          "-c",
          '. "$1"; siltpoke_record_host "$2"',
          "sh",
          join(HOOKS, "lib", "record-host.sh"),
          i % 2 === 0 ? "codex" : "claude",
        ],
        { env: { PATH: `${stubDir}:/usr/bin:/bin`, HOME: home } },
      ),
    );
    await Promise.all(procs.map((p) => p.exited));
    expect(readdirSync(seenDir()).sort()).toEqual(["claude", "codex"]);
    expect(readdirSync(join(home, ".siltpoke")).filter((n) => n.includes(".tmp"))).toEqual([]);
    expect(record()).toMatch(/^(codex|claude)\n\/.+\n$/);
  });

  test("an unwritable siltpoke home: exit 0, silent", () => {
    writeFileSync(join(home, ".siltpoke"), "a file, not a folder");
    const r = recordAs("codex");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString() + r.stderr.toString()).toBe("");
  });
});
