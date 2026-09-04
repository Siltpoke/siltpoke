// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFileCapped, fingerprintsFor, nodeCaptureDeps,
  gitRevParseHead, gitWorktreeDirty, nodeFinalizeDeps,
} from "../../src/memory/case1-capture-node-deps";
import { contentFingerprint, fileContentFingerprints } from "../../src/memory/line-fingerprint";
import { captureCase1Pre } from "../../src/memory/case1-capture";
import type { PreInput } from "../../src/memory/case1-capture";

const ON_CONFIG = { capture_case1: true };
const ON_ENV = { SILTPOKE_CAPTURE_CASE1: "1" };

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "siltpoke-readcap-"));
  const p = join(dir, "f.txt");
  writeFileSync(p, content);
  return p;
}

describe("readFileCapped", () => {
  test("reads full small file, truncated=false", async () => {
    const p = tmpFile("hello world");
    const result = await readFileCapped(p, 1000);
    expect(result).toEqual({ content: "hello world", truncated: false });
  });

  test("caps content at byteCap and flags truncated=true", async () => {
    const p = tmpFile("0123456789");
    const result = await readFileCapped(p, 4);
    expect(result?.content).toBe("0123");
    expect(result?.truncated).toBe(true);
  });

  test("exact-boundary file (content length === byteCap) → truncated=false", async () => {
    const p = tmpFile("abcd");
    const result = await readFileCapped(p, 4);
    expect(result?.content).toBe("abcd");
    expect(result?.truncated).toBe(false);
  });

  test("missing file → null, never throws", async () => {
    const result = await readFileCapped("/nonexistent/path/xyz.txt", 100);
    expect(result).toBeNull();
  });

  test("directory (not a file) → null, never throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-readcap-dir-"));
    const result = await readFileCapped(dir, 100);
    expect(result).toBeNull();
  });
});

// `fingerprintsFor` used to return the WHOLE-FILE non-blank-line hash set,
// because Phase 1's anchors had been narrowed to `{ file }` and no specific
// line was available at this layer. That made `anchor_fingerprints` an
// undifferentiated line-hash set — useless for spec §5's stated purpose
// ("verify THIS flagged line's presence/absence, even on a truncated file").
// Now the anchors arrive with their critique-time `line` + `fingerprint`, so
// this returns the FLAGGED lines' hashes only.
describe("fingerprintsFor", () => {
  const content = "const x = 1;\nconst y = 2;\n\nconst z = 3;\n";

  test("returns ONLY this file's flagged-line hashes, not the whole-file set", () => {
    const flagged = contentFingerprint("const y = 2;");
    const fps = fingerprintsFor("a.ts", content, [{ file: "a.ts", line: 2, fingerprint: flagged }]);
    expect(fps).toEqual([flagged]);
    // regression guard against the old whole-file behavior
    expect(fps.length).toBeLessThan(fileContentFingerprints(content).size);
  });

  test("ignores anchors belonging to a DIFFERENT file", () => {
    expect(fingerprintsFor("a.ts", content, [{ file: "b.ts", line: 1, fingerprint: "fp-other" }])).toEqual([]);
  });

  test("no pre-computed fingerprint but a resolvable line → computed from the captured content", () => {
    expect(fingerprintsFor("a.ts", content, [{ file: "a.ts", line: 4 }]))
      .toEqual([contentFingerprint("const z = 3;")]);
  });

  test("neither a fingerprint nor a resolvable line → nothing (never a whole-file fallback)", () => {
    expect(fingerprintsFor("a.ts", content, [{ file: "a.ts" }])).toEqual([]);
    expect(fingerprintsFor("a.ts", content, [{ file: "a.ts", line: 3 }])).toEqual([]); // blank line
    expect(fingerprintsFor("a.ts", content, [{ file: "a.ts", line: 999 }])).toEqual([]); // out of range
    expect(fingerprintsFor("a.ts", content, [])).toEqual([]);
  });

  test("dedupes anchors that resolve to the same line content", () => {
    const fp = contentFingerprint("const x = 1;");
    expect(fingerprintsFor("a.ts", content, [
      { file: "a.ts", line: 1, fingerprint: fp },
      { file: "a.ts", line: 1 },
    ])).toEqual([fp]);
  });

  test("survives truncation: a critique-time fingerprint for a line PAST the cap is kept", () => {
    // The capped content holds only line 1, but the flagged line was line 4 —
    // its fingerprint was computed at critique-creation from the FULL file and
    // must survive (spec §5: "kept even when `content` is truncated").
    const capped = "const x = 1;\n";
    const flagged = contentFingerprint("const z = 3;");
    expect(fingerprintsFor("a.ts", capped, [{ file: "a.ts", line: 4, fingerprint: flagged }]))
      .toEqual([flagged]);
  });
});

test("nodeCaptureDeps wires the real implementations", () => {
  expect(nodeCaptureDeps.readFileCapped).toBe(readFileCapped);
  expect(nodeCaptureDeps.fingerprintsFor).toBe(fingerprintsFor);
  expect(typeof nodeCaptureDeps.writeAtomic).toBe("function");
  expect(nodeCaptureDeps.now() instanceof Date).toBe(true);
});

test("nodeCaptureDeps supplies a real deadlineMs (the wall-clock gate is NOT inert)", () => {
  expect(typeof nodeCaptureDeps.deadlineMs).toBe("number");
  expect(nodeCaptureDeps.deadlineMs).toBeGreaterThan(0);
});

