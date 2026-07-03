/**
 * INDEPENDENT acceptance test — daemon-hardening, DOM-bound half.
 *
 * Verifier-authored (NOT the implementer's). Mounts the REAL repo-graph island
 * (real SSR render → real bootRepoGraph body) and drives it the way the browser
 * would — click Generate, resolve the poll — asserting the OBSERVABLE rendered
 * DOM. Sibling to output-guard.acceptance.test.ts; split because
 * happy-dom's GlobalRegistrator swaps globalThis.fetch and cannot share a process
 * with Bun-native fetch tests (oven-sh/bun#8774).
 *
 *   Truncation advisory is NON-BLOCKING (DOM proof): a mayTruncate:true estimate makes
 *   the modal show the truncation warning AND confirming still fires the
 *   paid /arch/generate. The flag's value does NOT gate the fire.
 *
 *   errorMsg present on a malformed/failed terminal → the rendered genLabel
 *   IS the real reason text, NOT the generic archTerminalLabel.
 *
 *   Successful generate → generic affordance label, no errorMsg, no
 *   after-the-fact truncation warning (no regression).
 *
 * Contract: island pollArchTaskTerminal → {status, errorMsg}; observeArchRun
 *           surfaces errorMsg via genLabel.textContent when present.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  deferred,
  installFetchMock,
  jsonResponse,
  mountRepoGraph,
  registerDom,
  unregisterDom,
} from "../web/client/islands/_dom-harness";

// ── Lifecycle (per-file DOM scope; all deferreds settled before teardown) ────────
beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  window.history.replaceState(null, "", "/repo-graph");
  document.querySelectorAll("[data-confirm-modal]").forEach((el) => {
    el.remove();
  });
  document.body.style.overflow = "";
});

const REPO_HASH = "f1x7ur3hash0";

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

const EV = [{ file: "src/alpha/a.ts", line: 1 }];
const GEN_DOC = {
  boundary: "fixture-guard",
  bands: [{ id: "core", label: { value: "G", evidence: EV }, order: 0, members: ["genbox"] }],
  nodes: [
    {
      id: "genbox",
      kind: "cont",
      title: { value: "GenBox", evidence: EV },
      band: { value: "core", evidence: EV },
      drillTo: "alpha",
      members: ["src/alpha/a.ts"],
    },
  ],
  edges: [],
};

function getOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-confirm-modal]");
}
function modalBodyText(): string {
  return getOverlay()?.querySelector<HTMLElement>("[data-modal-body]")?.textContent ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Truncation advisory is NON-BLOCKING (DOM): warning shows in the modal AND confirm
// still fires the paid generate. mayTruncate does NOT gate the fire.
// ─────────────────────────────────────────────────────────────────────────────
describe("truncation advisory is non-blocking (modal warns, confirm still fires)", () => {
  test("mayTruncate:true → modal shows the warning AND confirm fires /arch/generate", async () => {
    let generateFired = 0;
    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      [
        "/arch/estimate",
        () =>
          // The advisory flag rides the envelope the route emits (repo-graph.tsx:469).
          Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.2, mayTruncate: true } })),
      ],
      [
        "/arch/generate",
        () => {
          generateFired += 1;
          // Resolve as a 200 with a taskId so observeArchRun has something to poll;
          // the subsequent /arch/task returns null → "gone" → clean terminal.
          return Promise.resolve(jsonResponse({ success: true, taskId: "t-b2-fire" }));
        },
      ],
    ]);

    // generatedModel present → click routes through the confirm modal (cache path),
    // the ONLY path that reads mayTruncate. (The no-cache path never reads it.)
    const root = await mountRepoGraph({
      generatedModel: { doc: GEN_DOC, groundedPct: 80, stale: false, generatedTs: new Date().toISOString() },
    });
    await tick();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();
    genBtn!.click();
    await tick();
    await tick();

    // DOOR-OPENED PROOF (part 1): the modal opened AND carries the advisory line.
    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    expect(modalBodyText()).toContain("large repo"); // ARCH_TRUNCATION_WARNING copy

    // Before confirming, generate must NOT have fired (the warning alone is inert).
    expect(generateFired).toBe(0);

    // NON-BLOCKING: the confirm button is enabled despite the warning → click it.
    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn).not.toBeNull();
    expect(confirmBtn!.disabled).toBe(false);
    confirmBtn!.click();
    await tick();
    await tick();

    // THE ASSERTION: with mayTruncate true, confirming STILL fired the paid run.
    // The advisory did not block (consistent with the warn-not-block stance).
    expect(generateFired).toBe(1);
  });
});

// ── Shared driver for terminal-snapshot assertions ────────────────────────────
/** boot → click Generate (no cache → direct fire) → resolve poll with ONE
 *  terminal snapshot → return root for label inspection. */
