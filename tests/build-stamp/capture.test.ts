/**
 * Unit — build-stamp impure capture, with the filesystem and git injected.
 *
 * This file carries the property the pure formatter structurally cannot: that
 * the identity reported comes from the FILE THIS PROCESS LOADED, and from
 * nothing else. A capture that quietly read the checkout's HEAD would still
 * satisfy every assertion in format.test.ts, so the checks that matter here
 * are the negative ones — `rev-parse HEAD` must never be asked, and the boot
 * hash must survive the file changing underneath.
 */
import { describe, expect, test } from "bun:test";
import type { BuildStampIo } from "../../src/build-stamp/capture";
import type { BuildStamp } from "../../src/build-stamp/format";
import { captureBuildStamp, makeBuildStampReader, withTtl } from "../../src/build-stamp/capture";

const BOOT_BYTES = new TextEncoder().encode("boot bundle contents");
const REBUILT_BYTES = new TextEncoder().encode("rebuilt bundle contents");

/** Records every git argv so a test can assert what was NOT asked. */
interface Recorder {
  io: BuildStampIo;
  calls: string[][];
  setFile(bytes: Uint8Array | null): void;
}

function recorder(over: Partial<BuildStampIo> = {}): Recorder {
  const calls: string[][] = [];
  let bytes: Uint8Array | null = BOOT_BYTES;
  const io: BuildStampIo = {
    readFile: () => bytes,
    findRepoRoot: () => "/repo",
    gitOut: (_root, args) => {
      calls.push(args);
      if (args[0] === "log") {
        return "260245637da33b9b\x002026-08-18T22:37:47-07:00\x00fix(timeline): plain words (#607)";
      }
      if (args[0] === "rev-parse") return "origin/main-exists";
      if (args[0] === "rev-list") return "5";
      return null;
    },
    ...over,
  };
  return { io, calls, setFile: (b) => { bytes = b; } };
}

describe("captureBuildStamp — the path measured is argv[1], not the cwd", () => {
  test("bundlePath is the file this process loaded", () => {
    const r = recorder();
    const s = captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    expect(s.bundlePath).toBe("/repo/dist/siltpoke-daemon.js");
  });

  test("no argv[1] → everything null, nothing invented", () => {
    const r = recorder();
    const s = captureBuildStamp(undefined, r.io);
    expect(s.bundlePath).toBeNull();
    expect(s.bootSha256).toBeNull();
    expect(s.commit).toBeNull();
    expect(r.calls).toHaveLength(0);
  });

  test("unreadable bundle → null hashes, no throw, no git asked", () => {
    const r = recorder({ readFile: () => null });
    const s = captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    expect(s.bootSha256).toBeNull();
    expect(r.calls).toHaveLength(0);
  });
});

describe("captureBuildStamp — commit identity comes from content, not HEAD", () => {
  test("never asks git for the checkout's HEAD", () => {
    const r = recorder();
    captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    const askedHead = r.calls.some(
      (a) => a[0] === "rev-parse" && a.some((x) => x === "HEAD"),
    );
    expect(askedHead).toBe(false);
  });

  test("looks the commit up by the bundle's own blob oid, scoped to its path", () => {
    const r = recorder();
    captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    const logCall = r.calls.find((a) => a[0] === "log");
    expect(logCall).toBeDefined();
    // git's blob oid for "boot bundle contents" — sha1 of the "blob <len>\0" header
    // plus the bytes. Pinned so a change in how the oid is derived fails here.
    expect(logCall?.join(" ")).toContain("--find-object=21bd35ce223d242626aee7cfd981e579f332c538");
    expect(logCall?.at(-1)).toBe("dist/siltpoke-daemon.js");
  });

  test("parses the commit triple out of the NUL-separated log line", () => {
    const r = recorder();
    const s = captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    expect(s.commit).toBe("260245637da33b9b");
    expect(s.commitTime).toBe("2026-08-18T22:37:47-07:00");
    expect(s.commitSubject).toBe("fix(timeline): plain words (#607)");
  });

  test("no commit ships this content → nulls, and no behind-count is claimed", () => {
    const r = recorder({
      gitOut: (_root, args) => (args[0] === "log" ? "" : "5"),
    });
    const s = captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    expect(s.commit).toBeNull();
    expect(s.behindUpstream).toBeNull();
  });

  test("bundle outside any git repo → no commit, no throw", () => {
    const r = recorder({ findRepoRoot: () => null });
    const s = captureBuildStamp("/elsewhere/siltpoke-daemon.js", r.io);
    expect(s.commit).toBeNull();
    expect(s.behindUpstream).toBeNull();
    expect(r.calls).toHaveLength(0);
  });
});

