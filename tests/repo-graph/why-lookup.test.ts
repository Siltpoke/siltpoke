import { test, expect } from "bun:test";
import { lookupWhy } from "../../src/repo-graph/why-lookup";
import type { WhyIndex } from "../../src/repo-graph/why-index";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const idx1 = (host = "claude-code"): WhyIndex => ({ [SHA_A]: { sessions: [{ session_id: "s1", transcript_path: "/t/s1.jsonl", host: host as never, recorded_at: "x" }] } });
const oneTurn = JSON.stringify({ type: "user", message: { role: "user", content: "add rate limiting" } }) + "\n" +
  JSON.stringify({ type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/login.ts" } }] } });
const blameOK = async () => ({ kind: "commits" as const, entries: [{ sha: SHA_A, committerDate: "2026-07-27T00:30:00.000Z" }] });

test("rung 1 — single sha, single session, single target-file turn ⇒ verbatim ask", async () => {
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: blameOK, readIndex: async () => idx1(), readTranscript: () => oneTurn });
  expect(r).toMatchObject({ rung: 1, anchor_scope: "turn", user_ask: "add rate limiting", session_id: "s1", turn_index: 0 });
});

test("rung U — uncommitted target ⇒ not-yet-committed, never rung 3", async () => {
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: async () => ({ kind: "uncommitted" }), readIndex: async () => ({}), readTranscript: () => null });
  expect(r).toMatchObject({ rung: "U", anchor_scope: "uncommitted" });
});

test("rung 3 — newest sha not in index (squash/rewrite/cold)", async () => {
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: async () => ({ kind: "commits", entries: [{ sha: SHA_B, committerDate: "2026-07-27T00:30:00.000Z" }] }), readIndex: async () => idx1(), readTranscript: () => null });
  expect(r).toMatchObject({ rung: 3, anchor_scope: "none" });
});

test("newest-but-unindexed tweak does NOT hide the older indexed commit ⇒ rung 1 via SHA_A", async () => {
  const blame = async () => ({ kind: "commits" as const, entries: [
    { sha: SHA_B, committerDate: "2026-07-27T00:40:00.000Z" }, // newest, NOT indexed (e.g. formatting)
    { sha: SHA_A, committerDate: "2026-07-27T00:30:00.000Z" }, // older, indexed
  ] });
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame, readIndex: async () => idx1(), readTranscript: () => oneTurn });
  expect(r).toMatchObject({ rung: 1, session_id: "s1" });
});

test("rung 2 — sha claimed by >1 session ⇒ session-level, no ask", async () => {
  const two: WhyIndex = { [SHA_A]: { sessions: [
    { session_id: "s1", transcript_path: "/t/s1.jsonl", host: "claude-code", recorded_at: "x" },
    { session_id: "s2", transcript_path: "/t/s2.jsonl", host: "claude-code", recorded_at: "x" },
  ] } };
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: blameOK, readIndex: async () => two, readTranscript: () => oneTurn });
  expect(r.rung).toBe(2); expect(r.anchor_scope).toBe("session"); expect(r.user_ask).toBeUndefined();
});

test("rung 2 — two prompts edited the TARGET file ⇒ no timestamp tie-break", async () => {
  const twoTurns = [
    JSON.stringify({ type: "user", message: { role: "user", content: "SECURITY fix" } }),
    JSON.stringify({ type: "assistant", timestamp: "t1", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/login.ts" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: "format imports" } }),
    JSON.stringify({ type: "assistant", timestamp: "t2", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/login.ts" } }] } }),
  ].join("\n");
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: blameOK, readIndex: async () => idx1(), readTranscript: () => twoTurns });
  expect(r.rung).toBe(2); expect(r.user_ask).toBeUndefined();
});

test("rung 2 — a turn that only edited ANOTHER file never lends its ask (multi-file-commit leak)", async () => {
  const otherFile = [
    JSON.stringify({ type: "user", message: { role: "user", content: "update styles" } }),
    JSON.stringify({ type: "assistant", timestamp: "t2", message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/other.ts" } }] } }),
  ].join("\n");
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: blameOK, readIndex: async () => idx1(), readTranscript: () => otherFile });
  expect(r.rung).toBe(2); expect(r.user_ask).toBeUndefined();
});

test("rung 2 — unsupported-read host (codex) ⇒ session-level, transcript NEVER opened", async () => {
  let opened = false;
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: blameOK, readIndex: async () => idx1("codex"), readTranscript: () => { opened = true; return oneTurn; } });
  expect(r.rung).toBe(2); expect(opened).toBe(false);
});

test("rung 3 — a thrown readIndex never leaks; degrades to no-WHY", async () => {
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: blameOK, readIndex: async () => { throw new Error("boom"); }, readTranscript: () => oneTurn });
  expect(r).toMatchObject({ rung: 3, anchor_scope: "none" });
});

test("baselineSha refines to changed hunks — the line-range path never falls back to whole-file blame", async () => {
  // Changed lines (12-14) were last touched by SHA_A (indexed, session s1).
  // A SECOND sha (SHA_B, session s2) is indexed too and is what the mocked
  // `blame` would wrongly return if it were EVER called whole-file
  // (startLine undefined). The test fails loudly on that regression: (1) it
  // records every startLine `blame` is called with and asserts it is ONLY
  // ever 12 (never undefined/whole-file), and (2) it asserts the resolved
  // session is s1, never s2 — the would-be whole-file wrong answer.
  const changed = async () => [{ start: 12, end: 14 }];
  const calls: (number | undefined)[] = [];
  const blame = async ({ startLine }: { startLine?: number }) => {
    calls.push(startLine);
    return startLine === 12
      ? { kind: "commits" as const, entries: [{ sha: SHA_A, committerDate: "2026-07-27T00:30:00.000Z" }] }
      : { kind: "commits" as const, entries: [{ sha: SHA_B, committerDate: "2026-07-27T09:00:00.000Z" }] };
  };
  const twoShaIdx: WhyIndex = {
    [SHA_A]: { sessions: [{ session_id: "s1", transcript_path: "/t/s1.jsonl", host: "claude-code", recorded_at: "x" }] },
    [SHA_B]: { sessions: [{ session_id: "s2", transcript_path: "/t/s2.jsonl", host: "claude-code", recorded_at: "x" }] },
  };
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", baselineSha: "base", changed, blame, readIndex: async () => twoShaIdx, readTranscript: () => oneTurn });
  expect(calls).toEqual([12]);                              // blame ONLY ever called with the changed range's startLine — never whole-file
  expect(r).toMatchObject({ rung: 1, session_id: "s1" });   // SHA_A (changed region), never SHA_B/s2 (the whole-file wrong answer)
});

test("no baselineSha ⇒ whole-file fallback (existing behavior unchanged)", async () => {
  const r = await lookupWhy({ cwd: "/r", file: "src/login.ts", blame: blameOK, readIndex: async () => idx1(), readTranscript: () => oneTurn });
  expect(r).toMatchObject({ rung: 1 });   // no baselineSha path still works
});