async function runToTerminal(
  terminal: Record<string, unknown>,
  opts: { withModel?: boolean } = {},
): Promise<HTMLElement> {
  const pollDeferred = deferred<Response>();
  let taskCalls = 0;
  const routes: Parameters<typeof installFetchMock>[0] = [
    [
      "/arch/task",
      () => {
        taskCalls += 1;
        // First call (reconnect probe) → no task; later calls (the poll) → terminal.
        if (taskCalls === 1) return Promise.resolve(jsonResponse({ data: { task: null } }));
        return pollDeferred.promise;
      },
    ],
    ["/arch/generate", () => Promise.resolve(jsonResponse({ success: true, taskId: String(terminal.id) }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
  ];
  if (opts.withModel) {
    routes.push([
      "/arch/model",
      () =>
        Promise.resolve(
          jsonResponse({
            data: {
              model: GEN_DOC,
              groundedPct: 88,
              fileFunctions: null,
              generatedTs: new Date().toISOString(),
              durationMs: 42_000,
            },
          }),
        ),
    ]);
  }
  installFetchMock(routes);

  const root = await mountRepoGraph(); // generatedModel null → no-cache → direct fire
  await tick();
  const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
  genBtn!.click();
  await tick();
  await tick();

  pollDeferred.resolve(jsonResponse({ data: { task: terminal } }));
  await tick();
  await tick();
  await tick();
  return root;
}

function genLabelText(root: HTMLElement): string {
  return root.querySelector<HTMLElement>("#rg-arch-gen-label")?.textContent ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// errorMsg present → rendered label IS the real reason, not the generic.
// ─────────────────────────────────────────────────────────────────────────────
describe("persisted errorMsg is rendered (replaces the generic terminal label)", () => {
  test("failed terminal WITH errorMsg → label shows the real reason, not 'Generate failed — retry'", async () => {
    const reason = "malformed JSON, output_tokens:34547";
    const root = await runToTerminal({
      id: "t-b3-failed",
      kind: "arch_generate",
      status: "failed",
      repo: REPO_HASH,
      startedTs: new Date().toISOString(),
      startedAgoMs: 100,
      errorMsg: reason,
    });

    const label = genLabelText(root);
    // The real reason (incl. the output-token count) is on screen — no .out dig.
    expect(label).toContain("output_tokens:34547");
    // Wording "replacing the generic archTerminalLabel": generic text is gone.
    expect(label).not.toContain("Generate failed — retry");
  });

  test("done-but-no-model (malformed) WITH errorMsg → label shows reason, not 'No model produced'", async () => {
    const reason = "malformed JSON, output_tokens:34547";
    // status done, but no /arch/model route → loadGeneratedModel false → malformed arm.
    const root = await runToTerminal({
      id: "t-b3-malformed",
      kind: "arch_generate",
      status: "done",
      repo: REPO_HASH,
      startedTs: new Date().toISOString(),
      startedAgoMs: 100,
      errorMsg: reason,
    });

    const label = genLabelText(root);
    expect(label).toContain("output_tokens:34547");
    expect(label).not.toContain("No model produced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Success → generic label, no errorMsg text, no after-the-fact warning.
// ─────────────────────────────────────────────────────────────────────────────
describe("successful generate: no errorMsg, no truncation warning (no regression)", () => {
  test("done + model loads → normal affordance label, no failure text", async () => {
    const root = await runToTerminal(
      {
        id: "t-b4-success",
        kind: "arch_generate",
        status: "done",
        repo: REPO_HASH,
        startedTs: new Date().toISOString(),
        startedAgoMs: 100,
        // a successful run never carries errorMsg
      },
      { withModel: true },
    );

    const label = genLabelText(root);
    // No failure/truncation text whatsoever on the success path.
    expect(label).not.toContain("failed");
    expect(label).not.toContain("No model produced");
    expect(label).not.toContain("output_tokens");
    expect(label).not.toContain("may hit the output cap"); // truncation warning copy
    expect(label).not.toContain("large repo");
    // Positive control (non-vacuous): the normal affordance label IS rendered —
    // proves the success path reached updateArchAffordance, not a blank/stuck label.
    const isNormalLabel = label.includes("Generate architecture") || label.includes("Re-generate");
    expect(isNormalLabel).toBe(true);
  });

  test("absent errorMsg on a failed run → generic archTerminalLabel survives (no over-routing)", async () => {
    const root = await runToTerminal({
      id: "t-b4-no-errmsg",
      kind: "arch_generate",
      status: "failed",
      repo: REPO_HASH,
      startedTs: new Date().toISOString(),
      startedAgoMs: 100,
      // no errorMsg → generic path must remain
    });

    // Generic path preserved when there is no persisted reason to show.
    expect(genLabelText(root)).toContain("failed");
  });
});
