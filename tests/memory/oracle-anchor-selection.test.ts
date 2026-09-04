// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// The oracle used to judge `anchors[0]` and nothing else, so one unusable
// anchor threw away the whole critique.
//
// Live instance — critique c-193a (2026-08-25). Its three anchors were:
//   [0] /tmp/ci-2-signal.log      ← god-file rubric hit on a build log
//   [1] tests/brain/semantic-category.test.ts:24   ← real, readable, fingerprinted
//   [2] src/brain/schema.ts:105                    ← real, readable, fingerprinted
// The oracle read [0], `join(cwd, "/tmp/…")` resolved to a path that does not
// exist, and it abstained `file_unreadable` on every sweep until the TTL
// dropped it. [1] and [2] were never looked at.
import { test, expect } from "bun:test";
import { adjudicate } from "../../src/memory/acted-on-oracle";
import type { PendingCritique } from "../../src/memory/pending-queue";
import { lineContentFingerprint } from "../../src/memory/line-fingerprint";

const orig = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
const fp3 = lineContentFingerprint(orig, 3);

const withAnchors = (anchors: PendingCritique["anchors"]): PendingCritique => ({
  critique_id: "c-1", session_id: "s1", created_sha: "sha0", created_at: "2026-08-25T00:00:00Z",
  hooks_elapsed: 0, status: "pending", severity: "medium", finding_text: "fix line 3",
  anchors, distil_attempts: 0,
});

const good = { file: "good.ts", line: 3, tool: "git-diff" as const, fingerprint: fp3 };
const unreadable = { file: "gone.ts", line: 3, tool: "git-diff" as const, fingerprint: fp3 };
const noFingerprint = { file: "good.ts", line: 3, tool: "git-diff" as const, fingerprint: "" };
const outside = { file: "/tmp/ci-2-signal.log", line: 1, tool: "git-diff" as const, fingerprint: fp3 };

/** Only `good.ts` exists; everything else reads as deleted. */
const readOnlyGood = async (_cwd: string, file: string): Promise<string | null> =>
  file.endsWith("good.ts") ? orig : null;

test("skips an unreadable anchor and judges the next usable one", async () => {
  const r = await adjudicate(withAnchors([unreadable, good]), "/x", { readFileAt: readOnlyGood });
  expect(r.verdict).toBe("not_yet"); // content still present in good.ts
  expect(r.verdict_tier).toBe(2);
  expect(r.abstain_reason).toBeUndefined();
});

test("skips a fingerprint-less anchor and judges the next usable one", async () => {
  const edited = orig.replace("const c = 3;", "const c = 99;");
  const r = await adjudicate(withAnchors([noFingerprint, good]), "/x", {
    readFileAt: async () => edited,
  });
  expect(r.verdict).toBe("acted"); // flagged content is gone from the second anchor
  expect(r.verdict_tier).toBe(2);
});

test("skips an anchor pointing outside the repo — c-193a's exact shape", async () => {
  const r = await adjudicate(withAnchors([outside, good]), "/x", { readFileAt: readOnlyGood });
  expect(r.verdict).toBe("not_yet");
  expect(r.abstain_reason).toBeUndefined();
});

test("an outside-repo anchor is never read from disk", async () => {
  // `join(cwd, "/tmp/x")` used to produce `<cwd>/tmp/x` — a silent mis-resolve
  // that looked like a deleted file. The path must not reach the reader at all.
  const seen: string[] = [];
  await adjudicate(withAnchors([outside, good]), "/x", {
    readFileAt: async (_c, f) => { seen.push(f); return readOnlyGood(_c, f); },
  });
  expect(seen).toEqual(["good.ts"]);
});

test("all anchors unusable -> abstain, reporting the FIRST anchor's reason", async () => {
  const r = await adjudicate(withAnchors([unreadable, noFingerprint]), "/x", {
    readFileAt: async (_c, f) => (f.endsWith("good.ts") ? orig : null),
  });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("file_unreadable");
  expect(r.verdict_tier).toBeUndefined();
});

test("an all-outside critique abstains with its own distinguishable reason", async () => {
  const r = await adjudicate(withAnchors([outside]), "/x", { readFileAt: readOnlyGood });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("anchor_outside_repo");
});

test("a tier-1 verdict on a later anchor is still reached", async () => {
  const tsc = { file: "good.ts", line: 3, tool: "tsc" as const, fingerprint: fp3 };
  const r = await adjudicate(withAnchors([unreadable, tsc]), "/x", {
    readFileAt: readOnlyGood,
    rerunChecker: async () => true,
  });
  expect(r.verdict).toBe("acted");
  expect(r.verdict_tier).toBe(1);
});

// --- positive controls: single-anchor behaviour must be unchanged ---

test("a lone good anchor still decides exactly as before", async () => {
  const r = await adjudicate(withAnchors([good]), "/x", { readFileAt: readOnlyGood });
  expect(r.verdict).toBe("not_yet");
  expect(r.verdict_tier).toBe(2);
});

test("a lone unreadable anchor still abstains file_unreadable", async () => {
  const r = await adjudicate(withAnchors([unreadable]), "/x", { readFileAt: readOnlyGood });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("file_unreadable");
});

test("an empty anchor list still abstains no_anchor", async () => {
  const r = await adjudicate(withAnchors([]), "/x", { readFileAt: readOnlyGood });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("no_anchor");
});

test("a null baseline still short-circuits before any anchor is read", async () => {
  const seen: string[] = [];
  const e = { ...withAnchors([good]), created_sha: null };
  const r = await adjudicate(e, "/x", {
    readFileAt: async (_c, f) => { seen.push(f); return orig; },
  });
  expect(r.abstain_reason).toBe("no_baseline_sha");
  expect(seen).toEqual([]);
});

test("a thrown reader still abstains `threw` rather than being skipped as unusable", async () => {
  // A throw is a bug signal, not a "try the next anchor" condition — swallowing
  // it into the skip loop would hide a real defect behind a plausible verdict.
  const r = await adjudicate(withAnchors([good, good]), "/x", {
    readFileAt: async () => { throw new Error("EBUSY"); },
  });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("threw");
});
