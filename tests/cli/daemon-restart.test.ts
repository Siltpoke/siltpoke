import { describe, test, expect } from "bun:test";
import {
  runRestart,
  classifyHealthResponse,
  isLaunchdJobInstalled,
  type ProbeResult,
} from "../../src/cli/daemon-restart";

type Boot = ProbeResult;
/** Shorthands so the fixtures stay readable against the 3-state probe. */
const P = (pid: number): ProbeResult => ({ kind: "identified", identity: { pid } });
const NONE: ProbeResult = { kind: "none" };
const OLD: ProbeResult = { kind: "unidentified" };

/**
 * `boots` is the sequence probeBoot() returns on successive calls: index 0 is
 * the pre-kickstart read, the rest are the post-kickstart polls. The last value
 * repeats once exhausted, which is what a daemon that never changes looks like.
 */
function spy(status: number, boots: Boot[] = [NONE, NONE]) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const out: string[] = [];
  const err: string[] = [];
  let i = 0;
  return {
    calls, out, err,
    probes: () => i,
    deps: {
      exec: (cmd: string, args: string[]) => (calls.push({ cmd, args }), { status }),
      uid: 501,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      probeBoot: async (): Promise<Boot> => boots[Math.min(i++, boots.length - 1)],
      sleep: async () => {},
      // Never let a unit test actually shell out to `open` — the real default
      // would fire a live SwiftBar refresh from every test run on macOS.
      triggerMenubarRefresh: () => {},
    },
  };
}

describe("runRestart", () => {
  test("kickstart -k the daemon under gui/<uid>; exit 0 (AC22)", async () => {
    const s = spy(0, [P(1), P(2)]);
    const code = await runRestart(s.deps);
    expect(code).toBe(0);
    expect(s.calls).toEqual([
      { cmd: "launchctl", args: ["kickstart", "-k", "gui/501/io.siltpoke.daemon"] },
    ]);
    expect(s.out.join("")).toContain("restarted");
  });

  test("kickstart failure → exit 1, friendly stderr, no spawn fallback", async () => {
    const s = spy(3);
    const code = await runRestart(s.deps);
    expect(code).toBe(1);
    expect(s.err.join("")).toContain("siltpoked start");
    // only the one kickstart attempt — no stop+start fallback
    expect(s.calls.length).toBe(1);
  });

  // --- the bug this rewrite exists for ---
  //
  // `launchctl kickstart` exits 0 whenever the JOB exists. It says nothing
  // about whether the daemon actually serving the dashboard changed. When a
  // non-launchd process holds the port, the kicked job cannot bind, dies, and
  // the orphan keeps serving — so "restarted" was printed while nothing moved,
  // and the dashboard rightly went on reporting itself behind. Reporting
  // success off the exit code is the defect; the observable outcome is the
  // only thing worth reporting.

  test("kickstart succeeds but the serving daemon never changes → exit 1 and say so", async () => {
    const s = spy(0, [P(7)]); // every poll returns the same boot
    const code = await runRestart(s.deps);
    expect(code).toBe(1);
    const msg = s.err.join("");
    expect(msg).toContain("did not change");
    // must not claim success
    expect(s.out.join("")).not.toContain("restarted");
    // and must point at the actual cause rather than leaving the user guessing
    expect(msg).toMatch(/lsof|holding the port|another process/i);
  });

  test("nothing was serving before, and something answers after → success", async () => {
    const s = spy(0, [NONE, NONE, P(2)]);
    const code = await runRestart(s.deps);
    expect(code).toBe(0);
    expect(s.out.join("")).toContain("restarted");
  });

  test("nothing was serving before and nothing answers after → exit 1, distinct message", async () => {
    const s = spy(0, [NONE]);
    const code = await runRestart(s.deps);
    expect(code).toBe(1);
    expect(s.err.join("")).toContain("no daemon is answering");
  });

  test("polls more than once before giving up (a slow boot is not a failure)", async () => {
    const s = spy(0, [P(1), P(1), P(1), P(2)]);
    const code = await runRestart(s.deps);
    expect(code).toBe(0);
    expect(s.probes()).toBeGreaterThan(2);
  });

  test("a probe that throws is treated as 'not answering', never as success", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const err: string[] = [];
    const out: string[] = [];
    const code = await runRestart({
      exec: (cmd: string, args: string[]) => (calls.push({ cmd, args }), { status: 0 }),
      uid: 501,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      probeBoot: async () => { throw new Error("ECONNREFUSED"); },
      sleep: async () => {},
      triggerMenubarRefresh: () => {},
    });
    expect(code).toBe(1);
    expect(out.join("")).not.toContain("restarted");
    // The message is the deliverable of this fix, so pin it: a probe that
    // throws means we never learned anything, which must read as "nothing
    // answered" — not as "it answered and looked unchanged". Asserting only the
    // exit code lets a mutation that fabricates a boot identity survive, since
    // a fabricated-but-constant identity also fails to change.
    expect(err.join("")).toContain("no daemon is answering");
  });
});

