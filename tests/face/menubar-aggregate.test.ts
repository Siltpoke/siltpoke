// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPendingReviews } from "../../src/face/menubar-aggregate";

// Fixtures use fixed 2026-07-08T10:xx timestamps. Anchor `nowMs` next to them
// with a wide freshness window so the freshness filter never interferes with
// the pending/dedup/action tests below — freshness has its own dedicated test.
const OPTS = { nowMs: Date.parse("2026-07-08T11:00:00Z"), freshnessMs: 24 * 60 * 60 * 1000 };

function seedActionsRaw(home: string, rawLines: string): void {
  writeFileSync(join(home, "critic-actions.jsonl"), rawLines);
}

function seed(rows: object[], actions: object[] = []): string {
  const home = mkdtempSync(join(tmpdir(), "mb-"));
  writeFileSync(
    join(home, "brain-calls.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
  if (actions.length > 0) {
    writeFileSync(
      join(home, "critic-actions.jsonl"),
      `${actions.map((a) => JSON.stringify(a)).join("\n")}\n`,
    );
  }
  return home;
}

test("keeps only fired + untouched reviews", async () => {
  const ackedTs = "2026-07-08T10:01:00Z";
  const home = seed(
    [
      {
        timestamp: "2026-07-08T10:00:00Z",
        session_id: "aaa111",
        cwd: "/x/repo-a",
        critique_id: "c1",
        brain_output: { bubble_short: "pending one", severity: "high" },
        branch: "feat/x",
      },
      {
        timestamp: ackedTs,
        session_id: "bbb222",
        cwd: "/x/repo-b",
        critique_id: "c2",
        brain_output: { bubble_short: "acked one", severity: "low" },
      },
      {
        timestamp: "2026-07-08T10:02:00Z",
        session_id: "ccc333dismissed",
        cwd: "/x/repo-c",
        critique_id: "c3",
        brain_output: { bubble_short: "dismissed one", severity: "low" },
      },
      {
        timestamp: "2026-07-08T10:03:00Z",
        session_id: "ddd444",
        cwd: "/x/repo-d",
        skipped: "muted",
      },
    ],
    [
      { session_id: "bbb222", timestamp: ackedTs, action: "ack", at: "2026-07-08T10:05:00Z" },
      {
        session_id: "ccc333dismissed",
        timestamp: "2026-07-08T10:02:00Z",
        action: "dismiss",
        at: "2026-07-08T10:05:00Z",
      },
    ],
  );
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(1);
  expect(out[0]!.comment).toBe("pending one");
  expect(out[0]!.repo).toBe("repo-a");
  expect(out[0]!.branch).toBe("feat/x");
  expect(out[0]!.session).toBe("aaa");
  expect(out[0]!.severity).toBe("high");
  expect(out[0]!.critiqueId).toBe("c1");
});

test("caps at 8, newest first", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    timestamp: `2026-07-08T10:${String(i).padStart(2, "0")}:00Z`,
    session_id: `s${i}`,
    cwd: "/x/r",
    critique_id: `c${i}`,
    brain_output: { bubble_short: `msg ${i}`, severity: "low" },
  }));
  const out = await collectPendingReviews(seed(rows), OPTS);
  expect(out.length).toBe(8);
  expect(out[0]!.comment).toBe("msg 9");
});

test("branch=null on guard-rejected rows does not crash isPending", async () => {
  const home = seed([
    {
      timestamp: "2026-07-08T10:00:00Z",
      session_id: "eee555",
      cwd: "/x/repo-e",
      critique_id: "c5",
      brain_output: { bubble_short: "no branch here", severity: "medium" },
      // no branch field at all — parseBranch() defaults to null
    },
  ]);
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(1);
  expect(out[0]!.branch).toBeNull();
});

test("no brain-calls.jsonl file at all returns empty, does not throw", async () => {
  const home = mkdtempSync(join(tmpdir(), "mb-"));
  const out = await collectPendingReviews(home, OPTS);
  expect(out).toEqual([]);
});

test("malformed critic-actions.jsonl line is tolerated; valid lines still apply", async () => {
  const ts = "2026-07-08T10:00:00Z";
  const home = seed([
    {
      timestamp: ts,
      session_id: "fff666",
      cwd: "/x/repo-f",
      critique_id: "c6",
      brain_output: { bubble_short: "should be acked", severity: "low" },
    },
  ]);
  // One malformed JSON line, one valid ack line for the same row.
  seedActionsRaw(
    home,
    `not valid json at all\n${JSON.stringify({ session_id: "fff666", timestamp: ts, action: "ack", at: "2026-07-08T10:05:00Z" })}\n`,
  );
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(0);
});

test("a cleared action reopens a previously acked/dismissed row as pending", async () => {
  const ts = "2026-07-08T10:00:00Z";
  const home = seed(
    [
      {
        timestamp: ts,
        session_id: "ggg777",
        cwd: "/x/repo-g",
        critique_id: "c7",
        brain_output: { bubble_short: "reopened", severity: "medium" },
      },
    ],
    [
      { session_id: "ggg777", timestamp: ts, action: "dismiss", at: "2026-07-08T10:01:00Z" },
      { session_id: "ggg777", timestamp: ts, action: "clear", at: "2026-07-08T10:02:00Z" },
    ],
  );
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(1);
  expect(out[0]!.comment).toBe("reopened");
});

