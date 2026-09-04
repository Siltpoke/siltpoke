// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { AST_SIG_VERSION } from "../../src/repo-graph/ast-signature";
import {
  classifyAll,
  classifySeenFingerprintDelta,
} from "../../src/repo-graph/seen-delta";
import { emptySeen } from "../../src/repo-graph/store";
import type { Fingerprints, SeenWatermark } from "../../src/repo-graph/types";

const FP = (sha: string, sig: string) => ({ content_sha256: sha, ast_sig: sig });
const call = (
  seen: { content_sha256: string; ast_sig: string } | undefined,
  cur: { content_sha256: string; ast_sig: string } | undefined,
  mismatch = false,
) => classifySeenFingerprintDelta(seen, cur, { astSigVersionMismatch: mismatch });

// Typed aliases (derived from the real function signature, no `any`) used
// only to construct deliberately-malformed shape-guard fixtures below.
type SeenSideParam = Parameters<typeof classifySeenFingerprintDelta>[0];
type CurrentSideParam = Parameters<typeof classifySeenFingerprintDelta>[1];

describe("classifySeenFingerprintDelta", () => {
  test("no watermark entry → new_to_you, no change flags", () => {
    const d = call(undefined, FP("a", "s"));
    expect(d.baseline_status).toBe("new_to_you");
    expect(d.signature_changed).toBe(false);
    expect(d.body_changed).toBe(false);
  });

  test("gone from current → deleted", () => {
    expect(call(FP("a", "s"), undefined).baseline_status).toBe("deleted");
  });

  test("body changed only → body_changed true, signature_changed false", () => {
    const d = call(FP("a", "s"), FP("b", "s"));
    expect(d.baseline_status).toBe("tracked");
    expect(d.body_changed).toBe(true);
    expect(d.signature_changed).toBe(false);
  });

  test("signature AND body changed → BOTH true (not collapsed)", () => {
    const d = call(FP("a", "s1"), FP("b", "s2"));
    expect(d.signature_changed).toBe(true);
    expect(d.body_changed).toBe(true);
  });

  test("astSigVersionMismatch → signature_changed forced false even when ast_sig differs; body still reflected", () => {
    const d = call(FP("a", "s1"), FP("b", "s2"), true);
    expect(d.signature_changed).toBe(false);
    expect(d.body_changed).toBe(true);
  });

  test("no change at all → tracked, both flags false", () => {
    const d = call(FP("a", "s"), FP("a", "s"));
    expect(d.baseline_status).toBe("tracked");
    expect(d.signature_changed).toBe(false);
    expect(d.body_changed).toBe(false);
  });

  // C5 — unparseable is scoped BY baseline_status, not a blanket OR.
  describe("C5 — unparseable by baseline_status", () => {
    test("tracked: empty ast_sig on seen side only → unparseable true, signature_changed false, body still reflected", () => {
      const d = call(FP("a", ""), FP("b", "s"));
      expect(d.baseline_status).toBe("tracked");
      expect(d.unparseable).toBe(true);
      expect(d.signature_changed).toBe(false);
      expect(d.body_changed).toBe(true);
    });

    test("tracked: empty ast_sig on current side only → unparseable true", () => {
      const d = call(FP("a", "s"), FP("b", ""));
      expect(d.baseline_status).toBe("tracked");
      expect(d.unparseable).toBe(true);
      expect(d.signature_changed).toBe(false);
    });

    test("tracked: empty ast_sig BOTH sides → unparseable true, signature_changed false, body still reflected", () => {
      const d = call(FP("a", ""), FP("b", ""));
      expect(d.unparseable).toBe(true);
      expect(d.signature_changed).toBe(false);
      expect(d.body_changed).toBe(true);
    });

    test("new_to_you: current has a REAL ast_sig → NOT unparseable (only current side matters)", () => {
      const d = call(undefined, FP("a", "s"));
      expect(d.baseline_status).toBe("new_to_you");
      expect(d.unparseable).toBe(false);
    });

    test("new_to_you: current ast_sig empty → unparseable true", () => {
      const d = call(undefined, FP("a", ""));
      expect(d.baseline_status).toBe("new_to_you");
      expect(d.unparseable).toBe(true);
    });

    test("deleted: seen had a REAL ast_sig → NOT unparseable (only seen side matters)", () => {
      const d = call(FP("a", "s"), undefined);
      expect(d.baseline_status).toBe("deleted");
      expect(d.unparseable).toBe(false);
    });

    test("deleted: seen ast_sig empty → unparseable true", () => {
      const d = call(FP("a", ""), undefined);
      expect(d.baseline_status).toBe("deleted");
      expect(d.unparseable).toBe(true);
    });
  });

  // Task-1 carry-forward — malformed per-entry shape defense.
  describe("carry-forward — malformed per-entry shape guard", () => {
    test("seen entry missing ast_sig (malformed) → treated as absent (not a throw), so the file reads new_to_you", () => {
      // Deliberately malformed: real `seen.json` shape validation is only
      // top-level (task-1 carry-forward) — a per-entry value can lack
      // `ast_sig`. Cast through `unknown` (never `any`) to construct it.
      const malformed = { content_sha256: "a" } as unknown as SeenSideParam;
      expect(() => classifySeenFingerprintDelta(malformed, FP("b", "s"), { astSigVersionMismatch: false })).not.toThrow();
      const d = classifySeenFingerprintDelta(malformed, FP("b", "s"), { astSigVersionMismatch: false });
      // A malformed seen-side entry is treated exactly like a missing one —
      // same codepath as "no watermark entry" (first test above).
      expect(d.baseline_status).toBe("new_to_you");
      expect(d.unparseable).toBe(false); // the surviving current side has a real ast_sig
    });

    test("seen entry malformed AND current ast_sig empty → unparseable true (current side drives it)", () => {
      const malformed = { content_sha256: "a" } as unknown as SeenSideParam;
      const d = classifySeenFingerprintDelta(malformed, FP("b", ""), { astSigVersionMismatch: false });
      expect(d.baseline_status).toBe("new_to_you");
      expect(d.unparseable).toBe(true);
    });

    test("current entry that is not an object → treated as unparseable, not a throw", () => {
      const malformed = "not-an-object" as unknown as CurrentSideParam;
      expect(() => classifySeenFingerprintDelta(FP("a", "s"), malformed, { astSigVersionMismatch: false })).not.toThrow();
    });
  });
});

