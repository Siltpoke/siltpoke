import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMessage } from "../../src/chat/jsonl-store";
import {
  openIndex,
  insertMessage,
  indexedIdsForSession,
  search,
  type ChatIndex,
} from "../../src/chat/fts5-index";
import { recoverIndex } from "../../src/chat/recovery";
import type { ChatMessage } from "../../src/chat/schema";

let home: string;
let idx: ChatIndex;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-rec-"));
  idx = openIndex(home);
});

afterEach(() => {
  idx.close();
  rmSync(home, { recursive: true, force: true });
});

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "id" | "session_id" | "content">): ChatMessage {
  return {
    role: "user",
    ts: "2026-05-16T00:00:00Z",
    model: null,
    tokens: null,
    fts_skip: false,
    claude_session_id: null,
    ...over,
  };
}

test("empty home: stats all zero", async () => {
  const stats = await recoverIndex(home, idx);
  expect(stats.sessions_scanned).toBe(0);
  expect(stats.messages_total).toBe(0);
  expect(stats.messages_replayed).toBe(0);
  expect(stats.desync_ratio).toBe(0);
});

test("empty home AND empty index is normal, not an anomaly", async () => {
  // Pins the `rowsBefore > 0` half of the anomaly gate. Zero sessions is only
  // suspicious when the index has rows to lose; a fresh install has neither, and
  // must not report a skipped prune or emit the SKIPPED warning on every boot.
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  let stats: Awaited<ReturnType<typeof recoverIndex>>;
  try {
    stats = await recoverIndex(home, idx);
  } finally {
    console.warn = originalWarn;
  }
  expect(stats.orphan_prune_skipped).toBe(null);
  expect(logs.some((l) => l.includes("SKIPPED"))).toBe(false);
});

test("fully-synced index: nothing replayed", async () => {
  const m1 = msg({ id: "m-1", session_id: "s-1", content: "hello" });
  await appendMessage(home, "s-1", m1);
  insertMessage(idx, m1);
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_already_indexed).toBe(1);
  expect(stats.messages_replayed).toBe(0);
  expect(stats.desync_ratio).toBe(0);
});

test("missing message gets replayed into FTS", async () => {
  const m1 = msg({ id: "m-1", session_id: "s-1", content: "in jsonl only" });
  await appendMessage(home, "s-1", m1);
  const before = indexedIdsForSession(idx, "s-1");
  expect(before.size).toBe(0);
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_replayed).toBe(1);
  const after = indexedIdsForSession(idx, "s-1");
  expect(after.has("m-1")).toBe(true);
});

test("partial sync: only gaps replayed", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
  const b = msg({ id: "m-b", session_id: "s-1", content: "bravo" });
  const c = msg({ id: "m-c", session_id: "s-1", content: "charlie" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-1", b);
  await appendMessage(home, "s-1", c);
  insertMessage(idx, a);
  insertMessage(idx, c);
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_already_indexed).toBe(2);
  expect(stats.messages_replayed).toBe(1);
});

test("fts_skip messages are NOT replayed and counted separately", async () => {
  const noisy = msg({
    id: "m-noisy",
    session_id: "s-1",
    content: "tool_use blob",
    fts_skip: true,
  });
  await appendMessage(home, "s-1", noisy);
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_skip_flagged).toBe(1);
  expect(stats.messages_replayed).toBe(0);
  expect(indexedIdsForSession(idx, "s-1").size).toBe(0);
});

test("desync_ratio excludes fts_skip from denominator", async () => {
  await appendMessage(
    home,
    "s-1",
    msg({ id: "m-1", session_id: "s-1", content: "a" }),
  );
  await appendMessage(
    home,
    "s-1",
    msg({
      id: "m-skip",
      session_id: "s-1",
      content: "noise",
      fts_skip: true,
    }),
  );
  const stats = await recoverIndex(home, idx);
  expect(stats.messages_skip_flagged).toBe(1);
  expect(stats.desync_ratio).toBe(1.0);
});

