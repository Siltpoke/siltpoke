/**
 * Re-generate force-flag correctness.
 *
 * Bug (pre-fix): `runArchGenerate` sent `force: generatedStale` in the POST
 * body. When the cached model is FRESH (generatedStale=false), the user
 * clicking through the modal confirmation got `force:false`, which hit the
 * server-side cache short-circuit at arch-generate.ts:297 (`if (!ctx.force)`)
 * and returned the cached result instantly without regenerating — a silent no-op.
 *
 * Fix: `force: generatedPayload !== null`
 * — true whenever a cached model exists at fire time (the user passed the modal
 *   gate to REPLACE it), regardless of stale/fresh.
 * — false on first-generate (no cache) — irrelevant because the server-side
 *   cache miss path runs regardless, but semantically correct.
 *
 * ── Test matrix ───────────────────────────────────────────────────────────────
 *
 * 1. FRESH cache  (generatedPayload present, stale:false) + click + modal confirm
 *    → body.force === true   ← THE bug; RED against unfixed code
 *
 * 2. STALE cache  (stale:true) + click + modal confirm
 *    → body.force === true   (unchanged behavior, no regression)
 *
 * 3. NO cache     (generatedPayload null) + click (direct fire, no modal)
 *    → body.force === false  (first-generate semantics preserved)
 *
 * Run: bun test tests/web/client/islands/repo-graph-regen-force.test.ts
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
  document.querySelectorAll("[data-confirm-modal]").forEach((el) => el.remove());
  document.body.style.overflow = "";
});

// ── Shared fixture ─────────────────────────────────────────────────────────────

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

/** Resolve microtasks only — NOT real timers. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. FRESH cache + modal confirm → body.force === true (THE BUG)
// ─────────────────────────────────────────────────────────────────────────────

describe("re-generate force flag — FRESH cache + modal confirm → force:true", () => {
  test("fresh cache (stale:false): after modal confirm, generate POST body.force === true", async () => {
    // Capture the POST body from the /arch/generate call.
    let capturedBody: { repo?: string; force?: boolean } | null = null;
    const generateDeferred = deferred<Response>();

    installFetchMock([
      // reconnect check at boot — no running task
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      // estimate for modal
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.05 } }))],
      [
        "/arch/generate",
        async (url) => {
          // The fetch mock receives the raw URL string; body is in the Request
          // object when using installFetchMock. But installFetchMock passes only
          // the URL string. We intercept at the globalThis.fetch level instead.
          // (The override below replaces installFetchMock for the generate route.)
          return generateDeferred.promise;
        },
      ],
    ]);

    // Override fetch to capture the POST body for /arch/generate.
    // We must do this AFTER installFetchMock so our wrapper sees all routes.
    const upstream = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes("/arch/generate") && init?.method === "POST") {
        try {
          capturedBody = JSON.parse((init.body as string) ?? "{}") as typeof capturedBody;
        } catch {
          capturedBody = {};
        }
        // Return a valid taskId so the island proceeds without errors.
        return Promise.resolve(
          jsonResponse({ success: true, taskId: "t-force-fresh-1" }),
        );
      }
      return upstream(input as never, init);
    }) as typeof fetch;

    // Boot with FRESH cache (stale:false).
    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 82,
        stale: false,
        generatedTs: new Date().toISOString(),
        durationMs: 12000,
        costUsd: 0.04,
      },
    });
    await tick();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull(); // anti-vacuous: button present

    // Anti-vacuous: confirm fresh state → ghost-tier button.
    // "rg-btn-ghost" indicates cache+fresh. Without this, clicking
    // might not reach the modal path (direct-fire instead).
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(true);

    // Click → modal should appear (cache present → modal gate).
    genBtn!.click();
    // Estimate fetch is async — give it time to settle + modal to render.
    await tick();
    await tick();
    await tick();

    const overlay = document.querySelector<HTMLElement>("[data-confirm-modal]");
    expect(overlay).not.toBeNull(); // anti-vacuous: modal opened (proves we hit modal path)

    // Click the confirm button → runArchGenerate() fires with the POST body.
    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn).not.toBeNull(); // anti-vacuous: confirm button exists
    confirmBtn!.click();
    await tick();
    await tick();

    // body.force must be true for a FRESH-cache re-generate.
    // Pre-fix: `force: generatedStale` = `force: false` → server cache short-circuits
    // at arch-generate.ts:297 → instant 37ms no-op → FAIL here.
    // Post-fix: `force: generatedPayload !== null` = `force: true` → passes.
    expect(capturedBody).not.toBeNull(); // anti-vacuous: POST body was captured
    expect(capturedBody!.force).toBe(true);

    // Restore fetch.
    globalThis.fetch = upstream;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. STALE cache + modal confirm → body.force === true (no regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("re-generate force flag — STALE cache + modal confirm → force:true", () => {
  test("stale cache (stale:true): after modal confirm, generate POST body.force === true", async () => {
    let capturedBody: { repo?: string; force?: boolean } | null = null;

    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.07 } }))],
      ["/arch/generate", () => Promise.resolve(jsonResponse({ success: true, taskId: "t-force-stale-1" }))],
    ]);

    const upstream = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes("/arch/generate") && init?.method === "POST") {
        try {
          capturedBody = JSON.parse((init.body as string) ?? "{}") as typeof capturedBody;
        } catch {
          capturedBody = {};
        }
        return Promise.resolve(
          jsonResponse({ success: true, taskId: "t-force-stale-1" }),
        );
      }
      return upstream(input as never, init);
    }) as typeof fetch;

    // Boot with STALE cache (stale:true).
    const root = await mountRepoGraph({
      generatedModel: {
        doc: GEN_DOC,
        groundedPct: 70,
        stale: true,
        generatedTs: new Date().toISOString(),
        durationMs: 8000,
        costUsd: 0.06,
      },
    });
    await tick();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();

    // Anti-vacuous: stale state → accent-tier button.
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(true);

    genBtn!.click();
    await tick();
    await tick();
    await tick();

    const overlay = document.querySelector<HTMLElement>("[data-confirm-modal]");
    expect(overlay).not.toBeNull(); // anti-vacuous: modal opened

    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn).not.toBeNull();
    confirmBtn!.click();
    await tick();
    await tick();

    // ── CHECKPOINT: stale path also yields force:true (was already true pre-fix;
    // this is a regression guard — the fix must not break the stale path).
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.force).toBe(true);

    globalThis.fetch = upstream;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. NO cache + direct click (no modal) → body.force === false
// ─────────────────────────────────────────────────────────────────────────────

describe("re-generate force flag — NO cache + direct click → force:false", () => {
  test("no cache (generatedPayload null): direct click fires generate POST with force:false", async () => {
    let capturedBody: { repo?: string; force?: boolean } | null = null;

    installFetchMock([
      ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.05 } }))],
      ["/arch/generate", () => Promise.resolve(jsonResponse({ success: true, taskId: "t-force-nocache-1" }))],
    ]);

    const upstream = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;
      if (url.includes("/arch/generate") && init?.method === "POST") {
        try {
          capturedBody = JSON.parse((init.body as string) ?? "{}") as typeof capturedBody;
        } catch {
          capturedBody = {};
        }
        return Promise.resolve(
          jsonResponse({ success: true, taskId: "t-force-nocache-1" }),
        );
      }
      return upstream(input as never, init);
    }) as typeof fetch;

    // Boot with NO cache (generatedModel null — harness default).
    const root = await mountRepoGraph(); // no overrides → generatedModel null
    await tick();
    await tick();

    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    expect(genBtn).not.toBeNull();

    // Anti-vacuous: no-cache → default-tier button (not ghost, not accent).
    expect(genBtn!.classList.contains("rg-btn-ghost")).toBe(false);
    expect(genBtn!.classList.contains("rg-btn-accent")).toBe(false);

    // Click → direct fire (no modal for no-cache case).
    genBtn!.click();
    await tick();
    await tick();

    // Anti-vacuous: NO modal opened (proves direct-fire path, not modal path).
    expect(document.querySelector("[data-confirm-modal]")).toBeNull();

    // Anti-vacuous: POST body was captured (proves fetch spy is live).
    expect(capturedBody).not.toBeNull();

    // ── CHECKPOINT: no-cache fire must keep force:false.
    // `generatedPayload !== null` = `null !== null` = false → correct.
    expect(capturedBody!.force).toBe(false);

    globalThis.fetch = upstream;
  });
});
