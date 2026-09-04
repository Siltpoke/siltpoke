import { describe, expect, test } from "bun:test";
import { isCase1CaptureEnabled } from "../../src/memory/case1-capture";

import { newCaptureId, isValidCaptureId } from "../../src/memory/case1-capture";

describe("isCase1CaptureEnabled", () => {
  test("requires BOTH the config flag AND the env var", () => {
    expect(isCase1CaptureEnabled({ capture_case1: true }, { SILTPOKE_CAPTURE_CASE1: "1" })).toBe(true);
    expect(isCase1CaptureEnabled({ capture_case1: true }, {})).toBe(false);
    expect(isCase1CaptureEnabled({ capture_case1: false }, { SILTPOKE_CAPTURE_CASE1: "1" })).toBe(false);
    expect(isCase1CaptureEnabled({}, {})).toBe(false);
  });
  test("never throws on malformed input", () => {
    expect(() => isCase1CaptureEnabled({} as any, undefined as any)).not.toThrow();
  });
});

test("capture_id is case1-<hex>, round-trips through validation, unique", () => {
  const a = newCaptureId(), b = newCaptureId();
  expect(a).toMatch(/^case1-[a-f0-9]{8,}$/);
  expect(isValidCaptureId(a)).toBe(true);
  expect(a).not.toBe(b);
});
test("isValidCaptureId rejects traversal / junk", () => {
  for (const bad of ["../x", "case1-../x", "case1-a/b", "abs", "", "case1-a b"]) {
    expect(isValidCaptureId(bad)).toBe(false);
  }
});

import { sanitizeTargetPath, resolveCandidatePath } from "../../src/memory/case1-capture";

test("sanitizeTargetPath rejects absolute / traversal / outside cwd", () => {
  const cwd = "/repo";
  expect(sanitizeTargetPath(cwd, "src/a.ts")).toBe("src/a.ts");
  expect(sanitizeTargetPath(cwd, "/etc/passwd")).toBeNull();
  expect(sanitizeTargetPath(cwd, "../secret")).toBeNull();
  expect(sanitizeTargetPath(cwd, "src/../../x")).toBeNull();
});

test("resolveCandidatePath honors the dir boundary + id validity", () => {
  const p = resolveCandidatePath("/repo/.siltpoke", "case1-ab", "pre.json");
  expect(p).toBe("/repo/.siltpoke/case1-candidates/case1-ab.pre.json");
  expect(resolveCandidatePath("/repo/.siltpoke", "../evil", "pre.json")).toBeNull();
});

import { buildCandidateRecords, snapshotDiff, projectHash } from "../../src/memory/case1-capture";
const inputs = () => ({ capture_id:"case1-ab", critique_id:"c-1", session_id:"s", cwd:"/repo",
  created_at:"t0", finalized_at:"t1",
  before:[{path:"a.ts",content:"bad",truncated:false}],
  after:{head_sha:"deadbeef",worktree_dirty:true,files:[{path:"a.ts",content:"good",truncated:false}]},
  anchorFps:[{path:"a.ts",anchor_fingerprints:["fp1"]}],
  critique:{finding_text:"f",severity:"medium",anchors:[]},
  verified_anchor:{file:"a.ts",verdict_tier:2 as const},
  rule:{id:"lr-1",text:"RULE",category:"cat"} });