test("desync above 5% emits warn (gate trigger)", async () => {
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await appendMessage(
      home,
      "s-1",
      msg({ id: "m-1", session_id: "s-1", content: "uno" }),
    );
    await recoverIndex(home, idx);
  } finally {
    console.warn = originalWarn;
  }
  const warned = logs.find((l) => l.includes("fallback gate"));
  expect(warned).toBeDefined();
});

test("multi-session recovery", async () => {
  await appendMessage(
    home,
    "s-a",
    msg({ id: "m-1", session_id: "s-a", content: "aaa" }),
  );
  await appendMessage(
    home,
    "s-b",
    msg({ id: "m-2", session_id: "s-b", content: "bbb" }),
  );
  const stats = await recoverIndex(home, idx);
  expect(stats.sessions_scanned).toBe(2);
  expect(stats.messages_replayed).toBe(2);
  const matches = search(idx, "aaa");
  expect(matches).toHaveLength(1);
});

// ── orphan direction (2026-07-21) ────────────────────────────────────────────
// recoverIndex only ever walked sessions that still EXIST, replaying gaps into
// FTS. Index rows whose session JSONL is gone were never looked at, so they
// accumulated silently while desync_ratio kept reporting healthy — and search
// could still surface content from deleted sessions. Measured on the live
// index: 67 of 225 rows (29.8%) pointed at 33 deleted sessions.

test("orphan rows: index entries whose session JSONL is gone are counted", async () => {
  const live = msg({ id: "m-1", session_id: "s-live", content: "still here" });
  await appendMessage(home, "s-live", live);
  insertMessage(idx, live);
  // never written to JSONL — simulates a session whose file was deleted
  insertMessage(idx, msg({ id: "m-2", session_id: "s-gone", content: "deleted secret" }));

  // pass 1 records the candidate, deletes nothing
  const first = await recoverIndex(home, idx);
  expect(first.orphan_candidates_new).toBe(1);
  expect(first.orphan_sessions_pruned).toBe(0);
  expect(first.orphan_ratio).toBeCloseTo(0.5, 5);

  // pass 2 clears the window but not the pass minimum
  const second = await recoverIndex(home, idx, { orphanConfirmWindowMs: 0 });
  expect(second.orphan_sessions_pruned).toBe(0);
  expect(second.orphan_candidates_held).toBe(1);

  // pass 3 satisfies both conditions
  const third = await recoverIndex(home, idx, { orphanConfirmWindowMs: 0 });
  expect(third.orphan_sessions_pruned).toBe(1);
  expect(third.orphan_messages_pruned).toBe(1);
});

test("orphan rows are PRUNED — search cannot surface deleted-session content", async () => {
  // A live session MUST exist, otherwise chats/ is never created on disk and
  // listSessions returns [] — which would make this test pass for the wrong
  // reason (the anomaly gate's scenario, not a real deletion).
  const live = msg({ id: "m-1", session_id: "s-live", content: "kept" });
  await appendMessage(home, "s-live", live);
  insertMessage(idx, live);
  insertMessage(idx, msg({ id: "m-2", session_id: "s-gone", content: "deleted secret" }));
  expect(search(idx, "secret").length).toBe(1);

  await recoverIndex(home, idx); // pass 1 — records only
  await recoverIndex(home, idx, { orphanConfirmWindowMs: 0 }); // pass 2 — held
  expect(search(idx, "secret").length).toBe(1);
  const stats = await recoverIndex(home, idx, { orphanConfirmWindowMs: 0 }); // pass 3

  expect(stats.orphan_prune_skipped).toBe(null);
  expect(search(idx, "secret").length).toBe(0);
  expect(indexedIdsForSession(idx, "s-gone").size).toBe(0);
  expect(search(idx, "kept").length).toBe(1);
});

// ── the data-loss guard ──────────────────────────────────────────────────────
// listSessions FAILS OPEN: absent chats/ dir → [] with no throw. The index db
// sits beside chats/, not inside it, so "rows indexed, zero sessions visible"
// is reachable with nothing actually deleted. Pruning there wipes everything.

