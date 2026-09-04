/**
 * What the reattach poll should CONCLUDE, as a pure function.
 *
 * The dead end being closed: reload the page mid-index and
 * `maybeReattachIndexing` re-raises the "Indexing …" overlay and starts polling
 * /repos. That poll only ever acted on `state === "ready"`. If the build then
 * FAILED, the daemon called `removeRepoIndex`, which `rm -rf`s the repo's
 * storage dir — and `/repos` is a listing of exactly those dirs
 * (`enumerateRepos` reads `~/.siltpoke/repo-memory/`). So the repo does not
 * turn "failed"; it VANISHES. The poll's `find(...)?.state === "ready"` was
 * then permanently false, it gave up silently after 40 ticks, and the overlay
 * stayed over the canvas until a page reload.
 *
 * The fix needs no server change, which is worth stating because the obvious
 * reading is that `/repos` needs a failure state: disappearance IS the signal,
 * and it was simply never read. Forgetting a repo cannot be confused with it —
 * `renderRepoMenu` disables every forget button while any index is running.
 *
 * Run: bun test tests/web/islands/repo-graph-poll-verdict.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INDEX_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  pollTickBudget,
  pollVerdict,
} from "../../../src/web/client/islands/repo-graph";

const ID = "abc123def456";
const other = { id: "999999999999", name: "other", path: "/o", state: "ready" as const };

const repo = (state: "ready" | "indexing" | "none") => ({
  id: ID,
  name: "demo-repo",
  path: "/Users/v/Projects/demo-repo",
  state,
});

describe("pollVerdict", () => {
  test("still indexing → keep waiting", () => {
    expect(pollVerdict([repo("indexing"), other], ID, 1)).toBe("wait");
    expect(pollVerdict([repo("indexing"), other], ID, 39)).toBe("wait");
  });

  test("ready → done, the caller navigates", () => {
    expect(pollVerdict([repo("ready")], ID, 1)).toBe("ready");
  });

  test("VANISHED from the listing → failed", () => {
    // The whole point. A failed build removes the storage dir, so the repo is
    // absent rather than marked failed. Before this, absence read as "not ready
    // yet" forever.
    expect(pollVerdict([other], ID, 1)).toBe("gone");
  });

  test("an EMPTY listing also counts as vanished", () => {
    // The only repo was the one being indexed, and it was removed.
    expect(pollVerdict([], ID, 1)).toBe("gone");
  });

  test("vanishing outranks the tick budget — report the failure, not a timeout", () => {
    // If both conditions hold on the same tick, the specific answer wins.
    expect(pollVerdict([], ID, 999)).toBe("gone");
  });

  test("still indexing past the budget → exhausted, not silence", () => {
    // A daemon restart mid-build leaves meta.building true with no process
    // behind it: the repo stays "indexing" forever. The poll used to just stop.
    expect(pollVerdict([repo("indexing")], ID, 999_999)).toBe("exhausted");
  });

  test("state 'none' is not 'ready' and not gone — the entry still exists", () => {
    // `none` means present-but-unindexed. Distinct from absent; keep waiting
    // rather than declaring failure, until the budget runs out.
    expect(pollVerdict([repo("none")], ID, 1)).toBe("wait");
    expect(pollVerdict([repo("none")], ID, 999_999)).toBe("exhausted");
  });

  test("the budget boundary is exact, and it is a parameter not a constant", () => {
    expect(pollVerdict([repo("indexing")], ID, 10, 10)).toBe("wait");
    expect(pollVerdict([repo("indexing")], ID, 11, 10)).toBe("exhausted");
  });

  test("a ready repo past the budget still navigates — success beats the clock", () => {
    expect(pollVerdict([repo("ready")], ID, 999_999)).toBe("ready");
  });
});

describe("pollTickBudget — must outlast the daemon's own indexer timeout", () => {
  // THE regression this guards, caught in review: the first cut used a flat 40
  // ticks (~2 min) while index.timeoutMs defaults to 600_000 (10 min). A build
  // still running healthily at 3 minutes would have been declared dead. Any
  // budget at or under the daemon's cap is a false accusation, because the
  // daemon kills-and-deletes at that cap and the poll sees that as `gone`.
  test("the default budget strictly exceeds the default indexer timeout", () => {
    const budgetMs = pollTickBudget() * POLL_INTERVAL_MS;
    expect(budgetMs).toBeGreaterThan(DEFAULT_INDEX_TIMEOUT_MS);
  });

  test("the old flat 40-tick budget would NOT have passed that bar", () => {
    // Positive control: proves the assertion above discriminates, rather than
    // being satisfied by any number at all.
    expect(40 * POLL_INTERVAL_MS).toBeLessThan(DEFAULT_INDEX_TIMEOUT_MS);
  });

  test("a raised index.timeoutMs raises the budget with it", () => {
    const raised = 30 * 60_000; // 30 minutes
    expect(pollTickBudget(raised) * POLL_INTERVAL_MS).toBeGreaterThan(raised);
    expect(pollTickBudget(raised)).toBeGreaterThan(pollTickBudget());
  });

  test("a lowered index.timeoutMs lowers it too — not pinned to the default", () => {
    const lowered = 60_000; // 1 minute
    expect(pollTickBudget(lowered)).toBeLessThan(pollTickBudget());
    expect(pollTickBudget(lowered) * POLL_INTERVAL_MS).toBeGreaterThan(lowered);
  });

  test("a missing or nonsensical timeout falls back to the default, never to zero", () => {
    // A zero budget would fire `exhausted` on the very first tick.
    expect(pollTickBudget(0)).toBe(pollTickBudget(DEFAULT_INDEX_TIMEOUT_MS));
    expect(pollTickBudget(-1)).toBe(pollTickBudget(DEFAULT_INDEX_TIMEOUT_MS));
    expect(pollTickBudget(undefined)).toBe(pollTickBudget(DEFAULT_INDEX_TIMEOUT_MS));
  });
});