describe("runRestart — diagnosis accuracy", () => {
  // Reviewer finding: the failure message was chosen from the PRE-kick probe,
  // so "something was serving, then the kick killed it and nothing came back"
  // was reported as "another process is holding the port" — pointing the user
  // at an lsof hunt for a squatter that does not exist. The message must be
  // keyed on what is serving NOW, not on what was serving before.
  test("the old daemon dies and nothing replaces it → say nothing is answering, not 'port held'", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const boots: ProbeResult[] = [P(1), NONE];
    let i = 0;
    const code = await runRestart({
      exec: () => ({ status: 0 }),
      uid: 501,
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
      probeBoot: async () => boots[Math.min(i++, boots.length - 1)],
      sleep: async () => {},
      triggerMenubarRefresh: () => {},
    });
    expect(code).toBe(1);
    const msg = err.join("");
    expect(msg).toContain("no daemon is answering");
    expect(msg).not.toMatch(/lsof|holding the port/i);
    expect(out.join("")).not.toContain("restarted");
  });

  test("a restart with no new commit in between still counts as a restart", async () => {
    // The defect this rewrite fixes: the first implementation compared the
    // daemon-health `bootTime`, which is the COMMITTER DATE of HEAD, not a
    // per-process value. Two processes booted from the same commit report the
    // identical string, so bouncing the daemon without committing anything read
    // as failure — the mirror image of the bug being fixed. Identity must be
    // per-process.
    const out: string[] = [];
    const boots = [P(100), P(200)];
    let i = 0;
    const code = await runRestart({
      exec: () => ({ status: 0 }),
      uid: 501,
      stdout: (s: string) => out.push(s),
      stderr: () => {},
      probeBoot: async () => boots[Math.min(i++, boots.length - 1)],
      sleep: async () => {},
      triggerMenubarRefresh: () => {},
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("restarted");
  });

  test("the poll actually waits between attempts", async () => {
    // Otherwise POLL_INTERVAL_MS is an unpinned knob and a mutation to it
    // survives the suite (reviewer finding 5).
    const waits: number[] = [];
    await runRestart({
      exec: () => ({ status: 0 }),
      uid: 501,
      stdout: () => {},
      stderr: () => {},
      probeBoot: async () => (P(1)),
      sleep: async (ms: number) => { waits.push(ms); },
      triggerMenubarRefresh: () => {},
    });
    expect(waits.length).toBeGreaterThan(1);
    expect(waits.every((w) => w > 0)).toBe(true);
  });
});

describe("runRestart — a daemon too old to identify itself", () => {
  // Found by the live smoke, not by any unit test: the daemon still running
  // during the upgrade that ADDS `pid` to /api/daemon-health answers perfectly
  // well but has no pid to report. Treating that as "nothing answered" printed
  // "no daemon is answering on :9876" while the dashboard was plainly open —
  // the same message-does-not-match-reality failure this track exists to end,
  // and every user hits it exactly once, on the upgrade.
  const drive = async (boots: ProbeResult[]) => {
    const out: string[] = [];
    const err: string[] = [];
    let i = 0;
    const code = await runRestart({
      exec: () => ({ status: 0 }), uid: 501,
      stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s),
      probeBoot: async () => boots[Math.min(i++, boots.length - 1)],
      sleep: async () => {},
      triggerMenubarRefresh: () => {},
    });
    return { code, out: out.join(""), err: err.join("") };
  };

  test("an old daemon that never goes away is NOT reported as 'nothing answering'", async () => {
    const r = await drive([OLD]);
    expect(r.code).toBe(1);
    expect(r.err).not.toContain("no daemon is answering");
    expect(r.err).toContain("too old to report which process it is");
    expect(r.err).toContain("lsof"); // it IS holding the port, so point at it
    expect(r.out).not.toContain("restarted");
  });

  test("an old daemon replaced by an identifiable one is a successful restart", async () => {
    // The normal upgrade path: old build serving, restart brings up the new
    // build, which can identify itself.
    const r = await drive([OLD, P(999)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("restarted");
  });

  test("nothing serving, then an old build answers → still a successful restart", async () => {
    const r = await drive([NONE, OLD]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("restarted");
  });
});

describe("runRestart — FIX C: post-outcome SwiftBar refresh trigger", () => {
  // The row's own `refresh=true` fires ON CLICK, before this function's kick +
  // verify loop has even started — too early to show the outcome it triggers.
  // `triggerMenubarRefresh` must fire AFTER the outcome is known, on both the
  // success and the failure path, exactly once, and must never be allowed to
  // affect the exit code even if it throws.

  test("a successful restart triggers the menubar refresh once", async () => {
    let calls = 0;
    const boots: ProbeResult[] = [NONE, P(1)]; // nothing serving → then a fresh pid
    let i = 0;
    const code = await runRestart({
      exec: () => ({ status: 0 }),
      uid: 501,
      stdout: () => {},
      stderr: () => {},
      probeBoot: async () => boots[Math.min(i++, boots.length - 1)],
      sleep: async () => {},
      triggerMenubarRefresh: () => { calls++; },
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
  });

  test("a failed restart (kickstart itself fails) still triggers the menubar refresh", async () => {
    let calls = 0;
    const code = await runRestart({
      exec: () => ({ status: 3 }),
      uid: 501,
      stdout: () => {},
      stderr: () => {},
      probeBoot: async () => NONE,
      sleep: async () => {},
      triggerMenubarRefresh: () => { calls++; },
    });
    expect(code).toBe(1);
    expect(calls).toBe(1);
  });

  test("a failed restart (port never changes) still triggers the menubar refresh", async () => {
    let calls = 0;
    const code = await runRestart({
      exec: () => ({ status: 0 }),
      uid: 501,
      stdout: () => {},
      stderr: () => {},
      probeBoot: async () => P(7), // never changes
      sleep: async () => {},
      triggerMenubarRefresh: () => { calls++; },
    });
    expect(code).toBe(1);
    expect(calls).toBe(1);
  });

  test("a refresh trigger that throws never fails the restart", async () => {
    const boots: ProbeResult[] = [NONE, P(1)];
    let i = 0;
    const code = await runRestart({
      exec: () => ({ status: 0 }),
      uid: 501,
      stdout: () => {},
      stderr: () => {},
      probeBoot: async () => boots[Math.min(i++, boots.length - 1)],
      sleep: async () => {},
      triggerMenubarRefresh: () => { throw new Error("open: command not found"); },
    });
    expect(code).toBe(0);
  });
});

describe("isLaunchdJobInstalled", () => {
  test("true when `launchctl print gui/<uid>/<label>` exits 0", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec = (cmd: string, args: string[]) => (calls.push({ cmd, args }), { status: 0 });
    expect(isLaunchdJobInstalled(exec, 501)).toBe(true);
    expect(calls).toEqual([
      { cmd: "launchctl", args: ["print", "gui/501/io.siltpoke.daemon"] },
    ]);
  });

  test("false on any non-zero exit (no job registered)", () => {
    const exec = () => ({ status: 3 });
    expect(isLaunchdJobInstalled(exec, 501)).toBe(false);
  });

  test("false when the job cannot even be queried (null status)", () => {
    const exec = () => ({ status: null });
    expect(isLaunchdJobInstalled(exec, 501)).toBe(false);
  });
});

describe("classifyHealthResponse", () => {
  // The step the live smoke proved wrong. A daemon from before `pid` existed
  // answers 200 with a perfectly valid body — calling that "nothing answered"
  // produced "no daemon is answering on :9876" with the dashboard open.
  test("a healthy answer WITHOUT pid is 'unidentified', never 'none'", () => {
    const body = { success: true, data: { bootSha: "abc", bootTime: "t", state: "behind" } };
    expect(classifyHealthResponse(true, body)).toEqual({ kind: "unidentified" });
  });

  test("a healthy answer WITH pid is identified", () => {
    const body = { data: { pid: 42, startedAt: "2026-07-22T00:00:00Z" } };
    expect(classifyHealthResponse(true, body)).toEqual({
      kind: "identified",
      identity: { pid: 42, startedAt: "2026-07-22T00:00:00Z" },
    });
  });

  test("a non-200 is 'none'", () => {
    expect(classifyHealthResponse(false, { data: { pid: 42 } })).toEqual({ kind: "none" });
  });

  test("junk in the pid field degrades to 'unidentified', not to a fake pid", () => {
    for (const pid of ["42", null, NaN, {}, undefined]) {
      expect(classifyHealthResponse(true, { data: { pid } })).toEqual({ kind: "unidentified" });
    }
  });

  test("a missing body is 'unidentified' — something answered", () => {
    expect(classifyHealthResponse(true, null)).toEqual({ kind: "unidentified" });
  });
});
