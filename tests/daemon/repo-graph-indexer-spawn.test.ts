/**
 * The REAL spawn — `runIndexerProcess` against fixture children.
 *
 * Why this file exists: an independent review confirmed that nothing in CI
 * executed the actual `Bun.spawn` in this module. Every route test injects a
 * stub `indexRunner`; no e2e spec triggers an index. So `stderr: "pipe"` could
 * revert to `"ignore"` — the exact setting whose absence hid a total failure of
 * dashboard indexing for the life of the feature — and the suite would stay
 * green. These tests run real child processes so that revert goes red.
 *
 * Deliberately NOT covered here: the resolved production script path (that is
 * repo-graph-indexer-target.test.ts's job). This file is only about what the
 * spawn does with a child once it has one.
 *
 * Run: bun test tests/daemon/repo-graph-indexer-spawn.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexerFailureLine, runIndexerProcess } from "../../src/daemon/routes/repo-graph";

let dir: string;

beforeEach(() => {
  // /tmp, never a repo path under ~/Documents — iCloud stalls file reads there
  // and it presents as a subprocess timeout.
  dir = mkdtempSync(join(tmpdir(), "siltpoke-spawn-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a fixture child and return its path. */
function fixture(name: string, source: string): string {
  const p = join(dir, name);
  writeFileSync(p, source);
  return p;
}

const run = (script: string, over: Partial<Parameters<typeof runIndexerProcess>[0]> = {}) =>
  // projHash is part of the runner contract but unused by the spawn itself —
  // the child derives its own from cwd.
  runIndexerProcess({ script, realPath: dir, projHash: "spawnfixture0", timeoutMs: 15_000, ...over });

describe("stderr is captured, not discarded", () => {
  test("a child that fails on stderr → non-zero exit AND the message is kept", async () => {
    const script = fixture("boom.ts", 'console.error("error: fixture exploded");\nprocess.exit(3);\n');
    const res = await run(script);

    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
    expect(res.aborted).toBe(false);
    // THE assertion this file exists for. With `stderr: "ignore"` this is
    // undefined and everything else about the run still looks identical.
    expect(res.stderrTail).toContain("error: fixture exploded");
    expect(indexerFailureLine(res.stderrTail)).toBe("error: fixture exploded");
  });

  test("a MISSING script reproduces the original production failure end to end", async () => {
    // This is precisely what the shipped daemon did on every index: spawn a path
    // that does not exist. Before this PR the reason was discarded here.
    const res = await run(join(dir, "does-not-exist.ts"));
    expect(res.exitCode).not.toBe(0);
    expect(res.stderrTail ?? "").toContain("Module not found");
    expect(indexerFailureLine(res.stderrTail)).toContain("Module not found");
  });

  test("a clean child exits 0 with no stderr and no invented tail", async () => {
    const script = fixture("ok.ts", 'console.log("done");\n');
    const res = await run(script);
    expect(res.exitCode).toBe(0);
    expect(res.stderrTail).toBeUndefined();
  });
});

describe("stdout progress still flows while stderr is being drained", () => {
  test("progress NDJSON is delivered even when the child also writes stderr", async () => {
    // The concurrent-drain design exists so neither stream starves the other.
    // A child that writes BOTH is the case a sequential implementation breaks on.
    const script = fixture(
      "both.ts",
      [
        'console.error("warming up");',
        'console.log(JSON.stringify({ type: "progress", done: 1, total: 2 }));',
        'console.log(JSON.stringify({ type: "progress", done: 2, total: 2 }));',
        'console.log("human-readable trailer that is not JSON");',
        'console.error("error: and then it died");',
        "process.exit(1);",
      ].join("\n"),
    );

    const seen: Array<[number, number]> = [];
    const res = await run(script, { onProgress: (done, total) => seen.push([done, total]) });

    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderrTail ?? "").toContain("and then it died");
  });

  test("a big stderr writer is capped, and the tail (not the head) is what survives", async () => {
    // Bounded so a screaming child can't grow the daemon's heap — and the cap
    // must keep the END, since that is where the actual failure is printed.
    const script = fixture(
      "loud.ts",
      [
        "for (let i = 0; i < 4000; i++) console.error(`noise line ${i}`);",
        'console.error("error: the last word");',
        "process.exit(1);",
      ].join("\n"),
    );
    const res = await run(script);

    expect(res.stderrTail).toBeDefined();
    expect(res.stderrTail!.length).toBeLessThanOrEqual(4000);
    expect(res.stderrTail!).toContain("error: the last word");
    expect(res.stderrTail!).not.toContain("noise line 0\n");
  });
});

describe("cancel and timeout still terminate — the drain must not hold them open", () => {
  test("abort → aborted:true, and the call RETURNS rather than hanging on the drain", async () => {
    // The risk the review raised: awaiting the stderr drain after killing the
    // child could block forever. A child that would otherwise run for a minute
    // proves the call comes back promptly.
    const script = fixture(
      "slow.ts",
      ['console.error("started");', "await new Promise((r) => setTimeout(r, 60_000));"].join("\n"),
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);

    const started = Date.now();
    const res = await run(script, { signal: ac.signal });
    const elapsed = Date.now() - started;

    expect(res.aborted).toBe(true);
    expect(elapsed).toBeLessThan(10_000); // nowhere near the child's 60s
  });

  test("timeout → timedOut:true, and it returns at roughly the deadline", async () => {
    const script = fixture("slow2.ts", "await new Promise((r) => setTimeout(r, 60_000));\n");
    const started = Date.now();
    const res = await run(script, { timeoutMs: 300 });
    const elapsed = Date.now() - started;

    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(10_000);
  });
});
