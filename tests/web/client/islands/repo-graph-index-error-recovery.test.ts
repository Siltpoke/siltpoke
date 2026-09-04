/**
 * Index-error terminal must not be a dead end.
 *
 * Covers: the failure that stranded a working Code Map — `showIndexProgress`
 * hides `#rg-world` to make room for the centre "Indexing …" state, and the
 * old `showIndexError` never put it back. There was no `remove("show")`
 * anywhere in the island, so ONE failed index left the previously-rendered
 * graph hidden behind a permanent overlay until a full page reload.
 *
 * ── Structure ─────────────────────────────────────────────────────────────────
 *
 * 1. Recovery from a graph view
 *    a. Positive control — the progress state really did hide the world.
 *    b. Error terminal offers a dismiss affordance.
 *    c. Dismiss restores the world AND drops the overlay.
 *
 * 2. Recovery to the state we came FROM (not blindly to the graph)
 *    d. Failing an index while sitting on an unindexed repo's empty state
 *       returns to THAT empty state, not to a bare canvas.
 *
 * 3. Honest terminal copy — the three server terminals read differently
 *    e. index_failed → "exited"
 *    f. index_error  → "crashed"
 *    g. timeout / cancelled regression — still their own wording.
 *
 * ── Anti-vacuous discipline ───────────────────────────────────────────────────
 *    Each recovery test asserts the hidden/overlay state FIRST (1a), so a
 *    restore assertion cannot pass because the flow never ran. The copy tests
 *    assert both the expected word and the ABSENCE of the generic fallback,
 *    so a single "Indexing failed." for every terminal fails them.
 *
 * Run: bun test tests/web/client/islands/repo-graph-index-error-recovery.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installFetchMock, jsonResponse, mountRepoGraph, registerDom, unregisterDom } from "./_dom-harness";

// ── Lifecycle ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  window.history.replaceState(null, "", "/repo-graph");
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Resolve microtasks only — NOT real timers. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Wait up to ~200 ms for a predicate, then THROW. A silent timeout would let a
 * broken drive-path masquerade as a content assertion failing on empty text —
 * which is exactly how the first draft of this file misread itself. */
