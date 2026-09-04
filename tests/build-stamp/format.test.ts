/**
 * Unit — build-stamp pure derivation (drift + the one-line footer).
 *
 * The load-bearing property: this line must never claim a build identity it
 * did not measure. The pre-existing daemon-health signal reports the CHECKOUT's
 * git HEAD at boot, which is not the code the process loaded — a directory can
 * sit on main while the running process serves a bundle built from another
 * branch. Every case below pins which of the three layers produced the verdict:
 *   ③ process — the bundle this process loaded (bootSha256)
 *   ② dist    — that same path's content right now (diskSha256)
 *   ① branch  — the commit whose committed copy of that path IS bootSha256
 */
import { describe, expect, test } from "bun:test";
import { type BuildStamp, driftBetween, formatBuildLine } from "../../src/build-stamp/format";

/** A stamp with every field measured and agreeing — the quiet case. */
function healthyStamp(over: Partial<BuildStamp> = {}): BuildStamp {
  return {
    bundlePath: "/repo/dist/siltpoke-daemon.js",
    bootSha256: "9a1e6d3d7ab22295",
    diskSha256: "9a1e6d3d7ab22295",
    commit: "260245637da33b9b5d1f585fd1bcfd51db1f06ce",
    commitTime: "2026-08-18T22:37:47-07:00",
    commitSubject: "fix(timeline): say why the audit blocks are empty (#607)",
    behindUpstream: 0,
    upstreamRef: "origin/main",
    ...over,
  };
}

describe("driftBetween", () => {
  test("same content → same", () => {
    expect(driftBetween("aaa", "aaa")).toBe("same");
  });

  test("disk moved under a running process → rebuilt-since-boot", () => {
    expect(driftBetween("aaa", "bbb")).toBe("rebuilt-since-boot");
  });

  test("unmeasured boot hash → unknown, never 'same'", () => {
    expect(driftBetween(null, "bbb")).toBe("unknown");
  });

  test("unmeasured disk hash → unknown (file deleted under the process)", () => {
    expect(driftBetween("aaa", null)).toBe("unknown");
  });
});

describe("formatBuildLine — absent source degrades to nothing, not to a guess", () => {
  test("no bundle path measured → show:false, empty text", () => {
    const line = formatBuildLine(healthyStamp({ bundlePath: null, bootSha256: null }));
    expect(line.show).toBe(false);
    expect(line.text).toBe("");
  });

  test("bundle measured but not inside any git repo → shown, neutral, no commit claim", () => {
    const line = formatBuildLine(
      healthyStamp({ commit: null, commitTime: null, commitSubject: null, behindUpstream: null }),
    );
    expect(line.show).toBe(true);
    expect(line.state).toBe("unknown");
    expect(line.text).toContain("9a1e6d3");
    expect(line.text).toContain("uncommitted build");
  });
});

describe("formatBuildLine — layer ② dist rebuilt under the running process", () => {
  test("boot hash ≠ disk hash → warn, and the fix named is restart", () => {
    const line = formatBuildLine(healthyStamp({ diskSha256: "ffffffffffffffff" }));
    expect(line.state).toBe("warn");
    expect(line.text).toContain("restart");
  });

  test("rebuilt AND uncommitted → the hash is marked, not passed off as a commit", () => {
    // A commit sha and a content sha256 are both hex. Dropping the marker here
    // would put a content hash in the slot a reader reads as a commit id —
    // the same substitution this whole line exists to stop.
    const line = formatBuildLine(
      healthyStamp({ diskSha256: "ffffffffffffffff", commit: null, commitSubject: null }),
    );
    expect(line.state).toBe("warn");
    expect(line.text).toContain("uncommitted");
    expect(line.text).toContain("9a1e6d3");
  });

  test("rebuilt outranks behind — the stale process is the nearer cause", () => {
    const line = formatBuildLine(
      healthyStamp({ diskSha256: "ffffffffffffffff", behindUpstream: 5 }),
    );
    expect(line.state).toBe("warn");
    expect(line.text).toContain("restart");
    expect(line.text).not.toContain("behind");
  });
});

describe("formatBuildLine — layer ① which commit this code came from", () => {
  test("commit matched and up to date → ok, short sha + commit time", () => {
    const line = formatBuildLine(healthyStamp());
    expect(line.state).toBe("ok");
    expect(line.text).toContain("2602456");
    expect(line.text).toContain("08-18 22:37");
  });

  test("checkout behind upstream → warn, names the ref and the count", () => {
    const line = formatBuildLine(healthyStamp({ behindUpstream: 5 }));
    expect(line.state).toBe("warn");
    expect(line.text).toContain("5 behind origin/main");
  });

  test("behindUpstream unmeasured is not behindUpstream 0 — no false all-clear", () => {
    const line = formatBuildLine(healthyStamp({ behindUpstream: null }));
    expect(line.state).toBe("ok");
    expect(line.text).not.toContain("behind");
  });

  test("the running build's commit is what is shown, never the checkout's HEAD", () => {
    // A process serving a bundle built on another branch: the line must name
    // THAT commit. Nothing in this fn is allowed to read a checkout HEAD.
    const line = formatBuildLine(
      healthyStamp({
        commit: "b5010a2e9c0d0db9f6b42a1eb0cd4e4fc7c555c0",
        commitSubject: "fix(timeline): rewrite the absence copy in plain words",
      }),
    );
    expect(line.text).toContain("b5010a2");
    expect(line.text).not.toContain("2602456");
  });

  test("title carries the subject and the measured path (the audit trail)", () => {
    const line = formatBuildLine(healthyStamp());
    expect(line.title).toContain("say why the audit blocks are empty");
    expect(line.title).toContain("/repo/dist/siltpoke-daemon.js");
  });
});