test("public has no rule, no cwd, no session_id; private has them", () => {
  const { public: pub, private: pri } = buildCandidateRecords(inputs());
  const pubStr = JSON.stringify(pub);
  expect(pubStr).not.toContain("RULE"); expect(pubStr).not.toContain("/repo"); expect(pubStr).not.toContain('"s"');
  expect("rule" in pub).toBe(false);
  expect("cwd" in pub).toBe(false);
  expect("session_id" in pub).toBe(false);
  expect("cwd" in (pub as any).critique).toBe(false);
  expect("session_id" in (pub as any).critique).toBe(false);
  expect((pub as any).project_hash).toBe(projectHash("/repo"));
  expect((pri as any).rule.text).toBe("RULE"); expect((pri as any).cwd).toBe("/repo");
});
test("single-file, untruncated → admissible; anchor fps merged", () => {
  const { public: pub } = buildCandidateRecords(inputs());
  expect((pub as any).admissible_for_reconstruction).toBe(true);
  expect((pub as any).multi_file_unverified).toBe(false);
  expect((pub as any).before.files[0].anchor_fingerprints).toEqual(["fp1"]);
});
test("multi-file OR truncated → not admissible", () => {
  const i = inputs(); i.before.push({path:"b.ts",content:"x",truncated:false});
  expect((buildCandidateRecords(i).public as any).admissible_for_reconstruction).toBe(false);
  const t = inputs(); t.before[0].truncated = true;
  expect((buildCandidateRecords(t).public as any).admissible_for_reconstruction).toBe(false);
});
test("verified_anchor carries the flagged line + its fingerprint, not just the file", () => {
  // Before this fix `verified_anchor` was `{ file, verdict_tier }` only, so a
  // downstream step could not tell WHICH line inside the file the oracle
  // confirmed fixed. The flagged line + its content hash make the record
  // self-contained (spec §5 "the ONE anchor the oracle confirmed fixed").
  const i = {
    ...inputs(),
    verified_anchor: { file: "a.ts", line: 42, fingerprint: "fp-flagged", verdict_tier: 2 as const },
  };
  const { public: pub } = buildCandidateRecords(i);
  expect((pub as any).verified_anchor).toEqual({
    file: "a.ts", line: 42, fingerprint: "fp-flagged", verdict_tier: 2,
  });
});
test("verified_anchor without line/fingerprint stays minimal (no undefined keys)", () => {
  const { public: pub } = buildCandidateRecords(inputs());
  expect((pub as any).verified_anchor).toStrictEqual({ file: "a.ts", verdict_tier: 2 });
});
test("snapshotDiff classifies per file", () => {
  expect(snapshotDiff([{path:"a",content:"1",truncated:false}],[{path:"a",content:"2",truncated:false}])[0].change).toBe("modified");
});
test("snapshotDiff itself still reports unchanged entries (unfiltered)", () => {
  const diff = snapshotDiff([{path:"a",content:"same",truncated:false}],[{path:"a",content:"same",truncated:false}]);
  expect(diff).toEqual([{path:"a",change:"unchanged"}]);
});
test("buildCandidateRecords drops 'unchanged' from fix.changed_files (spec §5: changed set only)", () => {
  const i = inputs();
  i.before = [{path:"a.ts",content:"same",truncated:false},{path:"b.ts",content:"bad",truncated:false}];
  i.after = { head_sha:"deadbeef", worktree_dirty:true, files:[
    {path:"a.ts",content:"same",truncated:false}, // unchanged
    {path:"b.ts",content:"good",truncated:false}, // modified
  ]};
  const { public: pub } = buildCandidateRecords(i);
  const changed = (pub as any).fix.changed_files as Array<{path:string; change:string}>;
  expect(changed.map((c) => c.path)).toEqual(["b.ts"]);
  expect(changed.every((c) => c.change !== "unchanged")).toBe(true);
});

// --- Task 5: captureCase1Pre (Phase 1 defect snapshot, injected deps) ---

import { captureCase1Pre } from "../../src/memory/case1-capture";
import type { CaptureDeps, PreInput } from "../../src/memory/case1-capture";

const ON_CONFIG = { capture_case1: true };
const ON_ENV = { SILTPOKE_CAPTURE_CASE1: "1" };

const deps = (): CaptureDeps => ({
  readFileCapped: async (absPath: string, _byteCap: number) => ({ content: `content:${absPath}`, truncated: false }),
  fingerprintsFor: (_relPath: string, _content: string, _anchors: unknown[]) => ["fp1"],
  writeAtomic: async (_path: string, _data: string) => {},
  now: () => new Date(0),
});

const baseInput = (): PreInput => ({
  critique_id: "c-1",
  session_id: "s-1",
  cwd: "/repo",
  stateBase: "/repo/.siltpoke",
  finding_text: "f",
  severity: "medium",
  anchors: [],
  evidenceFiles: [],
});

