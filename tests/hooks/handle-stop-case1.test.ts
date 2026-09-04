// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Task 8 — the thin `stampCase1Capture` wrapper that both `handle-stop.ts`
// enqueue sites call just before `pendingCritiqueSchema.parse` writes the
// entry. Tests the wrapper with fully injected `CaptureDeps` — no real fs,
// no `~/.siltpoke`, no git. The heavy hook itself (`handleStopHook`) is
// deliberately NOT exercised here.
import { describe, expect, test } from "bun:test";
import { stampCase1Capture, type StampCase1Ctx } from "../../src/hooks/handle-stop";
import type { CaptureDeps } from "../../src/memory/case1-capture";
import type { PendingCritique } from "../../src/memory/pending-queue";

const baseEntry = (): PendingCritique => ({
  critique_id: "c-1",
  session_id: "s-1",
  created_sha: null,
  created_at: "2026-01-01T00:00:00.000Z",
  hooks_elapsed: 0,
  status: "pending",
  severity: "medium",
  finding_text: "the finding",
  anchors: [],
  distil_attempts: 0,
});

const baseCtx = (overrides?: Partial<StampCase1Ctx>): StampCase1Ctx => ({
  critique_id: "c-1",
  session_id: "s-1",
  cwd: "/repo",
  stateBase: "/repo/.siltpoke",
  finding_text: "the finding",
  severity: "medium",
  anchors: [{ file: "a.ts", line: 7, tool: "tsc", fingerprint: "fp-flagged" }],
  evidenceFiles: [],
  config: { capture_case1: true },
  env: { SILTPOKE_CAPTURE_CASE1: "1" },
  ...overrides,
});

const okDeps = (writes: Record<string, string>): CaptureDeps => ({
  readFileCapped: async (absPath: string) => ({ content: `content:${absPath}`, truncated: false }),
  fingerprintsFor: () => ["fp1"],
  writeAtomic: async (p: string, data: string) => {
    writes[p] = data;
  },
  now: () => new Date(0),
});

describe("stampCase1Capture", () => {
  test("enabled + safe file → entry gains capture_id, pre file written", async () => {
    const writes: Record<string, string> = {};
    const entry = await stampCase1Capture(baseEntry(), baseCtx(), okDeps(writes));
    expect(entry.capture_id).toMatch(/^case1-/);
    expect(Object.keys(writes).length).toBe(1);
    const rec = JSON.parse(Object.values(writes)[0]!);
    expect(rec.phase).toBe("pre");
    expect(rec.critique_id).toBe("c-1");
    // original fields survive untouched
    expect(entry.finding_text).toBe("the finding");
    expect(entry.severity).toBe("medium");
  });

  test("the ctx's full anchors reach the pre-record — nothing narrows them to `{ file }`", async () => {
    // `StampCase1Ctx.anchors` REQUIRES `tool` + `fingerprint` precisely so a
    // narrowing `anchors.map((a) => ({ file: a.file }))` at either handle-stop
    // enqueue site fails typecheck instead of silently gutting the record
    // (which is exactly what shipped before this fix).
    const writes: Record<string, string> = {};
    await stampCase1Capture(baseEntry(), baseCtx(), okDeps(writes));
    const rec = JSON.parse(Object.values(writes)[0]!);
    expect(rec.critique.anchors).toEqual([
      { file: "a.ts", line: 7, tool: "tsc", fingerprint: "fp-flagged" },
    ]);
  });

  test("disabled (gate off) → entry unchanged, no write", async () => {
    const writes: Record<string, string> = {};
    const original = baseEntry();
    const entry = await stampCase1Capture(
      original,
      baseCtx({ config: { capture_case1: false } }),
      okDeps(writes),
    );
    expect(entry).toEqual(original);
    expect(entry.capture_id).toBeUndefined();
    expect(Object.keys(writes).length).toBe(0);
  });

  test("disabled (env off) → entry unchanged, no write", async () => {
    const writes: Record<string, string> = {};
    const original = baseEntry();
    const entry = await stampCase1Capture(original, baseCtx({ env: {} }), okDeps(writes));
    expect(entry).toEqual(original);
    expect(Object.keys(writes).length).toBe(0);
  });

  test("captureCase1Pre returns undefined (no safe files) → entry unchanged, enqueue not blocked", async () => {
    const writes: Record<string, string> = {};
    const original = baseEntry();
    const entry = await stampCase1Capture(
      original,
      baseCtx({ anchors: [], evidenceFiles: ["/etc/passwd", "../x"] }),
      okDeps(writes),
    );
    expect(entry).toEqual(original);
    expect(Object.keys(writes).length).toBe(0);
  });

  test("a throwing dep never propagates — entry unchanged, no throw", async () => {
    const original = baseEntry();
    const throwingDeps: CaptureDeps = {
      readFileCapped: async () => {
        throw new Error("disk exploded");
      },
      fingerprintsFor: () => {
        throw new Error("should not be reached, but must not propagate either");
      },
      writeAtomic: async () => {
        throw new Error("should not be reached");
      },
      now: () => new Date(0),
    };
    await expect(stampCase1Capture(original, baseCtx(), throwingDeps)).resolves.toEqual(original);
  });
});
