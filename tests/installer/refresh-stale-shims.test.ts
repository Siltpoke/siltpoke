// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [25]: a plugin upgrade does not refresh ~/.siltpoke/bin/.
//
// `hooks/*.sh` ship with the plugin, so `claude plugin update` replaces them.
// The two shims do NOT ship — they are GENERATED text, written only by setup.
// So after any upgrade the statusline and the daemon unit keep executing
// whatever setup wrote, however long ago, and nothing says so.
//
// Measured on the maintainer's own machine right after #804 merged: the plugin
// cache had no `hooks/lib/` at all and `~/.siltpoke/bin/statusline.sh` was dated
// 2026-08-13, still carrying the `command -v bun … || exit 0` that #804 existed
// to remove. The fix shipped and the machine kept the bug.
//
// Two hard constraints, and both are the point:
//   1. Refresh only shims that ALREADY EXIST. A user who never opted into the
//      statusline must not have one appear — `resolveDaemonLauncher` and
//      `checkStatuslineInterpreter` both change their answer when these files
//      exist, so creating one speculatively is a behaviour change, not a fix.
//   2. Write only when the content actually differs. This runs on every
//      SessionStart; an unconditional write would be two file writes per
//      session, forever, for nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionStart } from "../../src/hooks/handle-session-start";
import {
  daemonShimPath,
  refreshStaleShims,
  renderDaemonShim,
  renderStatuslineShim,
  statuslineShimPath,
  writeShim,
} from "../../src/installer/shim";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-refresh-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** The shape the bug leaves behind: an old shim, written by an older setup. */
function staleStatuslineShim(): string {
  const path = statuslineShimPath(home);
  mkdirSync(join(home, ".siltpoke", "bin"), { recursive: true });
  writeFileSync(path, '#!/bin/sh\ncommand -v bun > /dev/null 2>&1 || exit 0\nexec bun "$CARD"\n');
  return path;
}

describe("refreshStaleShims", () => {
  test("rewrites a stale statusline shim to the current text", async () => {
    const path = staleStatuslineShim();
    const rewritten = await refreshStaleShims(home);
    expect(rewritten).toContain(path);
    expect(readFileSync(path, "utf8")).toBe(renderStatuslineShim());
  });

  test("rewrites a stale daemon shim too", async () => {
    mkdirSync(join(home, ".siltpoke", "bin"), { recursive: true });
    const path = daemonShimPath(home);
    writeFileSync(path, "#!/bin/sh\nexec bun /old/versioned/path/daemon.js\n");
    const rewritten = await refreshStaleShims(home);
    expect(rewritten).toContain(path);
    expect(readFileSync(path, "utf8")).toBe(renderDaemonShim());
  });

});