describe("captureCase1Pre", () => {
  test("disabled → undefined, no write", async () => {
    let wrote = false;
    const id = await captureCase1Pre(baseInput(), { capture_case1: false }, {}, { ...deps(), writeAtomic: async () => { wrote = true; } });
    expect(id).toBeUndefined();
    expect(wrote).toBe(false);
  });

  test("enabled → writes pre.json, drops unsafe paths, never throws", async () => {
    const writes: Record<string, string> = {};
    const d = { ...deps(), writeAtomic: async (p: string, data: string) => { writes[p] = data; } };
    const input = { ...baseInput(), anchors: [{ file: "a.ts" }], evidenceFiles: ["/etc/passwd", "../x", "b.ts"] };
    const id = await captureCase1Pre(input, ON_CONFIG, ON_ENV, d);
    expect(id).toMatch(/^case1-/);
    const rec = JSON.parse(Object.values(writes)[0] as string);
    expect(rec.before.files.map((f: any) => f.path).sort()).toEqual(["a.ts", "b.ts"]); // unsafe dropped
    expect(rec.phase).toBe("pre");
    expect(rec.capture_id).toBe(id);
  });

  test("sanitized anchors keep line/tool/fingerprint — only `file` is sanitized", async () => {
    // Before this fix `PreInput.anchors` was `{ file }` only, so the flagged
    // line + its critique-time fingerprint were dropped at the PreInput
    // boundary and the pre-record's `critique.anchors` lost 3 of spec §5's 4
    // fields ("anchors already carry file/line/tool/fingerprint").
    const writes: Record<string, string> = {};
    const seen: unknown[][] = [];
    const d: CaptureDeps = {
      ...deps(),
      fingerprintsFor: (_relPath: string, _content: string, anchors: unknown[]) => {
        seen.push(anchors);
        return ["fp1"];
      },
      writeAtomic: async (p: string, data: string) => { writes[p] = data; },
    };
    const input: PreInput = {
      ...baseInput(),
      anchors: [
        { file: "a.ts", line: 42, tool: "tsc", fingerprint: "fp-flagged" },
        // unsafe path → the WHOLE anchor is dropped, fingerprint and all
        { file: "/etc/passwd", line: 1, tool: "eslint", fingerprint: "fp-evil" },
      ],
      evidenceFiles: [],
    };
    const id = await captureCase1Pre(input, ON_CONFIG, ON_ENV, d);
    expect(id).toMatch(/^case1-/);
    const rec = JSON.parse(Object.values(writes)[0] as string);
    expect(rec.critique.anchors).toEqual([
      { file: "a.ts", line: 42, tool: "tsc", fingerprint: "fp-flagged" },
    ]);
    // the SAME enriched (sanitized) anchors are what `fingerprintsFor` gets —
    // that's how the per-anchor fingerprints reach `anchor_fingerprints`.
    expect(seen[0]).toEqual([{ file: "a.ts", line: 42, tool: "tsc", fingerprint: "fp-flagged" }]);
  });

  test("a bare `{ file }` anchor emits no undefined line/tool/fingerprint keys", async () => {
    const writes: Record<string, string> = {};
    const d = { ...deps(), writeAtomic: async (p: string, data: string) => { writes[p] = data; } };
    const input = { ...baseInput(), anchors: [{ file: "a.ts" }], evidenceFiles: [] };
    await captureCase1Pre(input, ON_CONFIG, ON_ENV, d);
    const rec = JSON.parse(Object.values(writes)[0] as string);
    expect(rec.critique.anchors).toStrictEqual([{ file: "a.ts" }]);
  });

  test("no safe files → undefined, no write", async () => {
    let wrote = false;
    const input = { ...baseInput(), anchors: [], evidenceFiles: ["/etc/passwd", "../x"] };
    const id = await captureCase1Pre(input, ON_CONFIG, ON_ENV, { ...deps(), writeAtomic: async () => { wrote = true; } });
    expect(id).toBeUndefined();
    expect(wrote).toBe(false);
  });

  test("a throwing readFileCapped never propagates", async () => {
    const d = { ...deps(), readFileCapped: async () => { throw new Error("boom"); } };
    await expect(
      captureCase1Pre({ ...baseInput(), anchors: [{ file: "a.ts" }], evidenceFiles: [] }, ON_CONFIG, ON_ENV, d),
    ).resolves.toBeUndefined();
  });

  test("a throwing writeAtomic never propagates", async () => {
    const d = { ...deps(), writeAtomic: async () => { throw new Error("disk full"); } };
    await expect(
      captureCase1Pre({ ...baseInput(), anchors: [{ file: "a.ts" }], evidenceFiles: [] }, ON_CONFIG, ON_ENV, d),
    ).resolves.toBeUndefined();
  });

  test("fileCap limits number of files captured", async () => {
    const writes: Record<string, string> = {};
    const d = { ...deps(), fileCap: 2, writeAtomic: async (p: string, data: string) => { writes[p] = data; } };
    const input = { ...baseInput(), anchors: [], evidenceFiles: ["a.ts", "b.ts", "c.ts", "d.ts"] };
    const id = await captureCase1Pre(input, ON_CONFIG, ON_ENV, d);
    expect(id).toMatch(/^case1-/);
    const rec = JSON.parse(Object.values(writes)[0] as string);
    expect(rec.before.files.length).toBe(2);
  });

  test("deadlineMs stops starting new reads past the deadline", async () => {
    let calls = 0;
    let t = 0;
    const writes: Record<string, string> = {};
    const d: CaptureDeps = {
      ...deps(),
      now: () => new Date(t),
      deadlineMs: 5,
      readFileCapped: async (_absPath: string) => { calls++; t += 10; return { content: "x", truncated: false }; },
      writeAtomic: async (p: string, data: string) => { writes[p] = data; },
    };
    const input = { ...baseInput(), anchors: [], evidenceFiles: ["a.ts", "b.ts", "c.ts"] };
    const id = await captureCase1Pre(input, ON_CONFIG, ON_ENV, d);
    expect(calls).toBe(1); // only the first file's read is started before the deadline trips
    expect(id).toMatch(/^case1-/);
    const rec = JSON.parse(Object.values(writes)[0] as string);
    expect(rec.before.files.length).toBe(1);
  });
});