describe("classifyAll", () => {
  function seenWith(files: SeenWatermark["files"], astSigVersion = AST_SIG_VERSION): SeenWatermark {
    return { ...emptySeen(), ast_sig_version: astSigVersion, files };
  }
  function currentWith(files: Fingerprints["files"]): Fingerprints {
    return { schemaVersion: 1, files };
  }

  test("key union — new, tracked-changed, and deleted files all appear; unchanged tracked dropped", () => {
    const seen = seenWith({
      "a.ts": FP("a1", "s1"), // tracked, unchanged
      "b.ts": FP("b1", "s1"), // deleted (missing from current)
    });
    const current = currentWith({
      "a.ts": FP("a1", "s1"), // unchanged
      "c.ts": FP("c1", "s1"), // new_to_you
    });
    const deltas = classifyAll(seen, current);
    const byPath = Object.fromEntries(deltas.map((d) => [d.path, d]));
    expect(deltas.length).toBe(2);
    expect(byPath["a.ts"]).toBeUndefined(); // dropped: tracked + unchanged
    expect(byPath["b.ts"]?.baseline_status).toBe("deleted");
    expect(byPath["c.ts"]?.baseline_status).toBe("new_to_you");
  });

  test("drop-unchanged-tracked: a tracked file with a real change is NOT dropped", () => {
    const seen = seenWith({ "a.ts": FP("a1", "s1") });
    const current = currentWith({ "a.ts": FP("a2", "s1") });
    const deltas = classifyAll(seen, current);
    expect(deltas.length).toBe(1);
    expect(deltas[0]?.path).toBe("a.ts");
    expect(deltas[0]?.body_changed).toBe(true);
  });

  test("canonical-path attachment — path is attached as the canonicalized key", () => {
    const seen = seenWith({ "src/a.ts": FP("a1", "s1") });
    const current = currentWith({ "src/a.ts": FP("a2", "s1") });
    const deltas = classifyAll(seen, current);
    expect(deltas[0]?.path).toBe("src/a.ts");
  });

  // C6 — canonicalize BOTH seen keys and current.files keys before the union.
  describe("C6 — non-canonical current keys", () => {
    test("a leading-slash current key canonicalizes to match a plain seen key (no false 'deleted')", () => {
      const seen = seenWith({ "src/a.ts": FP("a1", "s1") });
      const current = currentWith({ "/src/a.ts": FP("a1", "s1") });
      const deltas = classifyAll(seen, current);
      // Must be recognized as the SAME file (tracked, unchanged) — dropped, not flagged deleted.
      expect(deltas.find((d) => d.path === "src/a.ts")).toBeUndefined();
      expect(deltas.find((d) => d.baseline_status === "deleted")).toBeUndefined();
    });

    test("a root-escaping current key is skipped, not thrown", () => {
      const seen = seenWith({ "a.ts": FP("a1", "s1") });
      const current = currentWith({
        "a.ts": FP("a1", "s1"),
        "../escape.ts": FP("x", "y"),
      });
      expect(() => classifyAll(seen, current)).not.toThrow();
      const deltas = classifyAll(seen, current);
      expect(deltas.find((d) => d.path.includes("escape"))).toBeUndefined();
    });

    test("a root-escaping seen key is skipped, not thrown", () => {
      const seen = seenWith({
        "a.ts": FP("a1", "s1"),
        "../escape.ts": FP("x", "y"),
      });
      const current = currentWith({ "a.ts": FP("a1", "s1") });
      expect(() => classifyAll(seen, current)).not.toThrow();
      const deltas = classifyAll(seen, current);
      expect(deltas.find((d) => d.path.includes("escape"))).toBeUndefined();
    });
  });

  // C7 — null/empty fingerprints guard.
  describe("C7 — empty input never throws", () => {
    test("both seen and current empty → returns []", () => {
      expect(classifyAll(seenWith({}), currentWith({}))).toEqual([]);
    });

    test("seen empty, current has files → every current file is new_to_you", () => {
      const deltas = classifyAll(seenWith({}), currentWith({ "a.ts": FP("a1", "s1") }));
      expect(deltas.length).toBe(1);
      expect(deltas[0]?.baseline_status).toBe("new_to_you");
    });

    test("seen has files, current empty (unindexed/index-cleared) → ABSTAIN, returns [] (NOT a whole-repo deleted flood)", () => {
      // Fix round 1 (2026-07-27 review): an entirely-empty `current` means
      // "current state unknown" (never indexed / index cleared), not "every
      // seen file vanished from disk". Reporting N false `deleted` rows here
      // would be exactly the scary, misleading bulk signal this spec's
      // discovery-only guards exist to prevent.
      const deltas = classifyAll(
        seenWith({ "a.ts": FP("a1", "s1"), "b.ts": FP("b1", "s1") }),
        currentWith({}),
      );
      expect(deltas).toEqual([]);
    });

    test("ordinary per-key deleted detection is unaffected: current POPULATED but missing one specific key still reports deleted", () => {
      const deltas = classifyAll(
        seenWith({ "a.ts": FP("a1", "s1"), "b.ts": FP("b1", "s1") }),
        currentWith({ "a.ts": FP("a1", "s1") }), // b.ts genuinely missing
      );
      expect(deltas.length).toBe(1);
      expect(deltas[0]?.path).toBe("b.ts");
      expect(deltas[0]?.baseline_status).toBe("deleted");
    });
  });

  // C8 — version threading via injectable currentVersion.
  describe("C8 — astSigVersionMismatch computed once + threaded via injectable currentVersion", () => {
    test("matching version → signature_changed reflects a real ast_sig diff", () => {
      const seen = seenWith({ "a.ts": FP("a1", "s1") }, AST_SIG_VERSION);
      const current = currentWith({ "a.ts": FP("a1", "s2") });
      const deltas = classifyAll(seen, current, AST_SIG_VERSION);
      expect(deltas[0]?.signature_changed).toBe(true);
    });

    test("mismatching injected currentVersion → NO signature_changed flood across multiple files", () => {
      // Both content_sha256 AND ast_sig differ per file, so each file still
      // surfaces (body_changed keeps it from being dropped as "unchanged
      // tracked") — the assertion under test is that signature_changed is
      // suppressed for ALL of them despite every ast_sig differing.
      const seen = seenWith(
        {
          "a.ts": FP("a1", "s1"),
          "b.ts": FP("b1", "t1"),
        },
        AST_SIG_VERSION,
      );
      const current = currentWith({
        "a.ts": FP("a2", "s2"),
        "b.ts": FP("b2", "t2"),
      });
      // Inject a currentVersion that does NOT match seen.ast_sig_version.
      const deltas = classifyAll(seen, current, AST_SIG_VERSION + 1);
      expect(deltas.length).toBe(2);
      for (const d of deltas) {
        expect(d.signature_changed).toBe(false);
        expect(d.body_changed).toBe(true);
      }
    });

    test("default currentVersion parameter falls back to AST_SIG_VERSION when omitted", () => {
      const seen = seenWith({ "a.ts": FP("a1", "s1") }, AST_SIG_VERSION);
      const current = currentWith({ "a.ts": FP("a1", "s2") });
      const deltas = classifyAll(seen, current); // no third arg
      expect(deltas[0]?.signature_changed).toBe(true);
    });
  });
});
