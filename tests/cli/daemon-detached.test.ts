// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The daemon must be spawned into its own process group, and `/siltpoke:siltpoke-dashboard`
// must not promise a URL for a server that has already died.
//
// WHY THESE EXIST. Measured on a real Windows 10 box, 2026-09-24:
// `/siltpoke:siltpoke-dashboard` printed `http://127.0.0.1:9876/`, exited 0, and nothing
// was listening on the port seconds later. The daemon genuinely started — it
// answered `/api/ping` before the URL was printed — and was then killed along
// with the short-lived CLI process that spawned it.
//
// The cause was one missing option. THREE separate call sites spawned the
// daemon with `stdio: ignore` + `unref()` and no `detached`, while the code
// around them said otherwise: a comment in `dashboard.ts` reading "Lazy-spawn
// detached daemon", a parameter in `daemon.ts` literally named `detach`, and a
// function in `on-stop.ts` named `respawnDaemonDetached`. The repo already used
// `detached: true` correctly in three unrelated places, so this was not
// unknown — it was three siblings that had dropped a defence the codebase
// otherwise applies. On Unix the omission is invisible (the child is
// re-parented to init), which is why it survived this long.
//
// `unref()` is not a substitute: it releases the PARENT's event loop from
// waiting on the child. It says nothing about which process group the child is
// in, and process-group membership is what decides whether the child dies with
// its parent.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonSpawnOptions, openDashboard } from "../../src/cli/dashboard";
import { acquireLock } from "../../src/utils/process-lock";

const REPO = join(import.meta.dir, "..", "..");