// --- Task 6: finalizeCase1 (Phase 2 fix snapshot + rule linkage, injected deps) ---

import { finalizeCase1 } from "../../src/memory/case1-capture";
import type { FinalizeDeps } from "../../src/memory/case1-capture";

const preFor = (id: string) => `/repo/.siltpoke/case1-candidates/${id}.pre.json`;

const PRE_REC = {
  schema_version: 1,
  capture_id: "case1-ab",
  critique_id: "c-1",
  session_id: "s-1",
  cwd: "/repo",
  phase: "pre" as const,
  created_at: "t0",
  before: { files: [{ path: "a.ts", content: "bad", truncated: false }] },
  anchorFps: [{ path: "a.ts", anchor_fingerprints: ["fp1"] }],
  critique: { finding_text: "f", severity: "medium", anchors: [] },
};

const ARGS = {
  capture_id: "case1-ab",
  cwd: "/repo",
  stateBase: "/repo/.siltpoke",
  rule: { id: "lr-1", text: "RULE", category: "c" },
  verified_anchor: { file: "a.ts", verdict_tier: 2 as const },
};

const finalizeDeps = (store: Record<string, string>, deleted: string[]): FinalizeDeps => ({
  readFileCapped: async (absPath: string, _byteCap: number) => ({ content: `after:${absPath}`, truncated: false }),
  fingerprintsFor: (_relPath: string, _content: string, _anchors: unknown[]) => ["fp1"],
  writeAtomic: async (path: string, data: string) => { store[path] = data; },
  now: () => new Date(1000),
  readPre: async (path: string) => (store[path] ? JSON.parse(store[path]) : null),
  headSha: async (_cwd: string) => "deadbeef",
  worktreeDirty: async (_cwd: string) => true,
  deleteFile: async (path: string) => { deleted.push(path); delete store[path]; },
});

