/**
 * Surface the persisted arch-generate `errorMsg` in the dashboard UI.
 *
 * Covers: the real reason replaces the generic archTerminalLabel on
 * malformed/failed runs, and a successful generate shows no errorMsg with
 * the generic path unchanged.
 *
 * Background: the daemon persists `errorMsg` on the task record (capped 500c, includes
 * output-token count for malformed runs). The route already spreads the full record
 * into the /arch/task snapshot (`repo-graph.tsx:732`), so errorMsg rides the existing
 * payload. The gap is client-side: observeArchRun discarded it and always showed the
 * generic `archTerminalLabel(status)`.
 *
 * ── Structure ─────────────────────────────────────────────────────────────────
 *   1. failed terminal WITH errorMsg → genLabel shows the real reason (the
 *      errorMsg text), NOT the generic "Generate failed — retry".
 *   2. done-but-no-model (malformed) WITH errorMsg → genLabel shows the real
 *      reason, NOT the generic "No model produced — retry".
 *   3. failed terminal WITHOUT errorMsg → generic archTerminalLabel unchanged.
 *   4. successful terminal (done + model) → no error label at all (regression).
 *   5. XSS: errorMsg is rendered as TEXT (no HTML injection) — a tag in errorMsg
 *      appears verbatim in textContent, never as a live DOM element.
 *
 * ── Anti-vacuous discipline ───────────────────────────────────────────────────
 *   Each errorMsg-present test asserts the REAL reason text appears AND the generic
 *   label is absent (door-opened proof: the new branch fired, not the old one).
 *   The absent-errorMsg tests assert the generic label survives (no over-routing).
 *
 * Run: bun test tests/web/client/islands/repo-graph-errormsg.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  deferred,
  installFetchMock,
  jsonResponse,
  mountRepoGraph,
  registerDom,
  unregisterDom,
} from "./_dom-harness";

// ── Lifecycle ──────────────────────────────────────────────────────────────────

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

const GEN_DOC = {
  boundary: "fixture-gen",
  bands: [
    {
      id: "core",
      label: { value: "GenBand", evidence: [{ file: "src/alpha/a.ts", line: 1 }] },
      order: 0,
      members: ["genbox"],
    },
  ],
  nodes: [
    {
      id: "genbox",
      kind: "cont",
      title: { value: "GeneratedBox", evidence: [{ file: "src/alpha/a.ts", line: 1 }] },
      band: { value: "core", evidence: [{ file: "src/alpha/a.ts", line: 1 }] },
      drillTo: "alpha",
      members: ["src/alpha/a.ts"],
    },
  ],
  edges: [],
};

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Drive boot → click Generate → resolve the poll with one terminal snapshot. */
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
              durationMs: 42000,
            },
          }),
        ),
    ]);
  }
  installFetchMock(routes);

  const root = await mountRepoGraph();
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

// ─────────────────────────────────────────────────────────────────────────────
// failed terminal WITH errorMsg → real reason replaces generic label
// ─────────────────────────────────────────────────────────────────────────────

describe("failed terminal with errorMsg shows the real reason", () => {
  test("genLabel shows errorMsg text, NOT the generic 'Generate failed — retry'", async () => {
    const reason = "malformed JSON, output_tokens:34547";
    const root = await runToTerminal({
      id: "t-errmsg-failed-1",
      kind: "arch_generate",
      status: "failed",
      repo: REPO_HASH,
      startedTs: new Date().toISOString(),
      startedAgoMs: 100,
      errorMsg: reason,
    });

    const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
    const labelText = genLabel?.textContent ?? "";

    // The real reason text is rendered.
    // Pre-impl: observeArchRun → finishUI(archTerminalLabel("failed")) → "⚠ Generate
    // failed — retry"; errorMsg never read → reason absent → FAIL.
    expect(labelText).toContain("output_tokens:34547");
    // Wording: generic text is gone.
    expect(labelText).not.toContain("Generate failed — retry");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// done-but-no-model (malformed) WITH errorMsg → real reason replaces generic
// ─────────────────────────────────────────────────────────────────────────────

describe("done-but-no-model with errorMsg shows the real reason", () => {
  test("malformed run (done, no model, errorMsg) → genLabel shows reason, not 'No model produced'", async () => {
    const reason = "malformed JSON, output_tokens:34547";
    // status "done" but /arch/model 404s → loadGeneratedModel returns false →
    // the done-but-no-model branch. NO withModel route → fetch 404 default.
    const root = await runToTerminal({
      id: "t-errmsg-malformed-1",
      kind: "arch_generate",
      status: "done",
      repo: REPO_HASH,
      startedTs: new Date().toISOString(),
      startedAgoMs: 100,
      errorMsg: reason,
    });

    const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
    const labelText = genLabel?.textContent ?? "";

    // The real reason replaces the generic no-model label.
    // Pre-impl: done-but-no-model → finishUI("⚠ No model produced — retry") → FAIL.
    expect(labelText).toContain("output_tokens:34547");
    expect(labelText).not.toContain("No model produced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// failed terminal WITHOUT errorMsg → generic label unchanged (no regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("failed terminal without errorMsg keeps the generic label", () => {
  test("no errorMsg → genLabel shows the generic 'Generate failed — retry'", async () => {
    const root = await runToTerminal({
      id: "t-no-errmsg-failed-1",
      kind: "arch_generate",
      status: "failed",
      repo: REPO_HASH,
      startedTs: new Date().toISOString(),
      startedAgoMs: 100,
      // no errorMsg
    });

    const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
    const labelText = genLabel?.textContent ?? "";

    // Generic path preserved: absent errorMsg → archTerminalLabel unchanged.
    expect(labelText).toContain("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// successful terminal → no error label at all (regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("successful generate shows no errorMsg / error label", () => {
  test("done + model loads → no error reason text on the label", async () => {
    const root = await runToTerminal(
      {
        id: "t-success-1",
        kind: "arch_generate",
        status: "done",
        repo: REPO_HASH,
        startedTs: new Date().toISOString(),
        startedAgoMs: 100,
        // a successful run never carries errorMsg
      },
      { withModel: true },
    );

    const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
    const labelText = genLabel?.textContent ?? "";

    // No failure text whatsoever on the success path.
    expect(labelText).not.toContain("failed");
    expect(labelText).not.toContain("No model produced");
    expect(labelText).not.toContain("output_tokens");
    // Positive control (non-vacuous): the normal affordance label IS rendered —
    // proves the success path reached updateArchAffordance, not an empty/stuck label.
    const isNormalLabel =
      labelText.includes("Generate architecture") || labelText.includes("Re-generate");
    expect(isNormalLabel).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// XSS — errorMsg is rendered as TEXT, never as live HTML
// ─────────────────────────────────────────────────────────────────────────────

describe("errorMsg renders as text content, not HTML", () => {
  test("an HTML-looking errorMsg appears verbatim in textContent, no injected element", async () => {
    const reason = "<img src=x onerror=alert(1)> output_tokens:34547";
    const root = await runToTerminal({
      id: "t-errmsg-xss-1",
      kind: "arch_generate",
      status: "failed",
      repo: REPO_HASH,
      startedTs: new Date().toISOString(),
      startedAgoMs: 100,
      errorMsg: reason,
    });

    const genLabel = root.querySelector<HTMLElement>("#rg-arch-gen-label");
    // Rendered as text: the literal "<img" appears in textContent.
    expect(genLabel?.textContent ?? "").toContain("<img");
    // And NO live <img> element was injected into the label.
    expect(genLabel?.querySelector("img")).toBeNull();
  });
});
