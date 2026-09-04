import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueuePending, pendingQueuePath } from "../../src/memory/pending-queue";
import { maybeLaunchDistilWorker } from "../../src/memory/distil-launcher";

function entry() {
  return {
    critique_id: "c-1", session_id: "s", created_sha: null,
    created_at: new Date().toISOString(), hooks_elapsed: 0,
    status: "pending" as const, severity: "high" as const, finding_text: "f",
    anchors: [{ file: "a.ts", line: 1, tool: "tsc" as const, fingerprint: "fp" }],
    distil_attempts: 0,
  };
}
function tmp() { return mkdtempSync(join(tmpdir(), "dl-")); }

describe("maybeLaunchDistilWorker", () => {
  it("pending empty -> does not spawn", async () => {
    const home = tmp(), state = tmp();
    let spawned = 0;
    const r = await maybeLaunchDistilWorker(home, state, "/cwd", {
      spawnFn: () => { spawned++; }, isLockHeldFn: () => false,
    });
    expect(spawned).toBe(0);
    expect(r).toEqual({ launched: false, reason: "empty" });
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("pending non-empty + lock free -> spawns once with detached worker argv", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const calls: string[][] = [];
    const r = await maybeLaunchDistilWorker(home, state, "/cwd", {
      spawnFn: (argv) => calls.push(argv), isLockHeldFn: () => false,
      workerPath: "/x/siltpoke-distil.js",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["bun", "/x/siltpoke-distil.js", "--home", home, "--state", state, "--cwd", "/cwd"]);
    expect(r.launched).toBe(true);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("pending non-empty + lock held -> does not spawn", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    let spawned = 0;
    const r = await maybeLaunchDistilWorker(home, state, "/cwd", {
      spawnFn: () => { spawned++; }, isLockHeldFn: () => true,
    });
    expect(spawned).toBe(0);
    expect(r).toEqual({ launched: false, reason: "locked" });
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("spawn throws -> swallowed, no throw", async () => {
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const r = await maybeLaunchDistilWorker(home, state, "/cwd", {
      spawnFn: () => { throw new Error("bun not on PATH"); }, isLockHeldFn: () => false,
    });
    expect(r.launched).toBe(false);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });

  it("no workerPath override -> default resolves to the SOURCE worker entry when run from source (fork-host regression)", async () => {
    // This test's module graph runs from src/ (not bundled dist/), so
    // import.meta.dir inside distil-launcher.ts is .../src/memory here.
    // The default workerPath must resolve to the source worker entry
    // (src/hooks/on-distil-worker.ts), NOT the bundled sibling name
    // (siltpoke-distil.js) which only exists next to the launcher when
    // bundled into dist/siltpoke-stop.js.
    const home = tmp(), state = tmp();
    await enqueuePending(pendingQueuePath(state), entry());
    const calls: string[][] = [];
    const r = await maybeLaunchDistilWorker(home, state, "/cwd", {
      spawnFn: (argv) => calls.push(argv), isLockHeldFn: () => false,
    });
    expect(calls).toHaveLength(1);
    const workerPath = calls[0]![1]!;
    expect(workerPath.endsWith("hooks/on-distil-worker.ts")).toBe(true);
    expect(workerPath.endsWith("memory/siltpoke-distil.js")).toBe(false);
    expect(r.launched).toBe(true);
    rmSync(home, { recursive: true }); rmSync(state, { recursive: true });
  });
});