describe("captureCase1Pre + nodeCaptureDeps — deadline actually gates new reads", () => {
  test("only the first file's read is STARTED once elapsed >= deadlineMs", async () => {
    let calls = 0;
    let t = 0;
    const writes: Record<string, string> = {};
    // Same shape as Task 5's own deadline test (case1-capture.test.ts), but
    // spread over the REAL nodeCaptureDeps so this proves the production
    // factory's deadlineMs wiring — not just captureCase1Pre's internal gate
    // logic (already covered there) in isolation.
    const deps = {
      ...nodeCaptureDeps,
      now: () => new Date(t),
      // nodeCaptureDeps.deadlineMs (500) is inherited via the spread above —
      // each fake read advances the clock well past it.
      readFileCapped: async (_absPath: string, _byteCap: number) => {
        calls++;
        t += nodeCaptureDeps.deadlineMs! + 1; // jump past the deadline after every read
        return { content: "x", truncated: false };
      },
      writeAtomic: async (p: string, data: string) => {
        writes[p] = data;
      },
    };
    const input: PreInput = {
      critique_id: "c-1",
      session_id: "s-1",
      cwd: "/repo",
      stateBase: "/repo/.siltpoke",
      finding_text: "f",
      severity: "medium",
      anchors: [],
      evidenceFiles: ["a.ts", "b.ts", "c.ts"],
    };
    const id = await captureCase1Pre(input, ON_CONFIG, ON_ENV, deps);
    expect(calls).toBe(1); // deadline trips before a 2nd read is ever started
    expect(id).toMatch(/^case1-/);
    const rec = JSON.parse(Object.values(writes)[0]!);
    expect(rec.before.files.length).toBe(1);
  });
});

// --- Task 9: nodeFinalizeDeps (Phase 2 real git-timeout deps) ---
// Injected `runGit` fakes throughout — zero real git/network per the global
// constraint. The killable-timeout wiring itself (`execFile` with `timeout` +
// `killSignal: "SIGKILL"`) is exercised indirectly: these tests prove the
// FAILURE CONTRACT (a throwing/empty git call always yields null/false, never
// throws out) which is the behavior distil-worker's fail-soft finalize relies on.
describe("gitRevParseHead", () => {
  test("trims and returns the sha on success", async () => {
    const sha = await gitRevParseHead("/repo", { runGit: async () => "abc123\n" });
    expect(sha).toBe("abc123");
  });

  test("throwing runGit → null, never throws", async () => {
    const sha = await gitRevParseHead("/repo", {
      runGit: async () => { throw new Error("git: not a repository"); },
    });
    expect(sha).toBeNull();
  });

  test("empty output → null", async () => {
    const sha = await gitRevParseHead("/repo", { runGit: async () => "\n" });
    expect(sha).toBeNull();
  });
});

describe("gitWorktreeDirty", () => {
  test("non-empty porcelain output → true", async () => {
    const dirty = await gitWorktreeDirty("/repo", { runGit: async () => " M src/foo.ts\n" });
    expect(dirty).toBe(true);
  });

  test("empty porcelain output → false (clean worktree)", async () => {
    const dirty = await gitWorktreeDirty("/repo", { runGit: async () => "" });
    expect(dirty).toBe(false);
  });

  test("throwing runGit → false, never throws", async () => {
    const dirty = await gitWorktreeDirty("/repo", {
      runGit: async () => { throw new Error("git: timeout"); },
    });
    expect(dirty).toBe(false);
  });
});

describe("nodeFinalizeDeps", () => {
  test("wires readPre/headSha/worktreeDirty/deleteFile + inherits nodeCaptureDeps plumbing", () => {
    expect(typeof nodeFinalizeDeps.readPre).toBe("function");
    expect(typeof nodeFinalizeDeps.headSha).toBe("function");
    expect(typeof nodeFinalizeDeps.worktreeDirty).toBe("function");
    expect(typeof nodeFinalizeDeps.deleteFile).toBe("function");
    expect(nodeFinalizeDeps.readFileCapped).toBe(nodeCaptureDeps.readFileCapped);
    expect(nodeFinalizeDeps.writeAtomic).toBe(nodeCaptureDeps.writeAtomic);
  });

  test("readPre reads + parses a real pre.json, returns null on missing/corrupt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-readpre-"));
    const good = join(dir, "good.pre.json");
    const corrupt = join(dir, "corrupt.pre.json");
    writeFileSync(good, JSON.stringify({ capture_id: "case1-a", cwd: "/repo" }));
    writeFileSync(corrupt, "{not json");

    await expect(nodeFinalizeDeps.readPre(good)).resolves.toEqual({ capture_id: "case1-a", cwd: "/repo" });
    await expect(nodeFinalizeDeps.readPre(corrupt)).resolves.toBeNull();
    await expect(nodeFinalizeDeps.readPre(join(dir, "missing.pre.json"))).resolves.toBeNull();
  });

  test("deleteFile removes a real file and swallows a missing-file error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-delfile-"));
    const p = join(dir, "x.json");
    writeFileSync(p, "{}");
    await nodeFinalizeDeps.deleteFile(p);
    await expect(nodeFinalizeDeps.readPre(p)).resolves.toBeNull(); // gone
    await expect(nodeFinalizeDeps.deleteFile(p)).resolves.toBeUndefined(); // 2nd delete: no throw
  });
});
