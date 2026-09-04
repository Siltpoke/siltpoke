// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Forward-capture case1-freeze — capture-ON end-to-end integration test.
// Drives the REAL Phase-2 path (`sweepEntriesOnce` -> default `finalizeFn` =
// `finalizeCase1` + real `nodeFinalizeDeps`) with the config gate genuinely ON,
// not an injected fake `finalizeFn`. This is the test that would have caught
// the brittle exact-string cwd guard (finding #1): a fake finalizeFn never
// exercises `finalizeCase1`'s own gating logic at all.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueuePending, pendingQueuePath } from "../../src/memory/pending-queue";
import { sweepEntriesOnce } from "../../src/memory/distil-worker";
import { captureCase1Pre, resolveCandidatePath } from "../../src/memory/case1-capture";
import { nodeCaptureDeps } from "../../src/memory/case1-capture-node-deps";
import { fileContentFingerprints, lineContentFingerprint } from "../../src/memory/line-fingerprint";
import { atomicWrite } from "../../src/utils/atomic-write";

const CAPTURE_ID = "case1-e2eaaaa";
const ORIGINAL_ENV = process.env.SILTPOKE_CAPTURE_CASE1;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("case1 capture-ON end-to-end (real finalizeCase1 + real nodeFinalizeDeps)", () => {
  let home: string;
  let state: string;
  let cwd: string;

  beforeEach(() => {
    home = tmp("case1-e2e-home-");
    state = tmp("case1-e2e-state-");
    cwd = tmp("case1-e2e-cwd-");
    process.env.SILTPOKE_CAPTURE_CASE1 = "1";
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env.SILTPOKE_CAPTURE_CASE1;
    else process.env.SILTPOKE_CAPTURE_CASE1 = ORIGINAL_ENV;
  });

  it("acted+appended with capture gate genuinely ON writes public/private records, deletes the pre-snapshot, and leaks no rule text into the public record", async () => {
    // Config gate ON via a real config.json in the temp home (loadCase1CaptureConfig
    // reads `<home>/config.json` -> { case1: { capture_case1: true } }).
    writeFileSync(join(home, "config.json"), JSON.stringify({ case1: { capture_case1: true } }));

    // Real "after" file on disk — finalizeCase1 re-reads it via the real
    // nodeFinalizeDeps.readFileCapped (node:fs), not an injected fake.
    writeFileSync(join(cwd, "a.ts"), "const x = 'fixed';\n");

    // Seed a real .pre.json candidate with a cwd that MATCHES the sweep's cwd arg.
    const prePath = resolveCandidatePath(state, CAPTURE_ID, "pre.json")!;
    const preRecord = {
      schema_version: 1,
      capture_id: CAPTURE_ID,
      critique_id: "c-e2e",
      session_id: "s-e2e",
      cwd,
      phase: "pre" as const,
      created_at: new Date(0).toISOString(),
      before: { files: [{ path: "a.ts", content: "const x = 'buggy';\n", truncated: false }] },
      anchorFps: [{ path: "a.ts", anchor_fingerprints: ["fp1"] }],
      critique: { finding_text: "unused var x", severity: "high", anchors: [{ file: "a.ts" }] },
    };
    atomicWrite(prePath, JSON.stringify(preRecord));
    expect(existsSync(prePath)).toBe(true);

    // Enqueue the matching pending critique — oracle/writer are faked (per the
    // spec's allowance), finalize is NOT.
    await enqueuePending(pendingQueuePath(state), {
      critique_id: "c-e2e",
      session_id: "s-e2e",
      created_sha: null,
      created_at: new Date().toISOString(),
      hooks_elapsed: 0,
      status: "pending",
      severity: "high",
      finding_text: "f",
      anchors: [{ file: "a.ts", line: 1, tool: "tsc", fingerprint: "fp1" }],
      distil_attempts: 0,
      capture_id: CAPTURE_ID,
    });

    const res = await sweepEntriesOnce(home, state, cwd, {
      oracleFn: async () => "acted",
      writeFn: async () => ({ written: "appended" as const, rule_id: "lr-e2e-secret" }),
      // NO finalizeFn override — this is the real Phase-2 wiring under test.
    });

    expect(res.written).toBe(1);
    expect(res.pending).toBe(0);

    const publicPath = resolveCandidatePath(state, CAPTURE_ID, "public.json")!;
    const privatePath = resolveCandidatePath(state, CAPTURE_ID, "provenance-private.json")!;

    expect(existsSync(publicPath)).toBe(true);
    expect(existsSync(privatePath)).toBe(true);
    expect(existsSync(prePath)).toBe(false); // pre-snapshot deleted once both records land

    const pubRaw = readFileSync(publicPath, "utf8");
    const pub = JSON.parse(pubRaw);
    expect("rule" in pub).toBe(false);
    expect(pubRaw).not.toContain("lr-e2e-secret"); // rule_id never reaches the public record
    expect(pub.capture_id).toBe(CAPTURE_ID);
    expect(pub.before.files[0].content).toBe("const x = 'buggy';\n");
    expect(pub.after.files[0].content).toBe("const x = 'fixed';\n");
    // No real git repo in `cwd` -> real (killable-timeout) git calls fail closed.
    expect(pub.after.head_sha).toBeNull();

    const priRaw = readFileSync(privatePath, "utf8");
    const pri = JSON.parse(priRaw);
    expect(pri.rule.id).toBe("lr-e2e-secret");
    expect(pri.cwd).toBe(cwd);
  });

  // --- Exit conditions for the two before-ON follow-ups (deferred 2026-07-29) ---
  //
  // Both halves run the REAL Phase 1 (`captureCase1Pre` + `nodeCaptureDeps`
  // against real files on disk) AND the REAL Phase 2 (`sweepEntriesOnce`'s
  // default `finalizeFn`). Only the oracle + LLM writer are faked.
  const BEFORE = "const a = 1;\nconst bug = 'unfixed';\nconst c = 3;\n";
  const AFTER = "const a = 1;\nconst fixed = 'ok';\nconst c = 3;\n";
  const FLAGGED_LINE = 2;

  async function driveRealCapture(opts?: { byteCap?: number }): Promise<{ pub: any; pri: any }> {
    writeFileSync(join(home, "config.json"), JSON.stringify({ case1: { capture_case1: true } }));
    writeFileSync(join(cwd, "a.ts"), BEFORE);
    const flaggedFp = lineContentFingerprint(BEFORE, FLAGGED_LINE);

    // Phase 1 — real capture of the DEFECT state, at critique-creation time.
    const captureId = await captureCase1Pre(
      {
        critique_id: "c-exit",
        session_id: "s-exit",
        cwd,
        stateBase: state,
        finding_text: "`bug` is dead",
        severity: "high",
        anchors: [{ file: "a.ts", line: FLAGGED_LINE, tool: "tsc", fingerprint: flaggedFp }],
        evidenceFiles: ["a.ts"],
      },
      { capture_case1: true },
      { SILTPOKE_CAPTURE_CASE1: "1" },
      opts?.byteCap === undefined ? nodeCaptureDeps : { ...nodeCaptureDeps, byteCap: opts.byteCap },
    );
    expect(captureId).toMatch(/^case1-/);

    // The user fixes the flagged line.
    writeFileSync(join(cwd, "a.ts"), AFTER);

    await enqueuePending(pendingQueuePath(state), {
      critique_id: "c-exit",
      session_id: "s-exit",
      created_sha: null,
      created_at: new Date().toISOString(),
      hooks_elapsed: 0,
      status: "pending",
      severity: "high",
      finding_text: "`bug` is dead",
      anchors: [{ file: "a.ts", line: FLAGGED_LINE, tool: "tsc", fingerprint: flaggedFp }],
      distil_attempts: 0,
      capture_id: captureId,
    });

    // Phase 2 — real finalize (no `finalizeFn` override).
    await sweepEntriesOnce(home, state, cwd, {
      oracleFn: async () => "acted",
      writeFn: async () => ({
        written: "appended" as const,
        rule_id: "lr-exit",
        rule_text: "Delete dead bindings instead of renaming them",
        rule_category: "dead-code",
      }),
    });

    return {
      pub: JSON.parse(readFileSync(resolveCandidatePath(state, captureId!, "public.json")!, "utf8")),
      pri: JSON.parse(readFileSync(resolveCandidatePath(state, captureId!, "provenance-private.json")!, "utf8")),
    };
  }

  it("EXIT (fingerprint): anchor_fingerprints identifies the SPECIFIC flagged line, and the record answers 'did that line disappear' with no downstream recomputation", async () => {
    const { pub } = await driveRealCapture();
    const flaggedFp = lineContentFingerprint(BEFORE, FLAGGED_LINE);

    // exactly the flagged line's hash — not an undifferentiated whole-file set
    expect(pub.before.files[0].anchor_fingerprints).toEqual([flaggedFp]);
    expect(pub.before.files[0].anchor_fingerprints.length)
      .toBeLessThan(fileContentFingerprints(BEFORE).size);

    // the stored record alone answers the §5 question
    const afterFps = fileContentFingerprints(pub.after.files[0].content);
    expect(afterFps.has(flaggedFp)).toBe(false); // the flagged line is gone → fix confirmed
    expect(afterFps.has(lineContentFingerprint(BEFORE, 1))).toBe(true); // untouched lines survived

    // and it names WHICH line the oracle confirmed fixed
    expect(pub.verified_anchor).toMatchObject({ file: "a.ts", line: FLAGGED_LINE, fingerprint: flaggedFp });
    // per-anchor fidelity survives the PreInput boundary into critique.anchors
    expect(pub.critique.anchors).toEqual([
      { file: "a.ts", line: FLAGGED_LINE, tool: "tsc", fingerprint: flaggedFp },
    ]);
  });

  it("EXIT (fingerprint, truncated): the flagged line's hash survives even when its line is PAST the byte cap", async () => {
    // byteCap 14 keeps only "const a = 1;\n" — the flagged line 2 is cut off, so
    // a whole-file hash of the CAPPED content could never contain it. The
    // critique-time fingerprint must carry through (spec §5).
    const { pub } = await driveRealCapture({ byteCap: 14 });
    const flaggedFp = lineContentFingerprint(BEFORE, FLAGGED_LINE);
    expect(pub.before.files[0].truncated).toBe(true);
    expect(pub.before.files[0].content).not.toContain("bug");
    expect(pub.before.files[0].anchor_fingerprints).toEqual([flaggedFp]);
    expect(pub.admissible_for_reconstruction).toBe(false); // truncated → still inadmissible
  });

  it("EXIT (rule provenance): provenance-private.json freezes the rule's text + category, not an id-only pointer", async () => {
    const { pub, pri } = await driveRealCapture();
    expect(pri.rule).toEqual({
      id: "lr-exit",
      text: "Delete dead bindings instead of renaming them",
      category: "dead-code",
    });
    // blindness unchanged: none of it leaks into the public record
    const pubStr = JSON.stringify(pub);
    expect(pubStr).not.toContain("Delete dead bindings");
    expect(pubStr).not.toContain("dead-code");
    expect(pubStr).not.toContain("lr-exit");
    expect("rule" in pub).toBe(false);
  });
});
