import { test, expect } from "bun:test";
import { actedOnOracle, adjudicate } from "../../src/memory/acted-on-oracle";
import type { PendingCritique } from "../../src/memory/pending-queue";
import { lineContentFingerprint } from "../../src/memory/line-fingerprint";

const orig = ["const a = 1;", "const b = 2;", "const c = 3;", "const d = 4;", "const e = 5;"].join("\n");
const entry = (tool: "tsc" | "git-diff"): PendingCritique => ({
  critique_id: "c-1", session_id: "s1", created_sha: "sha0", created_at: "2026-07-15T00:00:00Z",
  hooks_elapsed: 0, status: "pending", severity: "medium", finding_text: "fix line 3",
  anchors: [{ file: "foo.ts", line: 3, tool, fingerprint: lineContentFingerprint(orig, 3) }],
  distil_attempts: 0,
});

test("error-cleared -> acted, brain fully absent (AC8)", async () => {
  const v = await actedOnOracle(entry("tsc"), "/x", { readFileAt: async () => orig, rerunChecker: async () => true });
  expect(v).toBe("acted");
});

test("flagged content gone -> acted (AC2)", async () => {
  const edited = orig.replace("const c = 3;", "const c = 99;");
  const v = await actedOnOracle(entry("git-diff"), "/x", { readFileAt: async () => edited });
  expect(v).toBe("acted");
});

test("reformat-only -> not_yet (content-fingerprint stable)", async () => {
  const spaced = orig.replace("const c = 3;", "const   c = 3;");
  const v = await actedOnOracle(entry("git-diff"), "/x", { readFileAt: async () => spaced });
  expect(v).toBe("not_yet");
});

test("unrelated upstream edit shifts the line -> NOT acted (drift-robust; the fix)", async () => {
  const shifted = "const z = 0;\n" + orig;
  const v = await actedOnOracle(entry("git-diff"), "/x", { readFileAt: async () => shifted });
  expect(v).toBe("not_yet");
});

test("pure move (content relocated) -> not_yet", async () => {
  const moved = orig.replace("const c = 3;", "") + "\nconst c = 3;";
  const v = await actedOnOracle(entry("git-diff"), "/x", { readFileAt: async () => moved });
  expect(v).toBe("not_yet");
});

test("file deleted -> abstain (AC3)", async () => {
  const v = await actedOnOracle(entry("git-diff"), "/x", { readFileAt: async () => null });
  expect(v).toBe("abstain");
});

test("baseline null -> abstain (AC3)", async () => {
  const e = { ...entry("git-diff"), created_sha: null };
  const v = await actedOnOracle(e, "/x", { readFileAt: async () => orig });
  expect(v).toBe("abstain");
});

// --- adjudicate(): the rich verdict (eval design §2.2) ---
//
// `abstain` today is a lie of omission: FIVE distinct causes collapse into one
// token, so an adjudication log built on it could report "40% abstain" without
// anyone being able to say whether that is a capture bug, a deleted file, or a
// baseline problem. Each cause gets its own reason, and each test below pins
// exactly one of them — if two causes shared a reason string, the pair of tests
// asserting them would still pass, so they are deliberately distinct values.

test("adjudicate: baseline null abstains for its own reason", async () => {
  const e = { ...entry("git-diff"), created_sha: null };
  const r = await adjudicate(e, "/x", { readFileAt: async () => orig });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("no_baseline_sha");
  expect(r.verdict_tier).toBeUndefined(); // nothing decided it
});

test("adjudicate: a critique with no anchor abstains for its own reason", async () => {
  const e = { ...entry("git-diff"), anchors: [] };
  const r = await adjudicate(e, "/x", { readFileAt: async () => orig });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("no_anchor");
});

test("adjudicate: an unreadable file abstains for its own reason", async () => {
  const r = await adjudicate(entry("git-diff"), "/x", { readFileAt: async () => null });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("file_unreadable");
});

test("adjudicate: a failed fingerprint capture abstains for its own reason", async () => {
  const e = { ...entry("git-diff"), anchors: [{ file: "foo.ts", line: 3, tool: "git-diff" as const, fingerprint: "" }] };
  const r = await adjudicate(e, "/x", { readFileAt: async () => orig });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("no_fingerprint");
});

test("adjudicate: a thrown error abstains for its own reason", async () => {
  const r = await adjudicate(entry("git-diff"), "/x", {
    readFileAt: async () => { throw new Error("EBUSY"); },
  });
  expect(r.verdict).toBe("abstain");
  expect(r.abstain_reason).toBe("threw");
});

test("adjudicate: the five abstain reasons are all distinct", async () => {
  // Guards the property the individual tests above rely on. If two causes were
  // ever collapsed onto one string, every test above would still pass while the
  // log lost the ability to tell them apart — which is the exact defect being
  // fixed here.
  const reasons = await Promise.all([
    adjudicate({ ...entry("git-diff"), created_sha: null }, "/x", { readFileAt: async () => orig }),
    adjudicate({ ...entry("git-diff"), anchors: [] }, "/x", { readFileAt: async () => orig }),
    adjudicate(entry("git-diff"), "/x", { readFileAt: async () => null }),
    adjudicate({ ...entry("git-diff"), anchors: [{ file: "foo.ts", line: 3, tool: "git-diff" as const, fingerprint: "" }] }, "/x", { readFileAt: async () => orig }),
    adjudicate(entry("git-diff"), "/x", { readFileAt: async () => { throw new Error("EBUSY"); } }),
  ]).then((rs) => rs.map((r) => r.abstain_reason));

  expect(new Set(reasons).size).toBe(5);
});

test("adjudicate: tier 1 when the checker rerun decided, tier 2 when the fingerprint did", async () => {
  const cleared = await adjudicate(entry("tsc"), "/x", { readFileAt: async () => orig, rerunChecker: async () => true });
  expect(cleared.verdict).toBe("acted");
  expect(cleared.verdict_tier).toBe(1);

  const stillFailing = await adjudicate(entry("tsc"), "/x", { readFileAt: async () => orig, rerunChecker: async () => false });
  expect(stillFailing.verdict).toBe("not_yet");
  expect(stillFailing.verdict_tier).toBe(1);

  // rerunChecker returning null falls through to the content fingerprint.
  const edited = orig.replace("const c = 3;", "const c = 99;");
  const byContent = await adjudicate(entry("tsc"), "/x", { readFileAt: async () => edited, rerunChecker: async () => null });
  expect(byContent.verdict).toBe("acted");
  expect(byContent.verdict_tier).toBe(2);
});

test("adjudicate: a decided verdict carries no abstain reason", async () => {
  const r = await adjudicate(entry("git-diff"), "/x", { readFileAt: async () => orig });
  expect(r.verdict).toBe("not_yet");
  expect(r.abstain_reason).toBeUndefined();
});
