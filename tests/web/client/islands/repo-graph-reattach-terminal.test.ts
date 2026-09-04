/**
 * Reattach-after-reload must reach a terminal the user can leave.
 *
 * pollVerdict (tests/web/islands/repo-graph-poll-verdict.test.ts) pins the
 * DECISION; this file pins the WIRING — that the decision actually reaches the
 * screen. Without it the verdict could be perfect and nothing would call it,
 * which is the same shape as the bug: correct-looking code no one runs.
 *
 * The scenario: reload while a repo is indexing → maybeReattachIndexing raises
 * the "Indexing …" overlay and polls /repos → the build then fails server-side,
 * which `rm -rf`s the repo's storage dir, so it VANISHES from /repos. Before
 * this change, the poll's `state === "ready"` check stayed false forever, it
 * gave up silently after 40 ticks, and the overlay covered the canvas until a
 * page reload.
 *
 * These tests wait on the REAL 3s interval rather than faking timers, because
 * the thing under test is the interval callback's behaviour. That makes the
 * file slow (~4s/test) and that is the honest cost of testing it at all.
 *
 * Run: bun test tests/web/client/islands/repo-graph-reattach-terminal.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installFetchMock, jsonResponse, mountRepoGraph, registerDom, unregisterDom } from "./_dom-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

const FIXTURE_HASH = "f1x7ur3hash0";

/** Factory, never a shared constant — a Response body is consumable ONCE. */
function reposPayload(repos: unknown[]): Response {
  return jsonResponse({ data: { repos } });
}

const indexingRepo = {
  id: FIXTURE_HASH,
  name: "fixture-repo",
  path: "/tmp/island-harness-fixture-repo",
  state: "indexing",
  files: 0,
  symbols: 0,
  edges: 0,
};

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Wait past one real 3s poll interval (plus slack for the fetch + render). */
function waitOnePoll(): Promise<void> {
  return new Promise((r) => setTimeout(r, 3600));
}

describe("reattach lands on a dismissible terminal when the repo vanishes", () => {
  test("repo disappears from /repos mid-poll → failure terminal with a way out", async () => {
    let calls = 0;
    installFetchMock([
      [
        "/api/repo-graph/repos",
        () => {
          calls += 1;
          // First read: the boot-time reattach sees it indexing. After that the
          // build has failed and removeRepoIndex has deleted the storage dir,
          // so the listing no longer contains it at all.
          return Promise.resolve(reposPayload(calls <= 1 ? [indexingRepo] : []));
        },
      ],
    ]);

    const root = await mountRepoGraph();
    await tick();
    await tick();

    const empty = root.querySelector<HTMLElement>("#rg-repo-empty");
    const world = root.querySelector<HTMLElement>("#rg-world");
    if (!empty || !world) throw new Error("fixture missing #rg-repo-empty / #rg-world");

    // Positive control: the reattach really did take the canvas over. If this
    // fails, the test below would be asserting against a screen the flow never
    // reached.
    expect(empty.classList.contains("show")).toBe(true);
    expect(empty.textContent ?? "").toContain("Indexing");
    expect(world.style.display).toBe("none");

    await waitOnePoll();

    // Pre-fix: still the spinner, forever — the poll had no branch for this.
    expect(empty.textContent ?? "").not.toContain("Indexing fixture-repo…");
    expect(empty.textContent ?? "").toContain("exited with an error");
    // Named, so the user knows WHICH repo died.
    expect(empty.textContent ?? "").toContain("fixture-repo");

    const dismiss = empty.querySelector<HTMLElement>("#rg-idx-dismiss");
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await tick();
    expect(empty.classList.contains("show")).toBe(false);
    expect(world.style.display).not.toBe("none");
  }, 15_000);

  test("a repo that stays indexing keeps waiting — no premature failure", async () => {
    // The negative control for the test above: absence is the failure signal,
    // so a still-present "indexing" entry must NOT trip the terminal.
    installFetchMock([
      ["/api/repo-graph/repos", () => Promise.resolve(reposPayload([indexingRepo]))],
    ]);

    const root = await mountRepoGraph();
    await tick();
    await tick();

    const empty = root.querySelector<HTMLElement>("#rg-repo-empty");
    if (!empty) throw new Error("fixture missing #rg-repo-empty");
    expect(empty.textContent ?? "").toContain("Indexing");

    await waitOnePoll();

    // Still the progress state after a full poll tick, with no terminal and no
    // dismiss button.
    expect(empty.textContent ?? "").toContain("Indexing");
    expect(empty.textContent ?? "").not.toContain("exited with an error");
    expect(empty.querySelector("#rg-idx-dismiss")).toBeNull();
  }, 15_000);
});