describe("refreshStaleShims does nothing when it should not", () => {
  test("does NOT create a shim that was never there", async () => {
    // A user who never opted into the statusline. Creating the file would change
    // what resolveDaemonLauncher and the doctor rows answer.
    //
    // Mutation note, so a green here is not over-read: deleting the
    // `existsSync` guard ALONE leaves this test green, because readFileSync
    // then throws into the catch and the loop moves on. What this test does
    // catch is the shape that actually matters — writing without checking
    // anything (measured: remove both guards and this plus two others go red).
    // The guard stays because explicit intent beats relying on that throw.
    const rewritten = await refreshStaleShims(home);
    expect(rewritten).toEqual([]);
    expect(existsSync(statuslineShimPath(home))).toBe(false);
    expect(existsSync(daemonShimPath(home))).toBe(false);
  });

  test("leaves an already-current shim untouched — no write per session", async () => {
    const path = await writeShim(home); // current text, by definition
    const before = statSync(path).mtimeMs;
    const rewritten = await refreshStaleShims(home);
    expect(rewritten).toEqual([]);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  test("keeps the executable bit — a shim that cannot be exec'd is worse than a stale one", async () => {
    const path = staleStatuslineShim();
    chmodSync(path, 0o755);
    await refreshStaleShims(home);
    // 0o111 = any execute bit. The statusLine command runs this file directly.
    expect(statSync(path).mode & 0o111).not.toBe(0);
  });

  // This machine routinely runs two Claude Code sessions, so two SessionStart
  // hooks call this at once with the same $HOME. The tmp+rename dance only holds
  // if the scratch name is unique per call: with a shared `<path>.tmp` the
  // interleaving write-A / write-B / rename-A can publish B's half-written file
  // as the live shim.
  //
  // HONEST LABEL: for the race, this is a SMOKE CHECK, not a proof. Measured —
  // reverting the unique tmp name to a fixed `<path>.tmp` leaves this green on
  // three consecutive runs, because every caller writes the SAME text, so a
  // partial publish would be a prefix of the right answer and the window is not
  // reproducible from one process. The unique name stays because it is correct
  // by construction (same reasoning as utils/atomic-write.ts), NOT because this
  // test would catch its absence.
  //
  // The leftover assertion below is deterministic, but be precise about WHAT it
  // shows: all 12 calls here succeed, so none of them reaches
  // writeExecutable's catch. It shows rename()'s ordinary success property —
  // nothing is left at the source — not that the catch's `rm` ever ran.
  //
  // NO test in this file exercises that scratch-file cleanup, and that is
  // stated rather than papered over. Reaching it needs a failure BETWEEN
  // writeFile succeeding and rename succeeding, which has no portable
  // trigger: an unwritable dir fails before the tmp file exists, and a
  // directory at the target throws out of readFileSync earlier still. The
  // line stays as defence; its cost if absent is one orphaned scratch file.
  test("concurrent refreshes leave exactly the wanted text and no scratch files", async () => {
    staleStatuslineShim();
    const path = statuslineShimPath(home);
    await Promise.all(Array.from({ length: 12 }, () => refreshStaleShims(home)));
    expect(readFileSync(path, "utf8")).toBe(renderStatuslineShim());
    const leftovers = readdirSync(join(home, ".siltpoke", "bin")).filter((f) => f.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("an unwritable bin/ does not throw, and leaves the old shim in place", async () => {
    const bin = join(home, ".siltpoke", "bin");
    const path = staleStatuslineShim();
    const stale = readFileSync(path, "utf8");
    chmodSync(bin, 0o555);
    try {
      // Not throwing is half of it — nothing may break a SessionStart.
      const rewritten = await refreshStaleShims(home);
      expect(rewritten).toEqual([]);
      // The other half, and the half that was missing: prove the write really
      // FAILED. `refreshStaleShims` swallows every error by design, so
      // "resolves" alone passes whether the chmod blocked anything or not —
      // it would pass for a function that did nothing at all, or one running
      // as root where the mode bits are ignored. Reading the file back is the
      // only assertion with discriminating power. Raised in review.
      expect(readFileSync(path, "utf8")).toBe(stale);
    } finally {
      chmodSync(bin, 0o755);
    }
  });
});

// The delivery half. `refreshStaleShims` being correct is worth nothing if
// nothing calls it — that is the exact shape of the bug it fixes (a fix that
// shipped while the machine kept the old file).
describe("SessionStart refreshes the shims", () => {
  test("a stale shim is current again after one SessionStart", async () => {
    const path = staleStatuslineShim();
    const cwd = mkdtempSync(join(tmpdir(), "siltpoke-ss-cwd-"));
    try {
      await handleSessionStart({
        cwd,
        session_id: "refresh-delivery",
        env: { ...process.env, HOME: home, SILTPOKE_HOME: join(home, ".siltpoke") },
      });
      expect(readFileSync(path, "utf8")).toBe(renderStatuslineShim());
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a SessionStart does not conjure a shim for someone who never opted in", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "siltpoke-ss-cwd-"));
    try {
      await handleSessionStart({
        cwd,
        session_id: "refresh-noop",
        env: { ...process.env, HOME: home, SILTPOKE_HOME: join(home, ".siltpoke") },
      });
      expect(existsSync(statuslineShimPath(home))).toBe(false);
      expect(existsSync(daemonShimPath(home))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