test("FIX1: a comment with critique_id=null (passive bubble / evidence-guard-rejected) is excluded even though the comment is non-empty", async () => {
  const home = seed([
    {
      timestamp: "2026-07-08T10:00:00Z",
      session_id: "iii999",
      cwd: "/x/repo-i",
      critique_id: null,
      brain_output: { bubble_short: "never forwarded", severity: "low" },
    },
    {
      timestamp: "2026-07-08T10:01:00Z",
      session_id: "jjj000",
      cwd: "/x/repo-j",
      critique_id: "c9",
      brain_output: { bubble_short: "forwarded", severity: "low" },
    },
  ]);
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(1);
  expect(out[0]!.comment).toBe("forwarded");
});

test("FIX2: CLI-dismissed row (per-project critique-status file) is excluded even though no dashboard user_action is logged", async () => {
  const home = mkdtempSync(join(tmpdir(), "mb-"));
  const projectCwd = mkdtempSync(join(tmpdir(), "mb-proj-"));
  writeFileSync(
    join(home, "brain-calls.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-08T10:00:00Z",
      session_id: "kkk111",
      cwd: projectCwd,
      critique_id: "c-dismissed",
      brain_output: { bubble_short: "cli dismissed this", severity: "low" },
    })}\n`,
  );
  const archiveDir = join(projectCwd, ".siltpoke", "critiques", "archive", "2026-07-08");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    join(archiveDir, "c-dismissed.md"),
    [
      "---",
      "schemaVersion: 1",
      "timestamp: 2026-07-08T10:00:00Z",
      "critique_id: c-dismissed",
      "session_id: kkk111",
      "status: dismissed",
      "---",
      "",
      "# [SILTPOKE CRITIQUE]",
      "",
      "body",
      "",
    ].join("\n"),
  );
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(0);
});

test("FIX2: per-project critique-status 'pending' (or missing status file) still surfaces the row", async () => {
  const home = mkdtempSync(join(tmpdir(), "mb-"));
  const projectCwd = mkdtempSync(join(tmpdir(), "mb-proj-"));
  writeFileSync(
    join(home, "brain-calls.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-08T10:00:00Z",
      session_id: "lll222",
      cwd: projectCwd,
      critique_id: "c-pending",
      brain_output: { bubble_short: "still pending", severity: "low" },
    })}\n`,
  );
  const archiveDir = join(projectCwd, ".siltpoke", "critiques", "archive", "2026-07-08");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    join(archiveDir, "c-pending.md"),
    [
      "---",
      "schemaVersion: 1",
      "timestamp: 2026-07-08T10:00:00Z",
      "critique_id: c-pending",
      "session_id: lll222",
      "status: pending",
      "---",
      "",
      "# [SILTPOKE CRITIQUE]",
      "",
      "body",
      "",
    ].join("\n"),
  );
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(1);
  expect(out[0]!.comment).toBe("still pending");
});

test("critique_for_claude takes precedence over bubble_short when both present", async () => {
  const home = seed([
    {
      timestamp: "2026-07-08T10:00:00Z",
      session_id: "hhh888",
      cwd: "/x/repo-h",
      critique_id: "c8",
      brain_output: {
        bubble_short: "short bubble",
        critique_for_claude: "full critique text",
        severity: "low",
      },
    },
  ]);
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(1);
  expect(out[0]!.comment).toBe("full critique text");
});

test("one card per session — only the newest pending review from each session", async () => {
  // Same session fires 3 turns; a second session fires once. Expect 2 cards
  // (newest per session), not 4.
  const home = seed([
    { timestamp: "2026-07-08T10:00:00Z", session_id: "sess-a", cwd: "/x/r", critique_id: "a1", brain_output: { bubble_short: "a oldest", severity: "low" } },
    { timestamp: "2026-07-08T10:05:00Z", session_id: "sess-a", cwd: "/x/r", critique_id: "a2", brain_output: { bubble_short: "a middle", severity: "low" } },
    { timestamp: "2026-07-08T10:07:00Z", session_id: "sess-b", cwd: "/x/r", critique_id: "b1", brain_output: { bubble_short: "b only", severity: "low" } },
    { timestamp: "2026-07-08T10:10:00Z", session_id: "sess-a", cwd: "/x/r", critique_id: "a3", brain_output: { bubble_short: "a newest", severity: "low" } },
  ]);
  const out = await collectPendingReviews(home, OPTS);
  expect(out.length).toBe(2);
  // newest-first across sessions: sess-a newest (10:10) then sess-b (10:07)
  expect(out.map((r) => r.comment)).toEqual(["a newest", "b only"]);
});

test("freshness window drops sessions whose newest pending review is too old", async () => {
  const now = Date.parse("2026-07-08T12:00:00Z");
  const home = seed([
    // 10 min old → within a 30-min window
    { timestamp: "2026-07-08T11:50:00Z", session_id: "fresh", cwd: "/x/r", critique_id: "f1", brain_output: { bubble_short: "recent", severity: "low" } },
    // 2 h old → outside a 30-min window
    { timestamp: "2026-07-08T10:00:00Z", session_id: "stale", cwd: "/x/r", critique_id: "s1", brain_output: { bubble_short: "old", severity: "low" } },
  ]);
  const out = await collectPendingReviews(home, { nowMs: now, freshnessMs: 30 * 60 * 1000 });
  expect(out.length).toBe(1);
  expect(out[0]!.comment).toBe("recent");
});