test("no sessions visible + non-empty index: REFUSES to prune", async () => {
  insertMessage(idx, msg({ id: "m-1", session_id: "s-1", content: "alpha" }));
  insertMessage(idx, msg({ id: "m-2", session_id: "s-2", content: "bravo" }));

  const stats = await recoverIndex(home, idx);

  expect(stats.orphan_prune_skipped).toBe("no_sessions_visible");
  expect(stats.orphan_messages_pruned).toBe(0);
  expect(stats.orphan_sessions_pruned).toBe(0);
  expect(search(idx, "alpha").length).toBe(1);
  expect(search(idx, "bravo").length).toBe(1);
});

test("sessions dir renamed away (not deleted): index survives", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "survives" });
  await appendMessage(home, "s-1", a);
  insertMessage(idx, a);
  // the sessions still exist — they are just not visible from this homeBase
  renameSync(join(home, "chats"), join(home, "chats-moved"));

  const stats = await recoverIndex(home, idx);

  expect(stats.orphan_prune_skipped).toBe("no_sessions_visible");
  expect(search(idx, "survives").length).toBe(1);
});

test("skipped prune still REPORTS the drift ratio", async () => {
  insertMessage(idx, msg({ id: "m-1", session_id: "s-1", content: "alpha" }));
  const stats = await recoverIndex(home, idx);
  expect(stats.orphan_prune_skipped).toBe("no_sessions_visible");
  expect(stats.orphan_ratio).toBe(1);
});

