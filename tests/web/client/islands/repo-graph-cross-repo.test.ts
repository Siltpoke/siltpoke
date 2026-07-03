/** Cross-repo spinner bleed regression.
 *
 * Bug: `GET /arch/task` returns the GLOBAL latest task (registry is one-task-
 * at-a-time across ALL repos) and the page-load reconnect attached the
 * "Generating…" observer without checking the task's repo against the viewed
 * repo — so a generate running on repo-A spun the spinner on EVERY repo's
 * page, including repos that never generated.
 *
 * Contract under test (client half of the fix): reconnectArchTask must attach
 * ONLY when the running task's `repo` matches the viewed repo's hash. The
 * legitimate same-repo takeover is pinned by the pair test in
 * repo-graph-boot.test.ts; this file pins the foreign-repo NO-takeover.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildFixtureProps,
  deferred,
  installFetchMock,
  jsonResponse,
  mountRepoGraph,
  registerDom,
  unregisterDom,
} from "./_dom-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

const VIEWED_HASH = buildFixtureProps().currentProjHash; // repo-B (the page we're on)
const FOREIGN_HASH = "0th3rrep0aaa"; // repo-A (where the generate actually runs)

describe("repo-graph island — cross-repo spinner bleed (reconnect repo check)", () => {
  test("running task on repo-A does NOT take over repo-B's page", async () => {
    // Two deferreds (pair-test pattern): call #1 = the reconnect snapshot;
    // calls #2+ = observer polls, HELD PENDING so the assertion window sees the
    // genuine mid-run state. (A single shared Response would be json()'d twice
    // → body-reuse throw → poll "gone" → finishUI undoes the attach and the
    // test passes vacuously on buggy code.)
    const reconnectFetch = deferred<Response>();
    const laterPolls = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          return taskCalls === 1 ? reconnectFetch.promise : laterPolls.promise;
        },
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    const root = await mountRepoGraph(); // boot ran; reconnect suspended
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
    expect(genBtn).not.toBeNull();
    expect(genLabel).not.toBeNull();
    // Anti-vacuous guard: subset offer is live pre-resolve (fixture sanity).
    expect(genBtn?.hidden).toBe(false);
    expect(genLabel?.textContent).toBe("⚡ Generate architecture");

    // The reconnect snapshot arrives: a RUNNING arch_generate — but it belongs
    // to a DIFFERENT repo. Same shape the daemon really sends (latest() spread
    // includes `repo`).
    reconnectFetch.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-foreign-1",
            kind: "arch_generate",
            status: "running",
            repo: FOREIGN_HASH,
            startedTs: "2026-06-09T00:00:00.000Z",
            startedAgoMs: 5_000,
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0)); // drain microtasks

    // ── CHECKPOINT — foreign-repo task must NOT capture this page's button.
    // Buggy code attaches the observer right here: disabled=true + spinning
    // "Generating…" label on a repo that never generated, observer poll fired
    // (taskCalls 2). Fixed code skips the attach entirely.
    expect(genBtn?.disabled).toBe(false);
    expect(genLabel?.textContent ?? "").not.toContain("Generating");
    expect(taskCalls).toBe(1); // reconnect only — no observer poll
    // Affordance untouched — still the plain subset offer.
    expect(genLabel?.textContent).toBe("⚡ Generate architecture");

    // Teardown hygiene: settle the held deferred (harness rule — all deferreds
    // settled before unregisterDom; on fixed code nothing ever awaited it).
    laterPolls.resolve(jsonResponse({ data: { task: null } }));
    await new Promise((r) => setTimeout(r, 0));
  });

  test("fetchArchTask sends the viewed repo's hash so the server can filter", async () => {
    const taskUrls: string[] = [];
    installFetchMock([
      [
        "/arch/task",
        (url: string) => {
          taskUrls.push(url);
          return Promise.resolve(jsonResponse({ data: { task: null } }));
        },
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    await mountRepoGraph();
    await new Promise((r) => setTimeout(r, 0));

    expect(taskUrls.length).toBeGreaterThanOrEqual(1);
    expect(taskUrls[0]).toContain(`repo=${VIEWED_HASH}`);
  });
});
