// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
/**
 * The restart-outcome status file — the channel that carries a restart result
 * past SwiftBar's `terminal=false`, which discards stdout and stderr.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRestartOutcome,
  writeRestartOutcome,
  restartOutcomePath,
} from "../../src/cli/restart-outcome";
import { runRestart, type ProbeResult } from "../../src/cli/daemon-restart";

const P = (pid: number): ProbeResult => ({ kind: "identified", identity: { pid } });
const NONE: ProbeResult = { kind: "none" };
import type { RestartOutcome } from "../../src/cli/restart-outcome";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "siltpoke-restart-outcome-"));
}

describe("restart outcome file", () => {
  test("round-trips", () => {
    const d = tmp();
    try {
      const o: RestartOutcome = { ok: false, at: "2026-07-22T02:00:00.000Z", summary: "didn't take effect", message: "still pid 1" };
      writeRestartOutcome(d, o);
      expect(readRestartOutcome(d)).toEqual(o);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("absent file reads as null, not as a fabricated outcome", () => {
    const d = tmp();
    try {
      expect(readRestartOutcome(d)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("malformed or half-written content reads as null", () => {
    // This file is read on the menu-bar render path. Anything unusable must
    // degrade to "no information" rather than putting undefined into a row.
    for (const bad of ['{"ok":true', "null", "[]", '{"ok":"yes","at":1,"message":null}', '{"ok":true,"at":"x"}']) {
      const d = tmp();
      try {
        mkdirSync(d, { recursive: true });
        writeFileSync(restartOutcomePath(d), bad);
        expect(readRestartOutcome(d)).toBeNull();
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  test("writing to an unwritable location does not throw", () => {
    expect(() =>
      writeRestartOutcome("/proc/nonexistent-nope", { ok: true, at: "x", summary: "s", message: "y" }),
    ).not.toThrow();
  });
});

describe("runRestart records every terminal path", () => {
  const capture = () => {
    const seen: RestartOutcome[] = [];
    return { seen, recordOutcome: (o: RestartOutcome) => seen.push(o) };
  };

  test("success is recorded as ok", async () => {
    const c = capture();
    const boots = [P(1), P(2)];
    let i = 0;
    await runRestart({
      exec: () => ({ status: 0 }), uid: 1, stdout: () => {}, stderr: () => {},
      probeBoot: async () => boots[Math.min(i++, boots.length - 1)],
      sleep: async () => {}, recordOutcome: c.recordOutcome,
      now: () => new Date("2026-07-22T02:00:00.000Z"),
    });
    expect(c.seen.length).toBe(1);
    expect(c.seen[0].ok).toBe(true);
    expect(c.seen[0].at).toBe("2026-07-22T02:00:00.000Z");
  });

  test("the no-op restart is recorded with the pid that never changed", async () => {
    const c = capture();
    await runRestart({
      exec: () => ({ status: 0 }), uid: 1, stdout: () => {}, stderr: () => {},
      probeBoot: async () => (P(23624)), sleep: async () => {}, recordOutcome: c.recordOutcome,
    });
    expect(c.seen.length).toBe(1);
    expect(c.seen[0].ok).toBe(false);
    expect(c.seen[0].message).toContain("23624");
    expect(c.seen[0].summary.length).toBeLessThan(30); // fits a menu row
  });

  test("nothing answering is recorded, and distinctly", async () => {
    const c = capture();
    await runRestart({
      exec: () => ({ status: 0 }), uid: 1, stdout: () => {}, stderr: () => {},
      probeBoot: async () => NONE, sleep: async () => {}, recordOutcome: c.recordOutcome,
    });
    expect(c.seen[0].ok).toBe(false);
    expect(c.seen[0].message).toContain("no daemon is answering");
    expect(c.seen[0].message).not.toContain("holding the port");
  });

  test("the not-autostart-managed path is recorded too", async () => {
    const c = capture();
    await runRestart({
      exec: () => ({ status: 3 }), uid: 1, stdout: () => {}, stderr: () => {},
      probeBoot: async () => NONE, sleep: async () => {}, recordOutcome: c.recordOutcome,
    });
    expect(c.seen.length).toBe(1);
    expect(c.seen[0].ok).toBe(false);
    expect(c.seen[0].message).toContain("autostart");
  });

  test("a recorder that throws never breaks the restart", async () => {
    const boots = [P(1), P(2)];
    let i = 0;
    const code = await runRestart({
      exec: () => ({ status: 0 }), uid: 1, stdout: () => {}, stderr: () => {},
      probeBoot: async () => boots[Math.min(i++, boots.length - 1)],
      sleep: async () => {},
      recordOutcome: () => { throw new Error("disk full"); },
    });
    expect(code).toBe(0);
  });
});

test("a file written by the previous build (no summary) still renders", () => {
  // `summary` was added after the first shipped format. Without a fallback the
  // menu row would read "⚠ Restart undefined" on the one upgrade where a
  // pre-existing file is still on disk.
  const d = tmp();
  try {
    mkdirSync(d, { recursive: true });
    writeFileSync(
      restartOutcomePath(d),
      JSON.stringify({ ok: false, at: "2026-07-22T02:00:00.000Z", message: "the old long message" }),
    );
    const got = readRestartOutcome(d);
    expect(got).not.toBeNull();
    expect(got!.summary).toBe("the old long message");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
