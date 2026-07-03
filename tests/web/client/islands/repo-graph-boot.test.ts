/** island-harness — the harness's reason to exist.
 *
 * Regression: button-suppression. At boot, `void reconnectArchTask()`
 * (repo-graph.ts:1271) fires and suspends at its first await; boot continues
 * synchronously to render(true) → updateArchAffordance (:4345 → :1068), which
 * unhides #rg-arch-gen on the subset branch. The shipped bug pre-claimed
 * `generating = true` BEFORE the await — same affordance call early-returned,
 * button stayed hidden on every repo. tsc + 1285 tests + 4 reviewers missed it;
 * only the guided live smoke caught it. CHECKPOINT A below is that bug's
 * synchronous signature: asserted BEFORE the /arch/task fetch ever resolves.
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

// Same-repo tasks: the cross-repo fix only attaches when task.repo matches the
// viewed repo, so the legitimate-takeover mocks must carry the fixture's hash.
const REPO = buildFixtureProps().currentProjHash;

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

describe("repo-graph island boot — Generate affordance vs reconnect", () => {
  test("page-load reconnect with no running task leaves the Generate button visible", async () => {
    const archTask = deferred<Response>();
    installFetchMock([
      ["/arch/task", () => archTask.promise], // hand-resolved → order control
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
      // everything else → resolve-only default inside the mock
    ]);

    const root = await mountRepoGraph(); // boot ran; /arch/task still pending

    // Anti-vacuous guards — prove the unhide BRANCH is live, not
    // merely "not hidden": missing ids make updateArchAffordance early-return
    // (a fixture drift would otherwise pass vacuously), and the label text
    // pins archSource === "subset" non-stale.
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    const chip = root.querySelector<HTMLElement>("#rg-arch-chip");
    expect(genBtn).not.toBeNull();
    expect(chip).not.toBeNull();
    expect(root.querySelector("#rg-arch-gen-label")?.textContent).toBe(
      "⚡ Generate architecture",
    );

    // ── CHECKPOINT A — boot returned; /arch/task NOT resolved. The buggy
    // pre-claim version dies exactly here (sync signature, no flushing).
    expect(genBtn?.hidden).toBe(false);

    // Resolve: no running task (the smoke scenario that caught the bug).
    archTask.resolve(jsonResponse({ data: { task: null } }));
    // One macrotask drains ALL pending microtask continuations regardless of
    // await-chain depth (refactor-proof vs counting Promise.resolve ticks;
    // happyDOM.waitUntilComplete is blind to a test-owned fetch mock).
    await new Promise((r) => setTimeout(r, 0));

    // ── CHECKPOINT B — affordance survived the reconnect round-trip.
    expect(genBtn?.hidden).toBe(false);
  });

  /** Pair test: the OTHER side of the contract — a genuinely running task
   * at page load legitimately takes the button over (disabled + spinner label;
   * observeArchRun :1181–1191 never touches `hidden`, it disables). The poll
   * then reaches a terminal and the affordance must come back. */
  test("page-load reconnect WITH a running task legitimately takes over, then releases on terminal", async () => {
    const reconnectFetch = deferred<Response>();
    const firstPoll = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          return taskCalls === 1 ? reconnectFetch.promise : firstPoll.promise;
        },
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    const root = await mountRepoGraph();
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    expect(genBtn?.hidden).toBe(false); // pre-resolve: fix contract holds

    // A RUNNING arch_generate snapshot arrives → reconnect attaches the observer.
    reconnectFetch.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-run-1",
            kind: "arch_generate",
            status: "running",
            repo: REPO,
            startedTs: "2026-06-09T00:00:00.000Z",
            startedAgoMs: 5_000,
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    // Mid-run state: observer owns the button — button is ENABLED (cancel affordance),
    // label shows elapsed M:SS + "Cancel" (slot-swap, no "Generating" word).
    expect(genBtn?.disabled).toBe(false);
    expect(root.querySelector("#rg-arch-gen-label")?.textContent ?? "").toContain("Cancel");
    expect(taskCalls).toBe(2); // reconnect + the observer's first poll, no extras

    // Terminal arrives → finishUI clears the 1s interval (no leak), re-enables,
    // and updateArchAffordance restores the subset offer.
    firstPoll.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-run-1",
            kind: "arch_generate",
            status: "failed",
            repo: REPO,
            startedTs: "2026-06-09T00:00:00.000Z",
            startedAgoMs: 6_000,
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(genBtn?.disabled).toBe(false);
    expect(genBtn?.hidden).toBe(false);
    // CONSCIOUS FLIP (maintenance round #2, 2026-06-10): this used to pin the
    // clobbered "⚡ Generate architecture" (finishUI's terminal label was
    // overwritten by updateArchAffordance's subset branch — two writers, one
    // surface). Fixed via archTerminalError single-writer state: the error
    // label persists until the next user action (re-click / new run).
    expect(root.querySelector("#rg-arch-gen-label")?.textContent).toBe(
      "⚠ Generate failed — retry",
    );
  });

  /** Re-check-half coverage (user-pinned: 别留裸). The fixed
   * reconnectArchTask re-checks `!generating` AFTER its await (:1264) so a
   * user click during the fetch gap can't spawn a SECOND observer. Coverage
   * signal = /arch/task call count: click starts observer #1 (1 poll call);
   * the reconnect snapshot then resolves with the same running task — fixed
   * code skips (count stays 2); a version without the re-check would attach
   * observer #2 (an extra immediate poll → count 3). */
  test("click during the reconnect fetch gap does not spawn a second observer", async () => {
    const reconnectFetch = deferred<Response>();
    const firstPoll = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      [
        "/arch/task",
        () => {
          taskCalls += 1;
          return taskCalls === 1 ? reconnectFetch.promise : firstPoll.promise;
        },
      ],
      [
        "/arch/generate",
        () => Promise.resolve(jsonResponse({ success: true, taskId: "t-user-1" })),
      ],
      [
        "/arch/estimate",
        () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.35 } })),
      ],
    ]);

    const root = await mountRepoGraph(); // reconnect suspended on call #1
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn?.hidden).toBe(false);

    // User clicks Generate while the reconnect fetch is still in flight.
    genBtn?.click(); // runArchGenerate: generating=true (sync), POST fires
    await new Promise((r) => setTimeout(r, 0)); // POST resolves → observer #1 polls (call #2)
    // Button stays ENABLED (cancel affordance) during the run.
    expect(genBtn?.disabled).toBe(false);
    expect(taskCalls).toBe(2);

    // NOW the reconnect fetch resolves with the same running task. Fixed code's
    // post-await `!generating` re-check skips — no observer #2, no extra poll.
    reconnectFetch.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-user-1",
            kind: "arch_generate",
            status: "running",
            repo: REPO,
            startedTs: "2026-06-09T00:00:00.000Z",
            startedAgoMs: 100,
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(taskCalls).toBe(2); // ← the re-check half: a dropped guard reads 3 here

    // Drain: terminal for observer #1 → interval cleared, affordance restored.
    firstPoll.resolve(
      jsonResponse({
        data: {
          task: {
            id: "t-user-1",
            kind: "arch_generate",
            status: "failed",
            repo: REPO,
            startedTs: "2026-06-09T00:00:00.000Z",
            startedAgoMs: 200,
          },
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(genBtn?.disabled).toBe(false);
    expect(genBtn?.hidden).toBe(false);
  });
});