describe("captureBuildStamp — the behind-count is measured from the BUILD's commit", () => {
  test("counts <build commit>..origin/main, not <HEAD>..origin/main", () => {
    const r = recorder();
    const s = captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    const revList = r.calls.find((a) => a[0] === "rev-list");
    expect(revList).toEqual([
      "rev-list",
      "--count",
      "260245637da33b9b..origin/main",
    ]);
    expect(s.behindUpstream).toBe(5);
    expect(s.upstreamRef).toBe("origin/main");
  });

  test("no origin/main in this clone → no count claimed", () => {
    const r = recorder({
      gitOut: (_root, args) => {
        if (args[0] === "log") return "abc\x002026-08-18T22:37:47-07:00\x00subj";
        if (args[0] === "rev-parse") return null; // origin/main missing
        return "5";
      },
    });
    const s = captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    expect(s.behindUpstream).toBeNull();
    expect(s.upstreamRef).toBeNull();
  });

  test("unparseable count → null, never NaN and never 0", () => {
    const r = recorder({
      gitOut: (_root, args) => {
        if (args[0] === "log") return "abc\x002026-08-18T22:37:47-07:00\x00subj";
        if (args[0] === "rev-parse") return "ok";
        return "not-a-number";
      },
    });
    const s = captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io);
    expect(s.behindUpstream).toBeNull();
  });
});

describe("makeBuildStampReader — boot half frozen, disk half live", () => {
  test("boot hash survives the file changing under the running process", () => {
    const r = recorder();
    const read = makeBuildStampReader("/repo/dist/siltpoke-daemon.js", r.io);
    const first = read();
    r.setFile(REBUILT_BYTES);
    const second = read();
    expect(second.bootSha256).toBe(first.bootSha256);
    expect(second.diskSha256).not.toBe(second.bootSha256);
  });

  test("a rebuild does not re-point the commit — the process still serves the old build", () => {
    const r = recorder();
    const read = makeBuildStampReader("/repo/dist/siltpoke-daemon.js", r.io);
    const first = read();
    r.setFile(REBUILT_BYTES);
    expect(read().commit).toBe(first.commit);
  });

  test("a boot read that FAILED never adopts the disk content as the boot build", () => {
    // `null` (the read failed) and `undefined` (nothing supplied yet) must stay
    // distinct: collapsing them makes the process report whatever is on disk
    // now as the code it is running.
    const r = recorder();
    const s = captureBuildStamp("/repo/dist/siltpoke-daemon.js", r.io, null);
    expect(s.bootSha256).toBeNull();
    expect(s.diskSha256).toBeNull();
    expect(s.commit).toBeNull();
    expect(r.calls).toHaveLength(0);
  });

  test("an unreadable file later on leaves diskSha256 null, boot half intact", () => {
    const r = recorder();
    const read = makeBuildStampReader("/repo/dist/siltpoke-daemon.js", r.io);
    const boot = read().bootSha256;
    r.setFile(null);
    const s = read();
    expect(s.bootSha256).toBe(boot);
    expect(s.diskSha256).toBeNull();
  });
});

describe("withTtl — the per-render cost is a property read, not a re-measure", () => {
  /** Distinct stamps so a cache hit is visibly distinguishable from a re-measure. */
  function counting(): { read: () => BuildStamp; count: () => number } {
    let n = 0;
    return {
      read: () => {
        n += 1;
        return { ...emptyish, bootSha256: `measure-${n}` };
      },
      count: () => n,
    };
  }
  const emptyish: BuildStamp = {
    bundlePath: "/repo/dist/siltpoke-daemon.js",
    bootSha256: null,
    diskSha256: null,
    commit: null,
    commitTime: null,
    commitSubject: null,
    behindUpstream: null,
    upstreamRef: null,
  };

  test("repeated reads inside the window measure once", () => {
    const c = counting();
    let clock = 1_000;
    const read = withTtl(c.read, 5_000, () => clock);
    read();
    clock += 4_999;
    const second = read();
    expect(c.count()).toBe(1);
    expect(second.bootSha256).toBe("measure-1");
  });

  test("the window expiring re-measures — a stale stamp is not held forever", () => {
    const c = counting();
    let clock = 1_000;
    const read = withTtl(c.read, 5_000, () => clock);
    read();
    clock += 5_000;
    expect(read().bootSha256).toBe("measure-2");
    expect(c.count()).toBe(2);
  });
});