function source(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

describe("openDashboard — how the daemon is spawned", () => {
  test("the daemon is spawned detached, with stdio fully ignored", async () => {
    let seen: DaemonSpawnOptions | null = null;
    let pings = 0;
    await openDashboard({
      noOpen: true,
      out: () => {},
      // false on the first call (so it spawns), true afterwards.
      isDaemonUp: async () => pings++ > 0,
      daemonArgv: ["/fake/bun", "/fake/daemon.js", "start"],
      spawnDaemon: (_argv, o) => {
        seen = o;
        return { unref: () => {} };
      },
    });
    expect(seen).not.toBeNull();
    expect((seen as unknown as DaemonSpawnOptions).detached).toBe(true);
    expect((seen as unknown as DaemonSpawnOptions).stdio).toEqual(["ignore", "ignore", "ignore"]);
  });

  test("the argv it spawns is passed through untouched", async () => {
    let argv: readonly string[] = [];
    let pings = 0;
    await openDashboard({
      noOpen: true,
      out: () => {},
      isDaemonUp: async () => pings++ > 0,
      daemonArgv: ["/abs/path/to/bun", "/abs/path/to/daemon.js", "start"],
      spawnDaemon: (a) => {
        argv = a;
        return { unref: () => {} };
      },
    });
    expect(argv).toEqual(["/abs/path/to/bun", "/abs/path/to/daemon.js", "start"]);
  });
});

describe("openDashboard — refusing to promise a dead URL", () => {
  test("a daemon that answers the poll and then dies produces an error, not a URL", async () => {
    // The exact Windows shape: the server starts, answers once, and is gone by
    // the time we would print its address.
    const calls: boolean[] = [false, true, false];
    let i = 0;
    const printed: string[] = [];
    await expect(
      openDashboard({
        noOpen: true,
        out: (s) => printed.push(s),
        isDaemonUp: async () => calls[Math.min(i++, calls.length - 1)] ?? false,
        daemonArgv: ["/fake/bun", "/fake/daemon.js", "start"],
        spawnDaemon: () => ({ unref: () => {} }),
      }),
    ).rejects.toThrow(/stopped answering/);
    // The point of the whole check: no URL reached the user.
    expect(printed.join("")).not.toContain("http://");
  });

  test("a daemon that stays up still prints its URL", async () => {
    let i = 0;
    const printed: string[] = [];
    await openDashboard({
      noOpen: true,
      out: (s) => printed.push(s),
      isDaemonUp: async () => i++ > 0,
      daemonArgv: ["/fake/bun", "/fake/daemon.js", "start"],
      spawnDaemon: () => ({ unref: () => {} }),
    });
    expect(printed.join("")).toContain("http://127.0.0.1:9876/");
  });

  test("an already-running daemon is not re-spawned", async () => {
    let spawned = 0;
    await openDashboard({
      noOpen: true,
      out: () => {},
      isDaemonUp: async () => true,
      daemonArgv: ["/fake/bun", "/fake/daemon.js", "start"],
      spawnDaemon: () => {
        spawned++;
        return { unref: () => {} };
      },
    });
    expect(spawned).toBe(0);
  });
});

// The sibling guard — DERIVED, not hand-listed.
//
// The first draft of this block hard-listed the three files the fix touched,
// and wrote that "nothing stops a FOURTH from being added without `detached`".
// That sentence was false when it was written: a fourth site already existed
// (`src/hooks/agy-stop.ts`) and a fifth carried half the defect
// (`src/memory/distil-launcher.ts`), and a list of known-good files is blind to
// both by construction. A reviewer found them; the guard could not have.
//
// So this sweeps the source tree instead. Any file that dispatches a
// background child which must outlive its parent has to pass `detached`, and
// none may spawn a bare "bun".
describe("no background-dispatch spawn may drop the defence", () => {
  // Files whose job is to hand work to a child that outlives them. Derived
  // membership would be better still, but "does this child outlive its parent"
  // is not readable from a grep — so this list is the one human judgement, and
  // the ASSERTIONS below are what a new file cannot quietly sidestep.
  const BACKGROUND_DISPATCHERS = [
    "src/cli/dashboard.ts",
    "src/cli/daemon.ts",
    "src/hooks/on-stop.ts",
    "src/hooks/agy-stop.ts",
    "src/memory/distil-launcher.ts",
  ];

  /**
   * A spawn argv whose interpreter is the bare word "bun".
   *
   * Narrowed past `["bun",` alone because that also matches lists of binary
   * NAMES — `["bun", "claude"]` in daemon-path.ts, `["bun", "git", "brew",
   * "node"]` in prereq.ts — which are lookups, not spawns. The discriminator is
   * the second element: a spawn passes a path or a variable, a name list passes
   * another short bare word.
   */
  const BARE_BUN_ARGV = /\[\s*"bun"\s*,\s*(?:[A-Za-z_$][\w$]*|"[^"]*[/.][^"]*")/;

  /** Strip comments, so a guard cannot be satisfied by prose about itself. */
  function code(rel: string): string {
    return source(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  for (const rel of BACKGROUND_DISPATCHERS) {
    test(`${rel} passes detached in CODE, not merely in a comment`, () => {
      // `toContain` over the raw file was vacuous for dashboard.ts: the string
      // appears in its options interface and twice in prose, so the assertion
      // passed regardless of what the spawn call did. Comments are stripped
      // first now — the whole defect class here is text claiming a property
      // nothing enforces, and a guard made of text is one more instance of it.
      expect(code(rel)).toContain("detached: true");
    });

    test(`${rel} does not spawn a bare "bun"`, () => {
      expect(code(rel)).not.toMatch(BARE_BUN_ARGV);
    });
  }

  test("every spawn seam in these files makes detached required, not optional", () => {
    // `detached?: boolean` would let a future edit drop the flag with the suite
    // green. Required means the compiler holds the line, not the test.
    for (const rel of ["src/cli/dashboard.ts", "src/hooks/on-stop.ts", "src/hooks/agy-stop.ts"]) {
      expect(code(rel)).toMatch(/detached:\s*true[;,]/);
      expect(code(rel)).not.toMatch(/detached\?:/);
    }
  });

  test("no test pins a bare-\"bun\" spawn argv as the expected value", () => {
    // Three separate tests asserted `toEqual(["bun", …])` against a spawn argv,
    // and all three had titles claiming the child was "detached". A test that
    // pins the defect is worse than no test: it makes the wrong shape look
    // deliberate, and the next person to touch it sees a red and "fixes" the
    // code back. Found by the gate on the third one, after the other two had
    // already been fixed by hand.
    const scanned = [...new Bun.Glob("tests/**/*.ts").scanSync({ cwd: REPO })];
    expect(scanned.length).toBeGreaterThan(100);
    const offenders = scanned.filter((rel) =>
      /toEqual\(\s*\[\s*\n?\s*"bun"\s*,/.test(code(rel)),
    );
    expect(offenders).toEqual([]);
  });

  test("the dispatcher list covers every src file that spawns a bare \"bun\"", () => {
    // The backstop for the one human judgement above. If a NEW file starts
    // spawning `["bun", …]`, this fails and names it — so the list cannot
    // silently fall behind the tree the way the first draft's did.
    const scanned = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: REPO })];
    // Positive control. `scanSync` returns an ITERATOR, and the first draft of
    // this test filtered it directly — which silently produced `{}` and would
    // have passed as "no offenders" while scanning nothing at all. Two empty
    // sides look identical to a real pass (memory:
    // `empty-set-comparison-is-not-evidence`), so assert the sweep saw a tree.
    expect(scanned.length).toBeGreaterThan(100);
    const offenders = scanned.filter((rel) => BARE_BUN_ARGV.test(code(rel)));
    expect(offenders).toEqual([]);
  });
});

// The report's third suggested fix — "self-heal the stale lock" — read as if
// nothing cleaned up after a dead daemon. Checked here rather than repeated
// back, because the code says otherwise and a second reading is not a check.
describe("a dead daemon's leftovers do not need a human", () => {
  test("acquireLock reclaims a lock whose owner pid is gone", () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-lock-"));
    const lockPath = join(home, "siltpoked.lock");
    mkdirSync(lockPath, { recursive: true });
    // A pid that cannot be alive. 2^31-1 is above every platform's pid_max.
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2147483647, startedAt: Date.now(), host: "x", version: "0" }),
    );

    const handle = acquireLock(lockPath, { version: "test", heartbeatMs: 60_000 });
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
      expect(owner.pid).toBe(process.pid);
    } finally {
      // LockHandle owns a heartbeat interval, not a release() — clear it or the
      // test process never exits.
      clearInterval(handle.heartbeat);
    }
  });

  test("a live owner is still respected — the reclaim is not unconditional", () => {
    // The positive control. Without it, a reclaim that ignored liveness
    // entirely would pass the test above and let two daemons run at once.
    const home = mkdtempSync(join(tmpdir(), "siltpoke-lock-"));
    const lockPath = join(home, "siltpoked.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: "x", version: "0" }),
    );
    expect(() => acquireLock(lockPath, { version: "test", heartbeatMs: 60_000 })).toThrow();
  });
});