async function waitFor(predicate: () => boolean, label: string, maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** An SSE response the island's reader loop can consume, content-type included
 * (`submitIndex` routes anything `application/json` down the inline-error path). */
function sseResponse(events: ReadonlyArray<readonly [string, unknown]>): Response {
  const body = events.map(([ev, data]) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const FIXTURE_HASH = "f1x7ur3hash0";
const OTHER_HASH = "0th3rrepohash";

/** repos payload: the fixture repo (ready) plus an unindexed sibling. */
function reposPayload() {
  return jsonResponse({
    data: {
      repos: [
        {
          id: FIXTURE_HASH,
          name: "fixture-repo",
          path: "/tmp/island-harness-fixture-repo",
          state: "ready",
          files: 3,
          symbols: 9,
          edges: 1,
        },
        {
          id: OTHER_HASH,
          name: "never-indexed",
          path: "/tmp/never-indexed",
          state: "none",
          files: 0,
          symbols: 0,
          edges: 0,
        },
      ],
    },
  });
}

/** Factory, never a shared constant — a Response body is consumable ONCE, and a
 * module-level instance silently reads empty from the second test onward. */
function fsPayload(): Response {
  return jsonResponse({
    data: {
      dir: "/Users/v/Projects/demo-repo",
      parent: "/Users/v/Projects",
      isCodebase: true,
      entries: [],
      truncated: 0,
    },
  });
}

/**
 * Drive the real UI path all the way to a terminal SSE event:
 * repo picker → "+ Index a repo" → folder browser → "Index this folder".
 * Returns the island root plus the two elements the bug is about.
 */
async function runIndexToTerminal(
  events: ReadonlyArray<readonly [string, unknown]>,
  opts: { onProgress?: (root: HTMLElement) => void; preselectUnindexed?: boolean } = {},
): Promise<{ root: HTMLElement; world: HTMLElement; empty: HTMLElement }> {
  installFetchMock([
    ["/api/repo-graph/repos", () => Promise.resolve(reposPayload())],
    ["/api/fs/list", () => Promise.resolve(fsPayload())],
    ["/api/repo-graph/index", () => Promise.resolve(sseResponse(events))],
  ]);

  const root = await mountRepoGraph();
  await tick();

  const world = root.querySelector<HTMLElement>("#rg-world");
  const empty = root.querySelector<HTMLElement>("#rg-repo-empty");
  if (!world || !empty) throw new Error("fixture missing #rg-world / #rg-repo-empty");

  // Open the repo picker so the menu (and the "+ Index a repo" button) exists.
  root.querySelector<HTMLElement>("#rg-repo-pick")?.click();
  await waitFor(() => root.querySelector("#rg-idx-add") != null, "repo menu rendered '+ Index a repo'");

  if (opts.preselectUnindexed) {
    // Land on the "<name> isn't indexed yet" empty state BEFORE indexing, so
    // the restore has a non-graph state to return to.
    root.querySelector<HTMLElement>(`.repo-row[data-id="${OTHER_HASH}"]`)?.click();
    await tick();
    // Re-open the picker — showRepoEmpty closes the menu.
    root.querySelector<HTMLElement>("#rg-repo-pick")?.click();
    await waitFor(() => root.querySelector("#rg-idx-add") != null, "repo menu rendered '+ Index a repo'");
  }

  root.querySelector<HTMLElement>("#rg-idx-add")?.click();
  await waitFor(() => root.querySelector("#rg-fb-index") != null, "folder browser rendered 'Index this folder'");

  root.querySelector<HTMLElement>("#rg-fb-index")?.click();
  await waitFor(() => empty.classList.contains("show"), "index progress raised the centre overlay");
  opts.onProgress?.(root);
  // Let the reader loop drain the remaining events (progress/error).
  await tick();
  await tick();

  return { root, world, empty };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Recovery from a graph view
// ─────────────────────────────────────────────────────────────────────────────

describe("index error terminal is escapable from a rendered graph", () => {
  test("dismiss restores #rg-world and drops the overlay", async () => {
    // ── Positive control (1a): capture the mid-flight state so the restore
    // assertions below cannot pass vacuously. If the flow never reached the
    // progress state, `hidWorld` stays false and this test fails HERE.
    let hidWorld = false;
    let overlayShown = false;

    const { root, world, empty } = await runIndexToTerminal(
      [
        ["started", { hash: "demo-repohash", name: "demo-repo" }],
        // A progress tick between start and failure — the realistic shape, and
        // the one that catches a snapshot taken per-call instead of per-run
        // (the tick's own "Indexing…" view would become what we restore to).
        ["progress", { done: 120, total: 4000 }],
        ["error", { message: "index_failed" }],
      ],
      {
        onProgress: (r) => {
          const w = r.querySelector<HTMLElement>("#rg-world");
          const e = r.querySelector<HTMLElement>("#rg-repo-empty");
          hidWorld = w?.style.display === "none";
          overlayShown = e?.classList.contains("show") ?? false;
        },
      },
    );

    expect(hidWorld).toBe(true); // progress state really hid the canvas
    expect(overlayShown).toBe(true); // …and really raised the overlay

    // Terminal reached: the repo name is on screen (proves it's the SSE error
    // path, not the inline reasonText path, which never renders a name).
    expect(empty.textContent ?? "").toContain("demo-repo");

    // ── (1b) The terminal offers a way out.
    // Pre-fix: showIndexError wrote only <h3>/<p> — no button at all → null → FAIL.
    const dismiss = empty.querySelector<HTMLElement>("#rg-idx-dismiss");
    expect(dismiss).not.toBeNull();

    // ── (1c) Taking it restores what was on screen before the index started.
    dismiss!.click();
    await tick();

    // Pre-fix: unreachable (no button). The invariant: world.style.display is
    // never left as "none" by a failed index.
    expect(world.style.display).not.toBe("none");
    expect(empty.classList.contains("show")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Restore returns to the PRE-INDEX state, not blindly to the graph
// ─────────────────────────────────────────────────────────────────────────────

describe("dismiss returns to the state the index was started from", () => {
  test("failing from an unindexed repo's empty state returns to that empty state", async () => {
    const { empty, world } = await runIndexToTerminal(
      [
        ["started", { hash: "demo-repohash", name: "demo-repo" }],
        ["progress", { done: 120, total: 4000 }],
        ["error", { message: "index_failed" }],
      ],
      { preselectUnindexed: true },
    );

    const dismiss = empty.querySelector<HTMLElement>("#rg-idx-dismiss");
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await tick();

    // We came FROM "never-indexed isn't indexed yet" — restoring must land back
    // there, overlay still up and canvas still hidden. Blindly un-hiding the
    // world would show an empty canvas for a repo that has no graph.
    expect(empty.classList.contains("show")).toBe(true);
    expect(empty.textContent ?? "").toContain("never-indexed");
    expect(world.style.display).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. Two runs in one page life — the snapshot must not compound
// ─────────────────────────────────────────────────────────────────────────────

describe("a second index run after a failure restores the ORIGINAL view", () => {
  test("fail → don't dismiss → fail again → dismiss lands on the graph, not the first error screen", async () => {
    // Reviewer finding #3: nothing pinned the chained-run semantics of the
    // snapshot. The trap: re-capturing on the second run would snapshot the
    // FIRST run's error screen, so dismissing would "restore" to an error.
    let runs = 0;
    installFetchMock([
      ["/api/repo-graph/repos", () => Promise.resolve(reposPayload())],
      ["/api/fs/list", () => Promise.resolve(fsPayload())],
      [
        "/api/repo-graph/index",
        () => {
          runs += 1;
          return Promise.resolve(
            sseResponse([
              ["started", { hash: "h", name: `demo-repo-run-${runs}` }],
              ["error", { message: "index_failed" }],
            ]),
          );
        },
      ],
    ]);

    const root = await mountRepoGraph();
    await tick();
    const world = root.querySelector<HTMLElement>("#rg-world");
    const empty = root.querySelector<HTMLElement>("#rg-repo-empty");
    if (!world || !empty) throw new Error("fixture missing #rg-world / #rg-repo-empty");

    // The view we must end up back on: the graph, overlay down.
    expect(world.style.display).not.toBe("none");
    expect(empty.classList.contains("show")).toBe(false);

    // Arrow const, not a hoisted `function` — a declaration is visible before
    // the null-guard above, so TS drops the narrowing on `empty` inside it.
    const failOneRun = async (): Promise<void> => {
      root.querySelector<HTMLElement>("#rg-repo-pick")?.click();
      await waitFor(() => root.querySelector("#rg-idx-add") != null, "repo menu reopened");
      root.querySelector<HTMLElement>("#rg-idx-add")?.click();
      await waitFor(() => root.querySelector("#rg-fb-index") != null, "folder browser reopened");
      root.querySelector<HTMLElement>("#rg-fb-index")?.click();
      await waitFor(() => empty.classList.contains("show"), "overlay raised");
      await tick();
      await tick();
    };

    await failOneRun();
    expect(empty.textContent ?? "").toContain("demo-repo-run-1");

    // Second run WITHOUT dismissing the first error.
    await failOneRun();
    expect(runs).toBe(2); // positive control: the second POST really happened
    expect(empty.textContent ?? "").toContain("demo-repo-run-2");

    root.querySelector<HTMLElement>("#rg-idx-dismiss")?.click();
    await tick();

    // Back to the graph — NOT to run 1's error screen.
    expect(world.style.display).not.toBe("none");
    expect(empty.classList.contains("show")).toBe(false);
    expect(empty.textContent ?? "").not.toContain("demo-repo-run-1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Honest terminal copy — the server's three terminals read differently
// ─────────────────────────────────────────────────────────────────────────────

describe("terminal copy distinguishes the server's failure modes", () => {
  test("index_failed says the indexer exited, not a generic failure", async () => {
    const { empty } = await runIndexToTerminal([
      ["started", { hash: "h", name: "demo-repo" }],
      ["error", { message: "index_failed" }],
    ]);
    const text = empty.textContent ?? "";
    // Pre-fix: every non-cancel/timeout message collapsed to "Indexing failed."
    expect(text).toContain("exited");
    expect(text).not.toContain("Indexing failed.");
  });

  test("index_error says the indexer crashed, distinct from a non-zero exit", async () => {
    const { empty } = await runIndexToTerminal([
      ["started", { hash: "h", name: "demo-repo" }],
      ["error", { message: "index_error" }],
    ]);
    const text = empty.textContent ?? "";
    expect(text).toContain("crashed");
    expect(text).not.toContain("Indexing failed.");
  });

  test("regression — timeout and cancelled keep their own wording", async () => {
    const timedOut = await runIndexToTerminal([
      ["started", { hash: "h", name: "demo-repo" }],
      ["error", { message: "timeout" }],
    ]);
    expect(timedOut.empty.textContent ?? "").toContain("timed out");

    const cancelled = await runIndexToTerminal([
      ["started", { hash: "h", name: "demo-repo" }],
      ["error", { message: "cancelled" }],
    ]);
    expect(cancelled.empty.textContent ?? "").toContain("cancelled");
  });

  test("a stream that just STOPS still lands on a dismissible terminal", async () => {
    // Reviewer finding: the reader loop's only UI exits were the explicit
    // done/error frames. A daemon restart mid-build ends the stream with no
    // frame at all — which used to leave the progress overlay up permanently,
    // the very dead end this change exists to remove.
    const { empty, world } = await runIndexToTerminal([
      ["started", { hash: "demo-repohash", name: "demo-repo" }],
      ["progress", { done: 40, total: 4000 }],
      // …and nothing else. No done, no error.
    ]);

    const text = empty.textContent ?? "";
    expect(text).toContain("Lost the indexer's progress stream");
    // It must NOT claim nothing was saved — the build's outcome is unknown to
    // the client here, unlike index_failed / index_error / timeout.
    expect(text).not.toContain("Nothing was saved");

    const dismiss = empty.querySelector<HTMLElement>("#rg-idx-dismiss");
    expect(dismiss).not.toBeNull();
    dismiss!.click();
    await tick();
    expect(world.style.display).not.toBe("none");
    expect(empty.classList.contains("show")).toBe(false);
  });

  test("regression — a SUCCESSFUL run does not trip the disconnect terminal", async () => {
    // The disconnect guard lives in the reader's `finally`, which also runs on
    // the success path (the "done" branch returns after kicking off a
    // navigation). Without `sawTerminal` this would paint a scary "lost the
    // stream" message over a build that actually succeeded.
    const { empty } = await runIndexToTerminal([
      ["started", { hash: "goodhash", name: "demo-repo" }],
      ["progress", { done: 4000, total: 4000 }],
      ["done", { hash: "goodhash" }],
    ]);
    const text = empty.textContent ?? "";
    expect(text).not.toContain("Lost the indexer's progress stream");
    expect(text).not.toContain("Indexing failed.");
    expect(empty.querySelector("#rg-idx-dismiss")).toBeNull();
  });

  test("the indexer's own stderr line reaches the screen, and is escaped", async () => {
    // The point of the whole detail channel: before it existed, this exact
    // message was produced on every dashboard index and shown to nobody.
    const raw = 'error: Module not found "/Users/v/<b>siltpoke</b>/cli/index-repo.ts"';
    const { empty } = await runIndexToTerminal([
      ["started", { hash: "h", name: "demo-repo" }],
      ["error", { message: "index_failed", detail: raw }],
    ]);

    const detail = empty.querySelector<HTMLElement>(".rg-idx-detail");
    expect(detail).not.toBeNull();
    expect(detail!.textContent ?? "").toContain("Module not found");
    // It comes from a child process — treat it as untrusted and escape it.
    expect(detail!.querySelector("b")).toBeNull();
    expect(detail!.innerHTML).toContain("&lt;b&gt;");
    // The stale advice from the previous PR must be gone: there is no daemon
    // log to send anyone to — stderr was being discarded, which is why this
    // channel had to exist at all.
    expect(empty.textContent ?? "").not.toContain("daemon log");
  });

  test("no detail from the server → no empty detail line rendered", async () => {
    const { empty } = await runIndexToTerminal([
      ["started", { hash: "h", name: "demo-repo" }],
      ["error", { message: "index_failed" }],
    ]);
    expect(empty.querySelector(".rg-idx-detail")).toBeNull();
    // …and the terminal is still complete without it.
    expect(empty.textContent ?? "").toContain("exited with an error");
    expect(empty.querySelector("#rg-idx-dismiss")).not.toBeNull();
  });

  test("an unknown message still falls back to a generic failure line", async () => {
    const { empty } = await runIndexToTerminal([
      ["started", { hash: "h", name: "demo-repo" }],
      ["error", { message: "something_new_from_the_server" }],
    ]);
    // The fallback must survive — an unmapped terminal is still a failure, and
    // it must still be dismissible.
    expect(empty.textContent ?? "").toContain("Indexing failed.");
    expect(empty.querySelector("#rg-idx-dismiss")).not.toBeNull();
  });
});