describe("finalizeCase1", () => {
  test("finalize writes public+private, deletes pre, public has no rule", async () => {
    const store: Record<string, string> = { [preFor("case1-ab")]: JSON.stringify(PRE_REC) };
    const deleted: string[] = [];
    const d = finalizeDeps(store, deleted);
    const r = await finalizeCase1(ARGS, ON_CONFIG, ON_ENV, d);
    expect(r).toBe("finalized");
    expect(store["/repo/.siltpoke/case1-candidates/case1-ab.public.json"]).not.toContain("RULE");
    expect(store["/repo/.siltpoke/case1-candidates/case1-ab.provenance-private.json"]).toContain("RULE");
    expect(deleted).toContain("/repo/.siltpoke/case1-candidates/case1-ab.pre.json");
  });

  test("missing pre → skipped, no throw", async () => {
    await expect(finalizeCase1({ ...ARGS }, ON_CONFIG, ON_ENV, finalizeDeps({}, []))).resolves.toBe("skipped");
  });

  test("disabled → skipped, no delete", async () => {
    const store: Record<string, string> = { [preFor("case1-ab")]: JSON.stringify(PRE_REC) };
    const deleted: string[] = [];
    const r = await finalizeCase1(ARGS, { capture_case1: false }, ON_ENV, finalizeDeps(store, deleted));
    expect(r).toBe("skipped");
    expect(deleted).toEqual([]);
  });

  test("a throwing dep never propagates, returns skipped", async () => {
    const store: Record<string, string> = { [preFor("case1-ab")]: JSON.stringify(PRE_REC) };
    const d = { ...finalizeDeps(store, []), headSha: async (_cwd: string) => { throw new Error("git boom"); } };
    await expect(finalizeCase1(ARGS, ON_CONFIG, ON_ENV, d)).resolves.toBe("skipped");
  });

  test("head_sha / worktree_dirty threaded into the public record's after block", async () => {
    const store: Record<string, string> = { [preFor("case1-ab")]: JSON.stringify(PRE_REC) };
    const d = {
      ...finalizeDeps(store, []),
      headSha: async (_cwd: string) => "cafef00d",
      worktreeDirty: async (_cwd: string) => false,
    };
    const r = await finalizeCase1(ARGS, ON_CONFIG, ON_ENV, d);
    expect(r).toBe("finalized");
    const pub = JSON.parse(store["/repo/.siltpoke/case1-candidates/case1-ab.public.json"]);
    expect(pub.after.head_sha).toBe("cafef00d");
    expect(pub.after.worktree_dirty).toBe(false);
  });

  test("cwd divergence between pre-capture and finalize-time args → skipped, no writes", async () => {
    const divergentPre = { ...PRE_REC, cwd: "/repo-a" };
    const store: Record<string, string> = { [preFor("case1-ab")]: JSON.stringify(divergentPre) };
    const deleted: string[] = [];
    const d = finalizeDeps(store, deleted);
    const r = await finalizeCase1({ ...ARGS, cwd: "/repo-b" }, ON_CONFIG, ON_ENV, d);
    expect(r).toBe("skipped");
    // stateBase (unchanged) is where public/private WOULD land — assert neither was written.
    expect(store["/repo/.siltpoke/case1-candidates/case1-ab.public.json"]).toBeUndefined();
    expect(store["/repo/.siltpoke/case1-candidates/case1-ab.provenance-private.json"]).toBeUndefined();
    expect(deleted).toEqual([]);
    // the pre.json itself is untouched (still readable at its original path)
    expect(store[preFor("case1-ab")]).toBeDefined();
  });

  test("cwd cosmetic-only differences (trailing slash / relative segments) resolve-equal → NOT skipped", async () => {
    // pre captured at "/repo" (a genuinely different root still skips — asserted
    // above); finalize-time args carry a cosmetically-different but resolve()-equal
    // form of the SAME root — must proceed to finalize, not skip.
    for (const argsCwd of ["/repo/", "/repo/sub/..", "/repo/./"]) {
      const store: Record<string, string> = { [preFor("case1-ab")]: JSON.stringify(PRE_REC) };
      const deleted: string[] = [];
      const d = finalizeDeps(store, deleted);
      const r = await finalizeCase1({ ...ARGS, cwd: argsCwd }, ON_CONFIG, ON_ENV, d);
      expect(r).toBe("finalized");
      expect(store["/repo/.siltpoke/case1-candidates/case1-ab.public.json"]).toBeDefined();
      expect(deleted).toContain("/repo/.siltpoke/case1-candidates/case1-ab.pre.json");
    }
  });
});

// --- Task 10: gcCase1Candidates (orphan GC by age + not-pending) ---

import { gcCase1Candidates } from "../../src/memory/case1-capture";
import type { GcDeps } from "../../src/memory/case1-capture";

const GC_STATE_BASE = "/repo/.siltpoke";
const GC_DIR = `${GC_STATE_BASE}/case1-candidates`;
const NOW = new Date(1_000_000_000);
const MAX_AGE_MS = 3 * 86_400_000; // 3 days

const gcDeps = (mtimes: Record<string, number>, throwing?: { listPre?: boolean; statMtime?: boolean; deleteFile?: boolean }) => {
  const deleted: string[] = [];
  const deps: GcDeps = {
    listPre: async (_dir: string) => {
      if (throwing?.listPre) throw new Error("readdir boom");
      return Object.keys(mtimes);
    },
    statMtime: async (path: string) => {
      if (throwing?.statMtime) throw new Error("stat boom");
      return mtimes[path.slice(GC_DIR.length + 1)] ?? mtimes[path];
    },
    deleteFile: async (path: string) => {
      if (throwing?.deleteFile) throw new Error("unlink boom");
      deleted.push(path);
    },
  };
  return { deps, deleted };
};