test("live sessions are never pruned", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha keep" });
  const b = msg({ id: "m-b", session_id: "s-2", content: "bravo keep" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-2", b);
  insertMessage(idx, a);
  insertMessage(idx, b);

  const stats = await recoverIndex(home, idx);
  expect(stats.orphan_sessions_pruned).toBe(0);
  expect(stats.orphan_messages_pruned).toBe(0);
  expect(stats.orphan_ratio).toBe(0);
  expect(search(idx, "keep").length).toBe(2);
});

test("clean index reports orphan_ratio 0, not NaN", async () => {
  const stats = await recoverIndex(home, idx);
  expect(stats.orphan_ratio).toBe(0);
});

// ── partial-listing race (2026-07-21, reviewer HIGH) ─────────────────────────
// The empty-listing gate only catches a TOTAL failure. A degraded listing —
// a restore copying sessions back one at a time, a mount mid-sync, readdir
// racing a writer — returns a strict SUBSET, so live sessions look orphaned.
// A magnitude threshold cannot separate that from a real bulk delete; absence
// across two passes can.

test("session invisible for ONE pass is never pruned", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
  const b = msg({ id: "m-b", session_id: "s-2", content: "bravo" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-2", b);
  insertMessage(idx, a);
  insertMessage(idx, b);

  // s-2 momentarily unreadable — a partial listing, s-1 still visible
  const hidden = join(home, "chats", "s-2.jsonl");
  const stash = join(home, "s-2.stash");
  renameSync(hidden, stash);
  const first = await recoverIndex(home, idx);
  expect(first.orphan_prune_skipped).toBe(null); // gate does NOT fire: s-1 visible
  expect(first.orphan_candidates_new).toBe(1);
  expect(first.orphan_sessions_pruned).toBe(0);
  expect(search(idx, "bravo").length).toBe(1); // survived

  // it comes back — the candidate must be cleared, not confirmed
  renameSync(stash, hidden);
  const second = await recoverIndex(home, idx);
  expect(second.orphan_sessions_pruned).toBe(0);
  expect(second.orphan_candidates_held).toBe(0);
  expect(search(idx, "bravo").length).toBe(1);

  // and a third pass must still not prune it
  const third = await recoverIndex(home, idx);
  expect(third.orphan_sessions_pruned).toBe(0);
  expect(search(idx, "bravo").length).toBe(1);
});

test("genuinely deleted session IS pruned once both conditions are met", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
  const b = msg({ id: "m-b", session_id: "s-2", content: "bravo" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-2", b);
  insertMessage(idx, a);
  insertMessage(idx, b);

  rmSync(join(home, "chats", "s-2.jsonl"));
  const first = await recoverIndex(home, idx);
  expect(first.orphan_sessions_pruned).toBe(0);
  const second = await recoverIndex(home, idx, { orphanConfirmWindowMs: 0 });
  expect(second.orphan_sessions_pruned).toBe(0); // pass minimum not yet met
  const third = await recoverIndex(home, idx, { orphanConfirmWindowMs: 0 });
  expect(third.orphan_sessions_pruned).toBe(1);
  expect(search(idx, "bravo").length).toBe(0);
  expect(search(idx, "alpha").length).toBe(1);
});

test("skipped prune emits no contradictory 'pruned' line", async () => {
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    insertMessage(idx, msg({ id: "m-1", session_id: "s-1", content: "alpha" }));
    await recoverIndex(home, idx);
  } finally {
    console.warn = originalWarn;
  }
  expect(logs.some((l) => l.includes("SKIPPED"))).toBe(true);
  expect(logs.some((l) => l.includes("pruned"))).toBe(false);
});

// ── time floor (2026-07-21, reviewer round-3 HIGH) ───────────────────────────
// "Seen absent twice" is NOT a safety property on its own: recoverIndex runs at
// daemon startup, so two passes can be seconds apart when launchd restarts a
// crash-looping daemon. A degradation outliving one restart would satisfy
// "absent twice" without the session having been absent for any real time.
// first_unseen_at exists to bound that; this pins that it is actually read.

test("back-to-back passes inside the confirm window do NOT prune", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
  const b = msg({ id: "m-b", session_id: "s-2", content: "bravo" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-2", b);
  insertMessage(idx, a);
  insertMessage(idx, b);
  rmSync(join(home, "chats", "s-2.jsonl"));

  const opts = { orphanConfirmWindowMs: 10 * 60_000 };
  const first = await recoverIndex(home, idx, opts);
  expect(first.orphan_candidates_new).toBe(1);
  expect(first.orphan_sessions_pruned).toBe(0);

  // second pass immediately after — the crash-restart-loop shape
  const second = await recoverIndex(home, idx, opts);
  expect(second.orphan_sessions_pruned).toBe(0);
  expect(second.orphan_candidates_held).toBe(1); // held, and NOT counted as new
  expect(search(idx, "bravo").length).toBe(1);

  // a third, still inside the window
  const third = await recoverIndex(home, idx, opts);
  expect(third.orphan_sessions_pruned).toBe(0);
  expect(search(idx, "bravo").length).toBe(1);
});

test("once the confirm window has elapsed, the prune proceeds", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
  const b = msg({ id: "m-b", session_id: "s-2", content: "bravo" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-2", b);
  insertMessage(idx, a);
  insertMessage(idx, b);
  rmSync(join(home, "chats", "s-2.jsonl"));

  await recoverIndex(home, idx, { orphanConfirmWindowMs: 10 * 60_000 });
  await recoverIndex(home, idx, { orphanConfirmWindowMs: 10 * 60_000 });
  expect(search(idx, "bravo").length).toBe(1);
  // same candidate row, but now the elapsed floor is lifted AND passes suffice
  const after = await recoverIndex(home, idx, { orphanConfirmWindowMs: 0 });
  expect(after.orphan_sessions_pruned).toBe(1);
  expect(search(idx, "bravo").length).toBe(0);
  expect(search(idx, "alpha").length).toBe(1);
});

test("pending-only pass does not claim rows were pruned", async () => {
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
    await appendMessage(home, "s-1", a);
    insertMessage(idx, a);
    insertMessage(idx, msg({ id: "m-b", session_id: "s-gone", content: "bravo" }));
    await recoverIndex(home, idx);
  } finally {
    console.warn = originalWarn;
  }
  const orphanLine = logs.find((l) => l.includes("chat-index orphans"));
  expect(orphanLine).toBeDefined();
  expect(orphanLine).toContain("0 row(s) across 0 session(s) pruned");
  expect(orphanLine).toContain("1 newly flagged, 0 still awaiting confirmation");
});

// ── real elapsed time (2026-07-21, reviewer round-4 MEDIUM) ──────────────────
// Every other floor test compares against a window parameter with ~0ms of real
// elapsed time, so a units bug (s vs ms) or a reversed subtraction would still
// pass. This one lets real time pass and pins the arithmetic itself.

test("real elapsed time is measured in ms, in the right direction", async () => {
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
  const b = msg({ id: "m-b", session_id: "s-2", content: "bravo" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-2", b);
  insertMessage(idx, a);
  insertMessage(idx, b);
  rmSync(join(home, "chats", "s-2.jsonl"));

  await recoverIndex(home, idx, { orphanConfirmWindowMs: 5_000 }); // marks
  await Bun.sleep(60);

  // 60ms really elapsed: still short of 5s → held
  const held = await recoverIndex(home, idx, { orphanConfirmWindowMs: 5_000 });
  expect(held.orphan_sessions_pruned).toBe(0);
  expect(search(idx, "bravo").length).toBe(1);

  // …but past a 25ms window → prunes. A reversed subtraction yields a negative
  // elapsed and would hold here; a seconds-vs-ms bug would read 0.06 and hold.
  const done = await recoverIndex(home, idx, { orphanConfirmWindowMs: 25 });
  expect(done.orphan_sessions_pruned).toBe(1);
  expect(search(idx, "bravo").length).toBe(0);
  expect(search(idx, "alpha").length).toBe(1);
});

test("a held candidate is reported as held, never as newly flagged", async () => {
  const originalWarn = console.warn;
  const logs: string[] = [];
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
    await appendMessage(home, "s-1", a);
    insertMessage(idx, a);
    insertMessage(idx, msg({ id: "m-b", session_id: "s-gone", content: "bravo" }));
    await recoverIndex(home, idx, { orphanConfirmWindowMs: 60_000 }); // pass 1
    logs.length = 0;
    await recoverIndex(home, idx, { orphanConfirmWindowMs: 60_000 }); // pass 2
  } finally {
    console.warn = originalWarn;
  }
  const line = logs.find((l) => l.includes("chat-index orphans"));
  expect(line).toBeDefined();
  expect(line).toContain("0 newly flagged, 1 still awaiting confirmation");
});

test("pass minimum holds a candidate whose window is ALREADY cleared", async () => {
  // The load-bearing test for MIN_ORPHAN_UNSEEN_PASSES. A forward clock jump
  // makes `elapsed` clear any window instantly (simulated here as window 0), so
  // the pass count is the ONLY thing left standing. Pass 2 must still hold —
  // if the pass-count clause is deleted, pass 2 prunes and this test fails.
  const a = msg({ id: "m-a", session_id: "s-1", content: "alpha" });
  const b = msg({ id: "m-b", session_id: "s-2", content: "bravo" });
  await appendMessage(home, "s-1", a);
  await appendMessage(home, "s-2", b);
  insertMessage(idx, a);
  insertMessage(idx, b);
  rmSync(join(home, "chats", "s-2.jsonl"));

  // window 0 throughout = "the clock jumped far enough that elapsed always clears"
  const opts = { orphanConfirmWindowMs: 0 };
  const first = await recoverIndex(home, idx, opts);
  expect(first.orphan_candidates_new).toBe(1);
  expect(first.orphan_sessions_pruned).toBe(0);

  const second = await recoverIndex(home, idx, opts);
  expect(second.orphan_sessions_pruned).toBe(0); // ← dies if the clause is removed
  expect(second.orphan_candidates_held).toBe(1);
  expect(search(idx, "bravo").length).toBe(1);

  const third = await recoverIndex(home, idx, opts);
  expect(third.orphan_sessions_pruned).toBe(1);
  expect(search(idx, "bravo").length).toBe(0);
});
