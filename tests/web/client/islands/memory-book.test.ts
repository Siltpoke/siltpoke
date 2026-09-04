// Pin timezone BEFORE any imports so new Date() calls in helpers use a fixed TZ.
// Without this, tests asserting formatted times ("13:55", "04:30" etc.) are
// machine-TZ-dependent. UTC matches the UTC ISO seeds and the old-slice behaviour.
process.env.TZ = "UTC";

/**
 * Unit tests for memory-book island — pure helper functions.
 * No DOM / Alpine runtime required; the functions are exported directly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { groupByEntity } from "../../../../src/memory/entity";
import { tokens } from "../../../../src/web/tokens/tokens";
import type { FactEvent, MemoryEventClient } from "../../../../src/web/client/islands/memory-book";
import {
  buildLogRows,
  buildProposal,
  countByType,
  decorateRow,
  deriveClientSummary,
  filterMemories,
  groupByDate,
  groupLabel,
  groupMemoriesByEntity,
  makeMemoryBookData,
  segs,
  sortMemories,
  synthesizeClientEvents,
} from "../../../../src/web/client/islands/memory-book";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SEMANTIC: MemoryEventClient = {
  id: "s1",
  ts: "2026-06-01T10:00:00.000Z",
  type: "semantic",
  text: "user prefers dark mode",
  why: "mentioned it twice",
  status: "active",
};

const EPISODIC: MemoryEventClient = {
  id: "e1",
  ts: "2026-06-02T11:00:00.000Z",
  type: "episodic",
  text: "key moment: finished the refactor",
  why: null,
  status: "active",
};

const PROCEDURAL_PENDING: MemoryEventClient = {
  id: "p1",
  ts: "2026-06-03T09:00:00.000Z",
  type: "procedural",
  text: "always use bun, not npm",
  why: "preference repeated",
  status: "pending",
};

const SEMANTIC_RETIRED: MemoryEventClient = {
  id: "s2",
  ts: "2026-05-31T08:00:00.000Z",
  type: "semantic",
  text: "user liked tabs (old)",
  why: null,
  status: "retired",
};

const ALL = [SEMANTIC, EPISODIC, PROCEDURAL_PENDING, SEMANTIC_RETIRED];

// ---------------------------------------------------------------------------
// filterMemories
// ---------------------------------------------------------------------------

describe("filterMemories", () => {
  it("returns all when both filters are empty", () => {
    expect(filterMemories(ALL, "", "")).toHaveLength(4);
  });

  it("filters by type: semantic", () => {
    const result = filterMemories(ALL, "semantic", "");
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.type === "semantic")).toBe(true);
  });

  it("filters by type: episodic", () => {
    const result = filterMemories(ALL, "episodic", "");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("e1");
  });

  it("filters by status: pending", () => {
    const result = filterMemories(ALL, "", "pending");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("p1");
  });

  it("filters by status: active", () => {
    const result = filterMemories(ALL, "", "active");
    expect(result).toHaveLength(2);
    expect(result.every((m) => m.status === "active")).toBe(true);
  });

  it("combines type + status filters", () => {
    const result = filterMemories(ALL, "semantic", "retired");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s2");
  });

  it("returns 0 items when type matches nothing", () => {
    const result = filterMemories(ALL, "procedural", "active");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(filterMemories([], "semantic", "")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sortMemories
// ---------------------------------------------------------------------------

describe("sortMemories", () => {
  it("sorts newest-first (desc=true)", () => {
    const result = sortMemories(ALL, true);
    const timestamps = result.map((m) => m.ts);
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(timestamps[i] >= timestamps[i + 1]).toBe(true);
    }
  });

  it("sorts oldest-first (desc=false)", () => {
    const result = sortMemories(ALL, false);
    const timestamps = result.map((m) => m.ts);
    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(timestamps[i] <= timestamps[i + 1]).toBe(true);
    }
  });

  it("does NOT mutate the input array", () => {
    const input = [...ALL];
    const original = input.map((m) => m.id).join(",");
    sortMemories(input, true);
    expect(input.map((m) => m.id).join(",")).toBe(original);
  });

  it("handles empty array", () => {
    expect(sortMemories([], true)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// countByType
// ---------------------------------------------------------------------------

describe("countByType", () => {
  it("counts semantic correctly", () => {
    expect(countByType(ALL, "semantic")).toBe(2);
  });

  it("counts episodic correctly", () => {
    expect(countByType(ALL, "episodic")).toBe(1);
  });

  it("counts procedural correctly", () => {
    expect(countByType(ALL, "procedural")).toBe(1);
  });

  it("returns 0 for empty array", () => {
    expect(countByType([], "semantic")).toBe(0);
  });

  it("returns 0 when type not present", () => {
    const onlySemantic = [SEMANTIC, SEMANTIC_RETIRED];
    expect(countByType(onlySemantic, "procedural")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// makeMemoryBookData — default values
// ---------------------------------------------------------------------------

describe("makeMemoryBookData defaults", () => {
  it("view defaults to timeline", () => {
    const data = makeMemoryBookData();
    expect(data.view).toBe("timeline");
  });

  it("filterType defaults to empty string", () => {
    const data = makeMemoryBookData();
    expect(data.filterType).toBe("");
  });

  it("filterStatus defaults to empty string", () => {
    const data = makeMemoryBookData();
    expect(data.filterStatus).toBe("");
  });

  it("sortDesc defaults to true (newest-first)", () => {
    const data = makeMemoryBookData();
    expect(data.sortDesc).toBe(true);
  });

  it("modalType defaults to empty string", () => {
    const data = makeMemoryBookData();
    expect(data.modalType).toBe("");
  });

  it("memories defaults to empty array", () => {
    const data = makeMemoryBookData();
    expect(data.memories).toEqual([]);
  });

  it("TYPE_COLORS has all three types", () => {
    const data = makeMemoryBookData();
    expect(data.TYPE_COLORS.semantic).toBeTruthy();
    expect(data.TYPE_COLORS.episodic).toBeTruthy();
    expect(data.TYPE_COLORS.procedural).toBeTruthy();
  });

  it("STATUS_COLORS has all three statuses", () => {
    const data = makeMemoryBookData();
    expect(data.STATUS_COLORS.active).toBeTruthy();
    expect(data.STATUS_COLORS.pending).toBeTruthy();
    expect(data.STATUS_COLORS.retired).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// makeMemoryBookData — method behavior
// ---------------------------------------------------------------------------

describe("makeMemoryBookData methods", () => {
  it("filteredMemories returns all when no filters", () => {
    const data = makeMemoryBookData();
    data.memories = [...ALL];
    expect(data.filteredMemories()).toHaveLength(4);
  });

  it("filteredMemories applies filterType", () => {
    const data = makeMemoryBookData();
    data.memories = [...ALL];
    data.filterType = "episodic";
    expect(data.filteredMemories()).toHaveLength(1);
  });

  it("memoriesForModal returns empty when modalType is empty", () => {
    const data = makeMemoryBookData();
    data.memories = [...ALL];
    data.modalType = "";
    expect(data.memoriesForModal()).toHaveLength(0);
  });

  it("memoriesForModal returns empty when modalType is working", () => {
    const data = makeMemoryBookData();
    data.memories = [...ALL];
    data.modalType = "working";
    expect(data.memoriesForModal()).toHaveLength(0);
  });

  it("memoriesForModal filters by type AND active-only when open", () => {
    const data = makeMemoryBookData();
    data.memories = [...ALL];
    data.modalType = "semantic";
    // ALL has 2 semantic facts (1 active + 1 retired); the drill-down modal
    // shows active only — retired stays reachable via the timeline status chip.
    expect(data.memoriesForModal()).toHaveLength(1);
    expect(data.memoriesForModal().every((m) => m.status === "active")).toBe(true);
  });

  it("emptyMessage returns procedural hint when filterType=procedural", () => {
    const data = makeMemoryBookData();
    data.filterType = "procedural";
    expect(data.emptyMessage()).toContain("notice you repeat");
  });

  it("emptyMessage returns semantic hint when filterType=semantic", () => {
    const data = makeMemoryBookData();
    data.filterType = "semantic";
    expect(data.emptyMessage()).toContain("0 facts");
  });

  it("emptyMessage returns episodic hint when filterType=episodic", () => {
    const data = makeMemoryBookData();
    data.filterType = "episodic";
    expect(data.emptyMessage()).toContain("0 episodes");
  });

  it("emptyMessage returns 'no memories yet' when store is empty and no filter", () => {
    const data = makeMemoryBookData();
    // Default: memories=[], filterType=""
    expect(data.emptyMessage()).toBe("no memories yet");
  });

  it("emptyMessage returns 'no memories match these filters' when store has items but all filtered out", () => {
    const data = makeMemoryBookData();
    data.memories = [SEMANTIC]; // store has items
    data.filterStatus = "retired"; // semantic is active → 0 matches
    expect(data.emptyMessage()).toBe("no memories match these filters");
  });

  it("toggleSort flips sortDesc", () => {
    const data = makeMemoryBookData();
    expect(data.sortDesc).toBe(true);
    data.toggleSort();
    expect(data.sortDesc).toBe(false);
    data.toggleSort();
    expect(data.sortDesc).toBe(true);
  });

  it("setView changes view", () => {
    const data = makeMemoryBookData();
    data.setView("byType");
    expect(data.view).toBe("byType");
    data.setView("timeline");
    expect(data.view).toBe("timeline");
  });

  it("openModal and closeModal manage modalType", () => {
    const data = makeMemoryBookData();
    data.openModal("semantic");
    expect(data.modalType).toBe("semantic");
    data.closeModal();
    expect(data.modalType).toBe("");
  });

  it("modalTypeLabel returns correct label for each type", () => {
    const data = makeMemoryBookData();
    data.openModal("semantic");
    expect(data.modalTypeLabel()).toBe("Semantic");
    data.openModal("episodic");
    expect(data.modalTypeLabel()).toBe("Episodic");
    data.openModal("procedural");
    expect(data.modalTypeLabel()).toBe("Procedural");
    // Set modalType directly (not via openModal) — openModal("working") fires
    // the lazy recap fetch as a side effect, which would need a fetch
    // stub here; this test only exercises the label mapping.
    data.modalType = "working";
    expect(data.modalTypeLabel()).toBe("Working");
  });
});

// ---------------------------------------------------------------------------
// openModal("working") lazily fetches per-chat recaps and patches
// recentChats by id (POST /api/chat/recap-recent).
//
// Two concerns, tested separately (one job per test):
//   (a) _fetchRecaps() — the async worker: awaited DIRECTLY so the patch /
//       fail-open assertions are deterministic (no timer/tick counting).
//   (b) openModal("working") — the sync wiring: fire-and-forget. fetch() is
//       issued synchronously inside _fetchRecaps BEFORE its first await, so a
//       call-count assertion needs no flush; the pending promise settles with
//       the mocked Response and touches the network no further.
// ---------------------------------------------------------------------------

describe("lazy cross-chat recap (_fetchRecaps + openModal wiring)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const seededChats = () => [
    { id: "s1", summary: "我在看什么页面?", started_at: "t1", message_count: 2 },
    { id: "s2", summary: "另一段对话", started_at: "t2", message_count: 4 },
  ];

  it("_fetchRecaps POSTs to /api/chat/recap-recent with the displayed ids and patches the matching entry by id, leaving others untouched", async () => {
    let calledUrl = "";
    let calledMethod = "";
    let calledBody = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calledUrl = url;
      calledMethod = init?.method ?? "";
      calledBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({ recapped: [{ id: "s1", summary: "recap!" }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.recentChats = seededChats();
    await data._fetchRecaps();
    expect(calledUrl).toBe("/api/chat/recap-recent");
    expect(calledMethod).toBe("POST");
    // The body scopes the recap to exactly the chats this panel is showing, so
    // the server recaps what the user sees (not an independently-picked set).
    expect(JSON.parse(calledBody)).toEqual({
      ids: data.recentChats.map((c) => c.id),
    });
    expect(data.recentChats.find((c) => c.id === "s1")?.summary).toBe("recap!");
    // Untouched entry (not present in `recapped`) keeps its placeholder.
    expect(data.recentChats.find((c) => c.id === "s2")?.summary).toBe("另一段对话");
  });

  it("_fetchRecaps fail-open: non-ok response resolves without throwing, recentChats unchanged", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.recentChats = seededChats();
    await expect(data._fetchRecaps()).resolves.toBeUndefined();
    expect(data.recentChats).toEqual(seededChats());
  });

  it("_fetchRecaps fail-open: a thrown fetch error resolves without throwing, recentChats unchanged", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.recentChats = seededChats();
    await expect(data._fetchRecaps()).resolves.toBeUndefined();
    expect(data.recentChats).toEqual(seededChats());
  });

  it("openModal('working') fires the recap fetch exactly once (fetch issued synchronously)", () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ recapped: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.recentChats = seededChats();
    data.openModal("working");
    expect(fetchCount).toBe(1);
  });

  it("openModal does NOT fetch for a non-working modal type", () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(JSON.stringify({ recapped: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.recentChats = seededChats();
    data.openModal("semantic");
    expect(fetched).toBe(false);
  });

  it("double-fire guard: a second openModal('working') (even after close) does not re-fetch", () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ recapped: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.recentChats = seededChats();
    data.openModal("working");
    data.closeModal();
    data.openModal("working");
    expect(fetchCount).toBe(1);
  });

  it("openModal('working') never throws even when the recap fetch rejects (fail-open at the wiring seam)", () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.recentChats = seededChats();
    expect(() => data.openModal("working")).not.toThrow();
    expect(data.modalType).toBe("working");
  });
});

// ---------------------------------------------------------------------------
// segs — backtick split
// ---------------------------------------------------------------------------

describe("segs", () => {
  it("returns a single text seg when no backticks", () => {
    const r = segs("plain text");
    expect(r).toEqual([{ t: "plain text", isCode: false }]);
  });

  it("splits inline code on backticks", () => {
    const r = segs("用 `Bun` 不用 Express");
    expect(r).toEqual([
      { t: "用 ", isCode: false },
      { t: "Bun", isCode: true },
      { t: " 不用 Express", isCode: false },
    ]);
  });

  it("handles two code spans", () => {
    const r = segs("`Bun` + `Hono`");
    expect(r).toEqual([
      { t: "Bun", isCode: true },
      { t: " + ", isCode: false },
      { t: "Hono", isCode: true },
    ]);
  });

  it("drops empty segments", () => {
    expect(segs("`code`")).toEqual([{ t: "code", isCode: true }]);
  });
});

// ---------------------------------------------------------------------------
// groupByDate — deterministic with todayKey
// ---------------------------------------------------------------------------

describe("groupByDate", () => {
  const today: MemoryEventClient = {
    id: "t1",
    ts: "2026-06-25T09:00:00.000Z",
    type: "semantic",
    text: "today fact",
    why: null,
    status: "active",
  };
  const yesterday: MemoryEventClient = {
    id: "y1",
    ts: "2026-06-24T15:00:00.000Z",
    type: "episodic",
    text: "yesterday thing",
    why: null,
    status: "active",
  };
  const older: MemoryEventClient = {
    id: "o1",
    ts: "2026-06-20T11:00:00.000Z",
    type: "semantic",
    text: "older fact",
    why: null,
    status: "active",
  };

  it("groups consecutive same-date items together", () => {
    const groups = groupByDate([today, yesterday, older], "2026-06-25");
    expect(groups).toHaveLength(3);
    expect(groups[0].items).toHaveLength(1);
  });

  it("labels today / yesterday relative to todayKey", () => {
    const groups = groupByDate([today, yesterday, older], "2026-06-25");
    expect(groups[0].label).toBe("Today");
    expect(groups[1].label).toBe("Yesterday");
    expect(groups[2].label).toBe("Jun 20");
  });

  it("is deterministic — same todayKey yields same labels regardless of clock", () => {
    expect(groupLabel("2026-06-25", "2026-06-25")).toBe("Today");
    expect(groupLabel("2026-06-24", "2026-06-25")).toBe("Yesterday");
  });

  it("returns empty array for empty input", () => {
    expect(groupByDate([], "2026-06-25")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// decorateRow — display projection
// ---------------------------------------------------------------------------

describe("decorateRow", () => {
  it("maps type + status to Chinese labels", () => {
    const d = decorateRow({
      id: "x",
      ts: "2026-06-24T13:55:00.000Z",
      type: "semantic",
      text: "用 `Bun`",
      why: "reason",
      status: "pending",
    });
    expect(d.typeLabel).toBe("Semantic");
    expect(d.statusLabel).toBe("Pending");
    expect(d.time).toBe("13:55");
    expect(d.dateLabel).toBe("6/24");
    expect(d.segs).toEqual([
      { t: "用 ", isCode: false },
      { t: "Bun", isCode: true },
    ]);
  });

  it("uses muted card background for retired rows", () => {
    const active = decorateRow({
      id: "a",
      ts: "2026-06-24T13:55:00.000Z",
      type: "semantic",
      text: "t",
      why: null,
      status: "active",
    });
    const retired = decorateRow({ ...active, status: "retired" });
    expect(active.cardBg).toBe(tokens.color.memCardBg);
    expect(retired.cardBg).toBe(tokens.color.memCardBgRetired);
  });

  it("uses episodic purple", () => {
    const d = decorateRow({
      id: "e",
      ts: "2026-06-24T13:55:00.000Z",
      type: "episodic",
      text: "t",
      why: null,
      status: "active",
    });
    expect(d.typeColor).toBe(tokens.color.violet);
  });

  it("surfaces reaffirmCount from recall_count (and defaults to 0 when absent)", () => {
    const reaffirmed = decorateRow({
      id: "r",
      ts: "2026-06-24T13:55:00.000Z",
      type: "semantic",
      text: "t",
      why: null,
      status: "active",
      recall_count: 3,
    });
    expect(reaffirmed.reaffirmCount).toBe(3);

    const noField = decorateRow({
      id: "n",
      ts: "2026-06-24T13:55:00.000Z",
      type: "semantic",
      text: "t",
      why: null,
      status: "active",
    });
    expect(noField.reaffirmCount).toBe(0);
  });

  it("formats reaffirmAt from last_confirmed_at (and is '' when null/absent)", () => {
    const reaffirmed = decorateRow({
      id: "r",
      ts: "2026-06-24T13:55:00.000Z",
      type: "semantic",
      text: "t",
      why: null,
      status: "active",
      recall_count: 2,
      last_confirmed_at: "2026-06-22T09:00:00.000Z",
    });
    expect(reaffirmed.reaffirmCount).toBe(2);
    // Reuses the same date helper as dateLabel → "M/D".
    expect(reaffirmed.reaffirmAt).toBe("6/22");

    const nullDate = decorateRow({
      id: "nd",
      ts: "2026-06-24T13:55:00.000Z",
      type: "semantic",
      text: "t",
      why: null,
      status: "active",
      recall_count: 1,
      last_confirmed_at: null,
    });
    expect(nullDate.reaffirmAt).toBe("");

    const absent = decorateRow({
      id: "ab",
      ts: "2026-06-24T13:55:00.000Z",
      type: "semantic",
      text: "t",
      why: null,
      status: "active",
    });
    expect(absent.reaffirmAt).toBe("");
  });

  it("sets streamBadge from stream field: known streams get label+color, null stream gets no badge, unknown stream gets no badge", () => {
    const userRow = decorateRow({ id: "u", ts: "2026-06-24T00:00:00.000Z", type: "semantic", text: "t", why: null, status: "active", stream: "user" });
    expect(userRow.streamBadge).toBe("✍️ you typed");
    expect(userRow.streamBadgeColor).toBe(tokens.color.violet);

    const commitRow = decorateRow({ id: "c", ts: "2026-06-24T00:00:00.000Z", type: "semantic", text: "t", why: null, status: "active", stream: "commit" });
    expect(commitRow.streamBadge).toBe("🤖 from commits");
    expect(commitRow.streamBadgeColor).toBe(tokens.color.moss);

    const nullRow = decorateRow({ id: "n", ts: "2026-06-24T00:00:00.000Z", type: "semantic", text: "t", why: null, status: "active", stream: null });
    expect(nullRow.streamBadge).toBeNull();
    expect(nullRow.streamBadgeColor).toBe("");

    // Unknown future stream — should silently suppress badge (no crash)
    const unknownRow = decorateRow({ id: "x", ts: "2026-06-24T00:00:00.000Z", type: "semantic", text: "t", why: null, status: "active", stream: "api" as string });
    expect(unknownRow.streamBadge).toBeNull();
    expect(unknownRow.streamBadgeColor).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildProposal — deterministic matcher (NO LLM)
// ---------------------------------------------------------------------------

describe("buildProposal", () => {
  const facts: MemoryEventClient[] = [
    {
      id: "f-dark",
      ts: "2026-06-25T10:00:00.000Z",
      type: "semantic",
      text: "User prefers dark mode",
      why: null,
      status: "active",
    },
    {
      id: "f-bun",
      ts: "2026-06-25T11:00:00.000Z",
      type: "semantic",
      text: "这个 repo 用 Bun + Hono",
      why: null,
      status: "active",
    },
  ];

  it("forget intent + single match → actionable with factId", () => {
    const p = buildProposal("忘掉 dark mode", facts);
    expect(p.actionable).toBe(true);
    expect(p.factId).toBe("f-dark");
    expect(p.verb).toBe("retire");
    expect(p.target).toBe("User prefers dark mode");
  });

  it("matches English 'forget' too", () => {
    const p = buildProposal("forget the Bun thing", facts);
    expect(p.actionable).toBe(true);
    expect(p.factId).toBe("f-bun");
  });

  it("forget intent but no matching fact → non-actionable", () => {
    const p = buildProposal("忘掉 那条 GraphQL 的事", facts);
    expect(p.actionable).toBe(false);
    expect(p.factId).toBeUndefined();
  });

  it("non-forget arbitrary NL → non-actionable", () => {
    const p = buildProposal("把提交偏好改成中文", facts);
    expect(p.actionable).toBe(false);
  });

  it("ambiguous forget (matches >1 fact) → non-actionable", () => {
    const p = buildProposal("忘掉 Bun", [
      facts[1], // "这个 repo 用 Bun + Hono"
      { ...facts[1], text: "也用 Bun 跑测试", id: "f-other" },
    ]);
    expect(p.actionable).toBe(false);
  });

  it("never matches an already-retired fact", () => {
    const retired = [{ ...facts[0], status: "retired" as const }];
    const p = buildProposal("忘掉 dark mode", retired);
    expect(p.actionable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// retireFact / confirmProposal — real soft-delete wiring (mocked fetch)
// ---------------------------------------------------------------------------

describe("retireFact + confirmProposal", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const seed: MemoryEventClient = {
    id: "f-dark",
    ts: "2026-06-25T10:00:00.000Z",
    type: "semantic",
    text: "User prefers dark mode",
    why: null,
    status: "active",
  };

  it("retireFact flips status to retired on 200 (soft delete — row stays)", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    await data.retireFact("f-dark");
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].status).toBe("retired");
  });

  it("retireFact leaves the row unchanged on non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    await data.retireFact("f-dark");
    expect(data.memories[0].status).toBe("active");
  });

  it("retireFact returns true on success and false on failure", async () => {
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    expect(await data.retireFact("f-dark")).toBe(true);
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await data.retireFact("f-dark")).toBe(false);
  });

  it("confirmProposal performs the retire for an actionable proposal", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    data.proposal = buildProposal("忘掉 dark mode", data.memories);
    await data.confirmProposal();
    expect(data.memories[0].status).toBe("retired");
    expect(data.proposal).toBeNull();
  });

  it("confirmProposal keeps the proposal (for retry) and does NOT retire on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    data.proposal = buildProposal("忘掉 dark mode", data.memories);
    await data.confirmProposal();
    // Row unchanged, proposal preserved so the same ✓确认 can be retried.
    expect(data.memories[0].status).toBe("active");
    expect(data.proposal).not.toBeNull();
    expect(data.proposal?.actionable).toBe(true);
  });

  it("sendChat builds a proposal and clears the input", () => {
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    data.chat = "忘掉 dark mode";
    data.sendChat();
    expect(data.proposal?.actionable).toBe(true);
    expect(data.chat).toBe("");
  });

  it("cancelProposal clears the proposal without mutating", () => {
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    data.proposal = buildProposal("忘掉 dark mode", data.memories);
    data.cancelProposal();
    expect(data.proposal).toBeNull();
    expect(data.memories[0].status).toBe("active");
  });

  it("reactivateFact flips a retired row back to active on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed, status: "retired" }];
    await data.reactivateFact("f-dark");
    expect(data.memories[0].status).toBe("active");
  });

  it("reactivateFact leaves the row retired on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed, status: "retired" }];
    await data.reactivateFact("f-dark");
    expect(data.memories[0].status).toBe("retired");
  });
});

// ---------------------------------------------------------------------------
// approveFact / rejectFact — pending-row actions (mocked fetch)
// ---------------------------------------------------------------------------

describe("approveFact + rejectFact (pending-row actions)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const pending: MemoryEventClient = {
    id: "f-pend",
    ts: "2026-06-25T10:00:00.000Z",
    type: "semantic",
    text: "user might prefer teal",
    why: "mentioned once",
    status: "pending",
  };

  it("approveFact POSTs to /approve and flips pending → active on 200", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...pending }];
    await data.approveFact("f-pend");
    expect(calledUrl).toBe("/api/facts/f-pend/approve");
    expect(data.memories[0].status).toBe("active");
    expect(data.toast).toContain("Confirmed");
  });

  it("approveFact leaves the row pending + honest toast on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...pending }];
    await data.approveFact("f-pend");
    expect(data.memories[0].status).toBe("pending");
    expect(data.toast).toContain("Something went wrong");
  });

  it("rejectFact POSTs to /retire and flips pending → retired on 200", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...pending }];
    await data.rejectFact("f-pend");
    expect(calledUrl).toBe("/api/facts/f-pend/retire");
    expect(data.memories[0].status).toBe("retired");
    expect(data.toast).toContain("Rejected");
  });

  it("rejectFact leaves the row pending + honest toast on failure", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...pending }];
    await data.rejectFact("f-pend");
    expect(calledUrl).toBe("/api/facts/f-pend/retire");
    expect(data.memories[0].status).toBe("pending");
    expect(data.toast).toContain("Something went wrong");
  });
});

// ---------------------------------------------------------------------------
// deleteFact — active-row soft-retire (delegates to retireFact, delete toast)
// ---------------------------------------------------------------------------

describe("deleteFact (active-row action)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const active: MemoryEventClient = {
    id: "f-active",
    ts: "2026-06-25T10:00:00.000Z",
    type: "semantic",
    text: "User enjoys weekend kayaking",
    why: null,
    status: "active",
  };

  it("soft-retires an active fact + 已删除 toast on 200 (row stays)", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...active }];
    await data.deleteFact("f-active");
    expect(calledUrl).toBe("/api/facts/f-active/retire");
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].status).toBe("retired");
    expect(data.toast).toContain("Deleted");
  });

  it("leaves the row active + honest toast on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...active }];
    await data.deleteFact("f-active");
    expect(data.memories[0].status).toBe("active");
    expect(data.toast).toContain("Something went wrong");
  });
});

// ---------------------------------------------------------------------------
// sendChat routing (forget fast-path vs /parse) + confirm methods
// ---------------------------------------------------------------------------

describe("sendChat routing", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const seed: MemoryEventClient = {
    id: "f-dark",
    ts: "2026-06-25T10:00:00.000Z",
    type: "semantic",
    text: "User prefers dark mode",
    why: null,
    status: "active",
  };

  it("routes 忘掉-X to the deterministic path (NO fetch)", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    data.chat = "忘掉 dark mode";
    await data.sendChat();
    expect(fetched).toBe(false);
    expect(data.proposal?.actionable).toBe(true);
    expect(data.proposal?.classification).toBeUndefined();
    expect(data.chat).toBe("");
  });

  it("routes other text to /api/facts/parse and stores a classified proposal", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response(
        JSON.stringify({
          candidate: "User prefers teal",
          classification: "add",
          confidence: 0.9,
          targetFactId: null,
          contradictedFact: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.chat = "记得我喜欢青色";
    await data.sendChat();
    expect(calledUrl).toBe("/api/facts/parse");
    expect(data.proposal?.classification).toBe("add");
    expect(data.proposal?.candidate).toBe("User prefers teal");
    expect(data.parsing).toBe(false);
  });

  it("contradict proposal carries the contradicted fact text + target id", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          candidate: "User prefers teal",
          classification: "contradict",
          confidence: 0.8,
          targetFactId: "f-blue",
          contradictedFact: { id: "f-blue", text: "User prefers blue" },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.chat = "其实我喜欢青色";
    await data.sendChat();
    expect(data.proposal?.classification).toBe("contradict");
    expect(data.proposal?.targetFactId).toBe("f-blue");
    expect(data.proposal?.contradictedText).toBe("User prefers blue");
  });

  it("paused parse → honest 已暂停 toast, no proposal", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ paused: true, reason: "quiet_hours" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.chat = "记一条";
    await data.sendChat();
    expect(data.proposal).toBeNull();
    expect(data.toast).toContain("Paused");
  });

  it("parse failure → honest toast, no proposal", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 502 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.chat = "记一条";
    await data.sendChat();
    expect(data.proposal).toBeNull();
    expect(data.toast).toContain("try again");
  });

  it("double-submit guard: returns early (no fetch, no proposal) while parsing", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.parsing = true; // a parse call is already in flight
    data.chat = "记一条新的"; // non-forget text → would normally hit /parse
    await data.sendChat();
    expect(fetched).toBe(false);
    expect(data.proposal).toBeNull();
  });

  it("normal /parse path sets parsing true during flight, then back to false", async () => {
    const data = makeMemoryBookData();
    let duringFlight: boolean | undefined;
    globalThis.fetch = (async () => {
      duringFlight = data.parsing; // observed mid-await
      return new Response(
        JSON.stringify({
          candidate: "User prefers teal",
          classification: "add",
          confidence: 0.9,
          targetFactId: null,
          contradictedFact: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    data.chat = "记一条";
    expect(data.parsing).toBe(false); // before
    await data.sendChat();
    expect(duringFlight).toBe(true); // during
    expect(data.parsing).toBe(false); // after (finally reset)
  });
});

describe("confirm methods (mocked fetch)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function newFactResponse(id: string, text: string) {
    return new Response(
      JSON.stringify({
        fact: {
          id,
          text,
          created_at: "2026-06-25T12:00:00.000Z",
          save_reason: null,
        },
      }),
      { status: 201 },
    );
  }

  it("confirmAdd POSTs to /api/facts, appends a pending row, clears proposal", async () => {
    let calledUrl = "";
    let body = "";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      body = init.body as string;
      return newFactResponse("f-new", "User prefers teal");
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.proposal = {
      actionable: true,
      detail: "User prefers teal",
      classification: "add",
      candidate: "User prefers teal",
      confidence: 0.9,
    };
    await data.confirmAdd();
    expect(calledUrl).toBe("/api/facts");
    expect(JSON.parse(body)).toEqual({ text: "User prefers teal", confidence: 0.9 });
    expect(data.memories).toHaveLength(1);
    expect(data.memories[0].id).toBe("f-new");
    expect(data.memories[0].status).toBe("pending");
    expect(data.proposal).toBeNull();
    expect(data.toast).toContain("Saved");
  });

  it("confirmAdd sends the user's original text as save_reason (manual-add provenance)", async () => {
    let body = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return newFactResponse("f-new", "User prefers teal");
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.proposal = {
      actionable: true,
      detail: "User prefers teal",
      classification: "add",
      candidate: "User prefers teal",
      confidence: 0.9,
      sourceText: "记得我喜欢青色",
    };
    await data.confirmAdd();
    expect(JSON.parse(body).save_reason).toBe("You added manually: 记得我喜欢青色");
  });

  it("confirmAdd keeps proposal + honest toast on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.proposal = {
      actionable: true,
      detail: "x",
      classification: "add",
      candidate: "x",
      confidence: 0.9,
    };
    await data.confirmAdd();
    expect(data.memories).toHaveLength(0);
    expect(data.proposal).not.toBeNull();
    expect(data.toast).toContain("Something went wrong");
  });

  it("confirmRestate POSTs to /restate and flips the target to active", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response(
        JSON.stringify({
          fact: {
            id: "f-teal",
            recall_count: 2,
            last_confirmed_at: "2026-06-26T09:00:00.000Z",
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [
      {
        id: "f-teal",
        ts: "2026-06-25T10:00:00.000Z",
        type: "semantic",
        text: "User prefers teal",
        why: null,
        status: "pending",
      },
    ];
    data.proposal = {
      actionable: true,
      detail: "x",
      classification: "restate",
      candidate: "User likes teal",
      targetFactId: "f-teal",
    };
    await data.confirmRestate("f-teal");
    expect(calledUrl).toBe("/api/facts/f-teal/restate");
    expect(data.memories[0].status).toBe("active");
    // live badge advances from the returned fact (no reload needed)
    expect(data.memories[0].recall_count).toBe(2);
    expect(data.memories[0].last_confirmed_at).toBe("2026-06-26T09:00:00.000Z");
    expect(data.proposal).toBeNull();
    expect(data.toast).toContain("Reaffirmed");
  });

  it("confirmRestate leaves the row + honest toast on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [
      {
        id: "f-teal",
        ts: "2026-06-25T10:00:00.000Z",
        type: "semantic",
        text: "User prefers teal",
        why: null,
        status: "pending",
      },
    ];
    await data.confirmRestate("f-teal");
    expect(data.memories[0].status).toBe("pending");
    expect(data.toast).toContain("Something went wrong");
  });

  it("confirmReplace POSTs with supersedes and appends a pending row", async () => {
    let body = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return newFactResponse("f-new", "User prefers teal");
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [
      {
        id: "f-blue",
        ts: "2026-06-25T09:00:00.000Z",
        type: "semantic",
        text: "User prefers blue",
        why: null,
        status: "active",
      },
    ];
    data.proposal = {
      actionable: true,
      detail: "x",
      classification: "contradict",
      candidate: "User prefers teal",
      confidence: 0.85,
      targetFactId: "f-blue",
      contradictedText: "User prefers blue",
    };
    await data.confirmReplace("f-blue");
    expect(JSON.parse(body)).toEqual({
      text: "User prefers teal",
      confidence: 0.85,
      supersedes: "f-blue",
    });
    expect(data.memories.some((m) => m.id === "f-new" && m.status === "pending")).toBe(true);
    expect(data.proposal).toBeNull();
    expect(data.toast).toContain("Replacement");
  });

  it("keepBoth POSTs WITHOUT supersedes and appends a pending row", async () => {
    let body = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = init.body as string;
      return newFactResponse("f-new", "User prefers teal");
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.proposal = {
      actionable: true,
      detail: "x",
      classification: "contradict",
      candidate: "User prefers teal",
      confidence: 0.85,
      targetFactId: "f-blue",
      contradictedText: "User prefers blue",
    };
    await data.keepBoth();
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.supersedes).toBeUndefined();
    expect(parsed.text).toBe("User prefers teal");
    expect(data.memories.some((m) => m.id === "f-new")).toBe(true);
    expect(data.proposal).toBeNull();
    expect(data.toast).toContain("Keeping both");
  });

  it("confirmReplace keeps proposal + honest toast on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.proposal = {
      actionable: true,
      detail: "x",
      classification: "contradict",
      candidate: "User prefers teal",
      targetFactId: "f-blue",
    };
    await data.confirmReplace("f-blue");
    expect(data.memories).toHaveLength(0);
    expect(data.proposal).not.toBeNull();
    expect(data.toast).toContain("Something went wrong");
  });
});

// ---------------------------------------------------------------------------
// decorateRow — action-log fields (events / summary / logRows / expanded)
// ---------------------------------------------------------------------------

const baseRow: MemoryEventClient = {
  id: "r1",
  ts: "2026-06-24T13:55:00.000Z",
  type: "semantic",
  text: "test fact",
  why: null,
  status: "active",
};

describe("decorateRow — action-log fields", () => {
  it("exposes events[] synthesized for active fact with no stored events", () => {
    const row = decorateRow(baseRow);
    expect(Array.isArray(row.events)).toBe(true);
    // synthesizeLegacy: active + no events → [created, approved]
    expect(row.events.length).toBe(2);
    expect(row.events[0].action).toBe("created");
    expect(row.events[1].action).toBe("approved");
  });

  it("exposes summary with createdAt and zero reaffirmCount for a fresh active fact", () => {
    const row = decorateRow(baseRow);
    expect(row.summary.createdAt).toBe(baseRow.ts);
    expect(row.summary.reaffirmCount).toBe(0);
    expect(row.summary.lastReaffirmAt).toBeNull();
    expect(row.summary.latestStateChange?.action).toBe("approved");
  });

  it("exposes logRows array for expanded rail", () => {
    const row = decorateRow(baseRow);
    expect(Array.isArray(row.logRows)).toBe(true);
    expect(row.logRows.length).toBeGreaterThan(0);
  });

  it("expanded defaults to false", () => {
    const row = decorateRow(baseRow);
    expect(row.expanded).toBe(false);
  });

  it("uses stored events (non-empty) as-is, not synthetic fallback", () => {
    const withEvents: MemoryEventClient = {
      ...baseRow,
      events: [
        { action: "created", at: "2026-06-01T00:00:00.000Z", reason: null },
        { action: "approved", at: "2026-06-02T00:00:00.000Z", reason: null },
        { action: "reaffirmed", at: "2026-06-10T00:00:00.000Z", reason: null },
        { action: "reaffirmed", at: "2026-06-15T00:00:00.000Z", reason: null },
      ],
    };
    const row = decorateRow(withEvents);
    expect(row.events).toHaveLength(4);
    expect(row.summary.reaffirmCount).toBe(2);
    expect(row.summary.lastReaffirmAt).toBe("2026-06-15T00:00:00.000Z");
  });

  it("pending fact with no events synthesizes only [created] — no approved", () => {
    const pending: MemoryEventClient = {
      ...baseRow,
      status: "pending",
    };
    const row = decorateRow(pending);
    expect(row.events.length).toBe(1);
    expect(row.events[0].action).toBe("created");
    expect(row.summary.latestStateChange).toBeNull();
  });

  it("summary.latestStateChange is null for a create-only event list", () => {
    const createOnly: MemoryEventClient = {
      ...baseRow,
      status: "pending",
      events: [{ action: "created", at: "2026-06-01T00:00:00.000Z", reason: null }],
    };
    const row = decorateRow(createOnly);
    expect(row.summary.latestStateChange).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildLogRows — newest-first, no created, per-event reaffirms
// ---------------------------------------------------------------------------

describe("buildLogRows — newest-first, no created, per-event reaffirms", () => {
  it("excludes 'created' events entirely", () => {
    const rows = buildLogRows([
      { action: "created", at: "2026-06-01T00:00:00.000Z", reason: null },
      { action: "approved", at: "2026-06-02T00:00:00.000Z", reason: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("approved");
  });

  it("orders newest→oldest", () => {
    const rows = buildLogRows([
      { action: "created", at: "2026-06-01T00:00:00.000Z", reason: null },
      { action: "approved", at: "2026-06-02T00:00:00.000Z", reason: null },
      { action: "reaffirmed", at: "2026-06-10T00:00:00.000Z", reason: null },
      { action: "reaffirmed", at: "2026-06-15T00:00:00.000Z", reason: null },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0].action).toBe("reaffirmed");
    expect(rows[0].dateLabel).toBe("2026-06-15 00:00");
    expect(rows[1].action).toBe("reaffirmed");
    expect(rows[1].dateLabel).toBe("2026-06-10 00:00");
    expect(rows[2].action).toBe("approved");
  });

  it("each reaffirm event is its own individual row with date+time (not folded)", () => {
    const rows = buildLogRows([
      { action: "created", at: "2026-06-01T00:00:00.000Z", reason: null },
      { action: "reaffirmed", at: "2026-06-10T00:00:00.000Z", reason: null },
      { action: "reaffirmed", at: "2026-06-15T00:00:00.000Z", reason: null },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ action: "reaffirmed", dateLabel: "2026-06-15 00:00" });
    expect(rows[1]).toEqual({ action: "reaffirmed", dateLabel: "2026-06-10 00:00" });
  });

  it("dateLabel includes date+time in 'YYYY-MM-DD HH:mm' format", () => {
    const rows = buildLogRows([
      { action: "approved", at: "2026-06-02T14:35:00.000Z", reason: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].dateLabel).toBe("2026-06-02 14:35");
  });

  it("empty events list returns empty rows", () => {
    expect(buildLogRows([])).toEqual([]);
  });

  it("only-created fact returns empty rows (toggle should be hidden)", () => {
    const rows = buildLogRows([
      { action: "created", at: "2026-06-01T00:00:00.000Z", reason: null },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("legacy reaffirm: legacyReaffirmCount > 0 + no reaffirm events → synthetic ×N row", () => {
    const rows = buildLogRows(
      [{ action: "created", at: "2026-06-01T00:00:00.000Z", reason: null }],
      3,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("reaffirmed");
    expect(rows[0].dateLabel).toBe("×3");
  });

  it("legacy reaffirm: suppressed when per-event reaffirm timestamps exist", () => {
    const rows = buildLogRows(
      [
        { action: "created", at: "2026-06-01T00:00:00.000Z", reason: null },
        { action: "reaffirmed", at: "2026-06-10T00:00:00.000Z", reason: null },
      ],
      5, // legacyReaffirmCount should be ignored
    );
    // Only one real reaffirm row, no extra ×5 synthetic row.
    expect(rows.filter((r) => r.action === "reaffirmed")).toHaveLength(1);
    expect(rows.find((r) => r.dateLabel === "×5")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// decorateRow — supersedesText / supersededByText resolution
// ---------------------------------------------------------------------------

describe("decorateRow — supersedesText / supersededByText", () => {
  const SUPERSEDED: MemoryEventClient = {
    id: "f-old",
    ts: "2026-06-20T10:00:00.000Z",
    type: "semantic",
    text: "User prefers Windows for gaming",
    why: null,
    status: "retired",
    superseded_by: "f-new",
  };
  const SUPERSEDING: MemoryEventClient = {
    id: "f-new",
    ts: "2026-06-21T10:00:00.000Z",
    type: "semantic",
    text: "User prefers macOS for development",
    why: "Changed preference",
    status: "active",
    supersedes: "f-old",
  };
  const ALL_PAIR = [SUPERSEDED, SUPERSEDING];

  it("resolves supersedesText to partner text when all list provided", () => {
    const row = decorateRow(SUPERSEDING, ALL_PAIR);
    expect(row.supersedesText).toBe("User prefers Windows for gaming");
  });

  it("supersededByText is null on superseding fact (no superseded_by)", () => {
    const row = decorateRow(SUPERSEDING, ALL_PAIR);
    expect(row.supersededByText).toBeNull();
  });

  it("resolves supersededByText to partner text when all list provided", () => {
    const row = decorateRow(SUPERSEDED, ALL_PAIR);
    expect(row.supersededByText).toBe("User prefers macOS for development");
  });

  it("supersedesText is null on superseded fact (no supersedes pointer)", () => {
    const row = decorateRow(SUPERSEDED, ALL_PAIR);
    expect(row.supersedesText).toBeNull();
  });

  it("both texts are null for a plain fact with no supersede links", () => {
    const plain: MemoryEventClient = {
      id: "f-plain",
      ts: "2026-06-22T10:00:00.000Z",
      type: "semantic",
      text: "User prefers dark mode",
      why: null,
      status: "active",
    };
    const row = decorateRow(plain, ALL_PAIR);
    expect(row.supersedesText).toBeNull();
    expect(row.supersededByText).toBeNull();
  });

  it("returns null (no throw) when supersedes id is missing from all list", () => {
    const orphan: MemoryEventClient = {
      ...SUPERSEDING,
      id: "f-orphan",
      supersedes: "f-nonexistent",
    };
    expect(() => decorateRow(orphan, ALL_PAIR)).not.toThrow();
    expect(decorateRow(orphan, ALL_PAIR).supersedesText).toBeNull();
  });

  it("returns null (no throw) when superseded_by id is missing from all list", () => {
    const orphan: MemoryEventClient = {
      ...SUPERSEDED,
      id: "f-orphan2",
      superseded_by: "f-nonexistent",
    };
    expect(() => decorateRow(orphan, ALL_PAIR)).not.toThrow();
    expect(decorateRow(orphan, ALL_PAIR).supersededByText).toBeNull();
  });

  it("returns null when no all list provided (backward compat — callers without context)", () => {
    const row = decorateRow(SUPERSEDING);
    expect(row.supersedesText).toBeNull();
    expect(row.supersededByText).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// jumpToFact — null / missing DOM guard (no browser runtime in Bun test)
// ---------------------------------------------------------------------------

describe("jumpToFact — null / missing DOM guard", () => {
  it("returns undefined (no throw) for a null id", () => {
    const data = makeMemoryBookData();
    expect(() => data.jumpToFact(null)).not.toThrow();
    expect(data.jumpToFact(null)).toBeUndefined();
  });

  it("returns undefined (no throw) when document is absent (Bun / SSR environment)", () => {
    const data = makeMemoryBookData();
    // document is undefined in Bun test → guard branch triggers; no throw.
    expect(() => data.jumpToFact("fact-e2e-superseding")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// synthesizeClientEvents — retired status synthesis
// ---------------------------------------------------------------------------

describe("synthesizeClientEvents — M1 retired status synthesis", () => {
  it("M1 empty path: retired + no events → [created, retired]", () => {
    const m: MemoryEventClient = {
      id: "r-retired",
      ts: "2026-01-01T00:00:00.000Z",
      type: "semantic",
      text: "test",
      why: null,
      status: "retired",
    };
    const evs = synthesizeClientEvents(m);
    expect(evs.map((e) => e.action)).toEqual(["created", "retired"]);
    // Client falls back to m.ts for the retired event's at timestamp.
    expect(evs[1].at).toBe("2026-01-01T00:00:00.000Z");
    expect(evs[1].reason).toBeNull();
  });

  it("M1 non-empty path: retired + events (no retired event) → trailing retired appended", () => {
    const m: MemoryEventClient = {
      id: "r-retired-events",
      ts: "2026-01-01T00:00:00.000Z",
      type: "semantic",
      text: "test",
      why: null,
      status: "retired",
      events: [
        { action: "created", at: "2026-01-01T00:00:00.000Z", reason: null },
        { action: "approved", at: "2026-01-02T00:00:00.000Z", reason: null },
      ],
    };
    const evs = synthesizeClientEvents(m);
    expect(evs.map((e) => e.action)).toEqual(["created", "approved", "retired"]);
    expect(evs[2].action).toBe("retired");
  });

  it("M1 does NOT apply when retired event is already present in events", () => {
    const m: MemoryEventClient = {
      id: "r-already-retired",
      ts: "2026-01-01T00:00:00.000Z",
      type: "semantic",
      text: "test",
      why: null,
      status: "retired",
      events: [
        { action: "created", at: "2026-01-01T00:00:00.000Z", reason: null },
        { action: "retired", at: "2026-01-15T00:00:00.000Z", reason: null },
      ],
    };
    const evs = synthesizeClientEvents(m);
    expect(evs.map((e) => e.action)).toEqual(["created", "retired"]);
    expect(evs).toHaveLength(2); // no extra synthetic event
  });

  it("M1 does not apply for pending or active status", () => {
    const pending: MemoryEventClient = {
      id: "r-pending",
      ts: "2026-01-01T00:00:00.000Z",
      type: "semantic",
      text: "test",
      why: null,
      status: "pending",
    };
    expect(synthesizeClientEvents(pending).map((e) => e.action)).toEqual(["created"]);
  });
});

// ---------------------------------------------------------------------------
// deriveClientSummary — recall_count reconciliation
// ---------------------------------------------------------------------------

describe("deriveClientSummary — M2 recall_count reconciliation", () => {
  it("M2: 0 reaffirm events + recall_count=5 → reaffirmCount=5", () => {
    const m: MemoryEventClient = {
      id: "r-legacy",
      ts: "2026-01-01T00:00:00.000Z",
      type: "semantic",
      text: "test",
      why: null,
      status: "active",
      recall_count: 5,
    };
    const evs = synthesizeClientEvents(m);
    const s = deriveClientSummary(m, evs);
    // No reaffirm events → Math.max(0, 5) = 5
    expect(s.reaffirmCount).toBe(5);
  });

  it("M2: 3 reaffirm events + recall_count=5 → reaffirmCount=5 (max wins)", () => {
    const m: MemoryEventClient = {
      id: "r-max",
      ts: "2026-01-01T00:00:00.000Z",
      type: "semantic",
      text: "test",
      why: null,
      status: "active",
      recall_count: 5,
      events: [
        { action: "created", at: "2026-01-01T00:00:00.000Z", reason: null },
        { action: "reaffirmed", at: "2026-01-05T00:00:00.000Z", reason: null },
        { action: "reaffirmed", at: "2026-01-08T00:00:00.000Z", reason: null },
        { action: "reaffirmed", at: "2026-01-12T00:00:00.000Z", reason: null },
      ],
    };
    const s = deriveClientSummary(m, m.events!);
    // 3 events < 5 recall_count → Math.max(3, 5) = 5
    expect(s.reaffirmCount).toBe(5);
  });

  it("M2: recall_count=0, 2 reaffirm events → reaffirmCount=2 (events win)", () => {
    const m: MemoryEventClient = {
      id: "r-eventswin",
      ts: "2026-01-01T00:00:00.000Z",
      type: "semantic",
      text: "test",
      why: null,
      status: "active",
      recall_count: 0,
      events: [
        { action: "created", at: "2026-01-01T00:00:00.000Z", reason: null },
        { action: "reaffirmed", at: "2026-01-05T00:00:00.000Z", reason: null },
        { action: "reaffirmed", at: "2026-01-10T00:00:00.000Z", reason: null },
      ],
    };
    const s = deriveClientSummary(m, m.events!);
    // Math.max(2, 0) = 2
    expect(s.reaffirmCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Live action-log — mutation handlers update m.events so the rail re-renders
// without a page reload. Each handler: (a) uses server-returned events when
// present in the JSON response, (b) falls back to optimistic append when the
// body is absent or malformed.
// ---------------------------------------------------------------------------

describe("live action-log — mutation handlers append events", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const activeBase: MemoryEventClient = {
    id: "f1",
    ts: "2026-06-25T10:00:00.000Z",
    type: "semantic",
    text: "User prefers dark mode",
    why: null,
    status: "active",
  };

  // Helper: wrap a fact payload in the standard `{ fact: … }` envelope.
  function factBody(events: FactEvent[]) {
    return JSON.stringify({ fact: { events } });
  }

  it("retireFact uses server-returned events array on 200 with JSON body", async () => {
    const serverEvs: FactEvent[] = [
      { action: "created", at: "2026-06-25T10:00:00.000Z", reason: null },
      { action: "retired", at: "2026-06-25T12:00:00.000Z", reason: "user_rejected" },
    ];
    globalThis.fetch = (async () =>
      new Response(factBody(serverEvs), { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...activeBase }];
    await data.retireFact("f1");
    const m = data.memories[0];
    // Status and events both updated from server response
    expect(m.status).toBe("retired");
    expect(m.events).toEqual(serverEvs);
  });

  it("retireFact falls back to optimistic append when response body is null", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [
      {
        ...activeBase,
        events: [{ action: "created", at: "2026-06-25T10:00:00.000Z", reason: null }],
      },
    ];
    await data.retireFact("f1");
    const m = data.memories[0];
    expect(m.status).toBe("retired");
    // Original event preserved + new "retired" event appended
    expect(m.events?.some((e) => e.action === "created")).toBe(true);
    expect(m.events?.some((e) => e.action === "retired")).toBe(true);
  });

  it("approveFact uses server-returned events array on 200 with JSON body", async () => {
    const serverEvs: FactEvent[] = [
      { action: "created", at: "2026-06-25T10:00:00.000Z", reason: null },
      { action: "approved", at: "2026-06-25T12:00:00.000Z", reason: null },
    ];
    globalThis.fetch = (async () =>
      new Response(factBody(serverEvs), { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...activeBase, status: "pending" }];
    await data.approveFact("f1");
    const m = data.memories[0];
    expect(m.status).toBe("active");
    expect(m.events).toEqual(serverEvs);
  });

  it("approveFact falls back to optimistic append when response body is null", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [
      {
        ...activeBase,
        status: "pending",
        events: [{ action: "created", at: "2026-06-25T10:00:00.000Z", reason: null }],
      },
    ];
    await data.approveFact("f1");
    const m = data.memories[0];
    expect(m.status).toBe("active");
    expect(m.events?.some((e) => e.action === "approved")).toBe(true);
  });

  it("reactivateFact uses server-returned events array on 200 with JSON body", async () => {
    const serverEvs: FactEvent[] = [
      { action: "retired", at: "2026-06-25T10:00:00.000Z", reason: "user_rejected" },
      { action: "reactivated", at: "2026-06-25T12:00:00.000Z", reason: null },
    ];
    globalThis.fetch = (async () =>
      new Response(factBody(serverEvs), { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...activeBase, status: "retired" }];
    await data.reactivateFact("f1");
    const m = data.memories[0];
    expect(m.status).toBe("active");
    expect(m.events).toEqual(serverEvs);
  });

  it("reactivateFact falls back to optimistic append when response body is null", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [
      {
        ...activeBase,
        status: "retired",
        events: [
          { action: "created", at: "2026-06-25T10:00:00.000Z", reason: null },
          { action: "retired", at: "2026-06-25T11:00:00.000Z", reason: "user_rejected" },
        ],
      },
    ];
    await data.reactivateFact("f1");
    const m = data.memories[0];
    expect(m.status).toBe("active");
    expect(m.events?.some((e) => e.action === "reactivated")).toBe(true);
  });

  it("rejectFact (delegates to retireFact) also updates events", async () => {
    const serverEvs: FactEvent[] = [
      { action: "created", at: "2026-06-25T10:00:00.000Z", reason: null },
      { action: "retired", at: "2026-06-25T12:00:00.000Z", reason: "user_rejected" },
    ];
    globalThis.fetch = (async () =>
      new Response(factBody(serverEvs), { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...activeBase, status: "pending" }];
    await data.rejectFact("f1");
    const m = data.memories[0];
    expect(m.status).toBe("retired");
    expect(m.events?.some((e) => e.action === "retired")).toBe(true);
  });

  it("deleteFact (delegates to retireFact) also updates events", async () => {
    const serverEvs: FactEvent[] = [
      { action: "created", at: "2026-06-25T10:00:00.000Z", reason: null },
      { action: "retired", at: "2026-06-25T12:00:00.000Z", reason: "user_rejected" },
    ];
    globalThis.fetch = (async () =>
      new Response(factBody(serverEvs), { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...activeBase }];
    await data.deleteFact("f1");
    const m = data.memories[0];
    expect(m.status).toBe("retired");
    expect(m.events?.some((e) => e.action === "retired")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// kind badge + re-tag
// ---------------------------------------------------------------------------

describe("decorateRow — kind badge", () => {
  const base = {
    id: "f",
    ts: "2026-06-24T13:55:00.000Z",
    text: "t",
    why: null,
    status: "active" as const,
  };
  it("style fact → 🎯 style badge", () => {
    const d = decorateRow({ ...base, type: "semantic", kind: "style" });
    expect(d.kindBadge).toContain("style");
    expect(d.kindBadgeColor).not.toBe("");
  });
  it("profile fact → profile badge", () => {
    const d = decorateRow({ ...base, type: "semantic", kind: "profile" });
    expect(d.kindBadge).toContain("profile");
  });
  it("untagged (null kind) fact → ❓ untagged badge", () => {
    const d = decorateRow({ ...base, type: "semantic", kind: null });
    expect(d.kindBadge).toContain("untagged");
  });
  it("non-fact (episodic) row → NO kind badge", () => {
    const d = decorateRow({ ...base, type: "episodic" });
    expect(d.kindBadge).toBeNull();
    expect(d.kindBadgeColor).toBe("");
  });
});

describe("setFactKind / cycleFactKind (re-tag)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  const seed: MemoryEventClient = {
    id: "f-1",
    ts: "2026-06-25T10:00:00.000Z",
    type: "semantic",
    text: "prefers concise answers",
    why: null,
    status: "active",
    kind: "style",
  };

  it("flips kind on 200 (optimistic update gated on success)", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    await data.setFactKind("f-1", "profile");
    expect(data.memories[0].kind).toBe("profile");
  });

  it("leaves kind unchanged on non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    await data.setFactKind("f-1", "profile");
    expect(data.memories[0].kind).toBe("style");
  });

  it("cycleFactKind picks the next kind: style→profile, profile→style, untagged→style", async () => {
    const posted: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      posted.push((JSON.parse(init.body as string) as { kind: string }).kind);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.cycleFactKind({ id: "a", kind: "style" });
    data.cycleFactKind({ id: "a", kind: "profile" });
    data.cycleFactKind({ id: "a", kind: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual(["profile", "style", "style"]);
  });
});

describe("setPinned (pin/unpin toggle)", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  const seed: MemoryEventClient = {
    id: "f-1",
    ts: "2026-06-25T10:00:00.000Z",
    type: "semantic",
    text: "prefers concise answers",
    why: null,
    status: "active",
    pinned: false,
  };

  it("flips pinned on 200 (gated on success, mirrors setFactKind)", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 200 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    await data.setPinned("f-1", true);
    expect(data.memories[0].pinned).toBe(true);
  });

  it("leaves pinned unchanged on non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    await data.setPinned("f-1", true);
    expect(data.memories[0].pinned).toBe(false);
  });

  it("leaves pinned unchanged when fetch throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    await data.setPinned("f-1", true);
    expect(data.memories[0].pinned).toBe(false);
  });

  it("posts the correct endpoint + body for both pin and unpin", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const data = makeMemoryBookData();
    data.memories = [{ ...seed }];
    await data.setPinned("f-1", true);
    await data.setPinned("f-1", false);
    expect(calls[0].url).toBe("/api/facts/f-1/pin");
    expect(JSON.parse(calls[0].body)).toEqual({ pinned: true });
    expect(calls[1].url).toBe("/api/facts/f-1/pin");
    expect(JSON.parse(calls[1].body)).toEqual({ pinned: false });
  });
});

// ---------------------------------------------------------------------------
// byEntityGroups — the "by entity" view reuses src/memory/entity.ts'
// groupByEntity (single-sourced) rather than reimplementing the grouping.
// ---------------------------------------------------------------------------

describe("island reuses groupByEntity for the by-entity view", () => {
  const alex1: MemoryEventClient = {
    id: "f1",
    ts: "2026-06-01T10:00:00.000Z",
    type: "semantic",
    text: "partner Alex",
    why: null,
    status: "active",
    entities: [{ name: "Alex" }],
  };
  const alex2: MemoryEventClient = {
    id: "f2",
    ts: "2026-06-02T10:00:00.000Z",
    type: "semantic",
    text: "Alex likes hiking",
    why: null,
    status: "active",
    entities: [{ name: "alex" }],
  };
  const untagged: MemoryEventClient = {
    id: "f3",
    ts: "2026-06-03T10:00:00.000Z",
    type: "semantic",
    text: "no entity here",
    why: null,
    status: "active",
  };

  it("groupMemoriesByEntity matches the keys/labels groupByEntity itself produces", () => {
    const facts = [alex1, alex2, untagged];
    const raw = groupByEntity(facts);
    const decorated = groupMemoriesByEntity(facts);
    expect(decorated.map((g) => g.key)).toEqual(raw.map((g) => g.key));
    expect(decorated.map((g) => g.label)).toEqual(raw.map((g) => g.label));
    expect(decorated[0]?.label).toBe("Alex");
    expect(decorated[decorated.length - 1]?.label).toBe("未分类");
  });

  it("decorates each grouped fact for MemoryAlpineRow (carries event.id/time)", () => {
    const groups = groupMemoriesByEntity([alex1, alex2]);
    const alexGroup = groups.find((g) => g.key === "alex");
    expect(alexGroup?.items.map((i) => i.id)).toEqual(["f1", "f2"]);
    expect(alexGroup?.items[0]?.time).toBeDefined();
  });

  it("makeMemoryBookData().byEntityGroups() delegates to the shared helper", () => {
    const data = makeMemoryBookData();
    data.memories = [alex1, alex2, untagged];
    const groups = data.byEntityGroups();
    expect(groups.find((g) => g.key === "alex")?.items).toHaveLength(2);
    expect(groups[groups.length - 1]).toMatchObject({ key: "", label: "未分类" });
  });

  it("byEntityGroups respects the active filter set (filteredMemories), like groups()", () => {
    const data = makeMemoryBookData();
    data.memories = [alex1, alex2, untagged];
    data.filterStatus = "retired"; // none of the fixtures are retired
    expect(data.byEntityGroups()).toHaveLength(0);
  });
});