describe("gcCase1Candidates", () => {
  test("old orphan (not pending, mtime past cap) → deleted", async () => {
    const oldMtime = NOW.getTime() - MAX_AGE_MS - 1_000;
    const { deps, deleted } = gcDeps({ "case1-aaaa1.pre.json": oldMtime });
    const count = await gcCase1Candidates(
      GC_STATE_BASE,
      { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set() },
      deps,
    );
    expect(count).toBe(1);
    expect(deleted).toEqual([`${GC_DIR}/case1-aaaa1.pre.json`]);
  });

  test("fresh orphan (mtime within cap) → kept", async () => {
    const freshMtime = NOW.getTime() - 1_000;
    const { deps, deleted } = gcDeps({ "case1-bbbb2.pre.json": freshMtime });
    const count = await gcCase1Candidates(
      GC_STATE_BASE,
      { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set() },
      deps,
    );
    expect(count).toBe(0);
    expect(deleted).toEqual([]);
  });

  test("still-pending (capture_id in livePendingIds, even if old) → kept", async () => {
    const oldMtime = NOW.getTime() - MAX_AGE_MS - 1_000;
    const { deps, deleted } = gcDeps({ "case1-cccc3.pre.json": oldMtime });
    const count = await gcCase1Candidates(
      GC_STATE_BASE,
      { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set(["case1-cccc3"]) },
      deps,
    );
    expect(count).toBe(0);
    expect(deleted).toEqual([]);
  });

  test("mixed: only the old, non-pending orphan is deleted", async () => {
    const oldMtime = NOW.getTime() - MAX_AGE_MS - 1_000;
    const freshMtime = NOW.getTime() - 1_000;
    const { deps, deleted } = gcDeps({
      "case1-aaaa1.pre.json": oldMtime,
      "case1-bbbb2.pre.json": freshMtime,
      "case1-cccc3.pre.json": oldMtime,
    });
    const count = await gcCase1Candidates(
      GC_STATE_BASE,
      { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set(["case1-cccc3"]) },
      deps,
    );
    expect(count).toBe(1);
    expect(deleted).toEqual([`${GC_DIR}/case1-aaaa1.pre.json`]);
  });

  test("a throwing listPre never propagates, returns 0", async () => {
    const { deps } = gcDeps({}, { listPre: true });
    await expect(
      gcCase1Candidates(GC_STATE_BASE, { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set() }, deps),
    ).resolves.toBe(0);
  });

  test("a throwing statMtime never propagates, returns count-so-far", async () => {
    const oldMtime = NOW.getTime() - MAX_AGE_MS - 1_000;
    const { deps } = gcDeps({ "case1-aaaa1.pre.json": oldMtime }, { statMtime: true });
    await expect(
      gcCase1Candidates(GC_STATE_BASE, { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set() }, deps),
    ).resolves.toBe(0);
  });

  test("a throwing deleteFile never propagates, returns count-so-far", async () => {
    const oldMtime = NOW.getTime() - MAX_AGE_MS - 1_000;
    const { deps } = gcDeps({ "case1-aaaa1.pre.json": oldMtime }, { deleteFile: true });
    await expect(
      gcCase1Candidates(GC_STATE_BASE, { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set() }, deps),
    ).resolves.toBe(0);
  });

  test("filenames that don't parse to a valid capture_id are never deleted", async () => {
    const oldMtime = NOW.getTime() - MAX_AGE_MS - 1_000;
    const { deps, deleted } = gcDeps({
      "not-a-valid-name.pre.json": oldMtime,
      "../evil.pre.json": oldMtime,
      "case1-dddd4.pre.json": oldMtime,
    });
    const count = await gcCase1Candidates(
      GC_STATE_BASE,
      { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set() },
      deps,
    );
    expect(count).toBe(1);
    expect(deleted).toEqual([`${GC_DIR}/case1-dddd4.pre.json`]);
  });

  test("non-.pre.json entries in the dir listing are ignored", async () => {
    const oldMtime = NOW.getTime() - MAX_AGE_MS - 1_000;
    const { deps, deleted } = gcDeps({
      "case1-dddd4.public.json": oldMtime,
      "case1-dddd4.provenance-private.json": oldMtime,
      "case1-dddd4.pre.json": oldMtime,
    });
    const count = await gcCase1Candidates(
      GC_STATE_BASE,
      { now: NOW, maxAgeMs: MAX_AGE_MS, livePendingIds: new Set() },
      deps,
    );
    expect(count).toBe(1);
    expect(deleted).toEqual([`${GC_DIR}/case1-dddd4.pre.json`]);
  });
});
