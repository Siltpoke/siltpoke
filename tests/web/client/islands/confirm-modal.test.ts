/**
 * confirm-modal island unit tests.
 *
 * Uses the happy-dom harness (GlobalRegistrator) for a real document.body.
 * The modal is an imperative API: `confirmModal(opts): Promise<boolean>`.
 *
 * Focus-trap Tab-cycle semantics are NOT tested — happy-dom does not implement
 * the browser's native tab-order algorithm. `document.activeElement` assignment
 * on open IS tested (the modal explicitly calls `.focus()` on the Cancel button).
 *
 * Scroll-lock: tested via `document.body.style.overflow`.
 *
 * DOM cleanup: tested by querying for the overlay element post-close.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const realFetch = globalThis.fetch;

function registerDom(): void {
  GlobalRegistrator.register({ url: "http://127.0.0.1:9876/repo-graph" });
}

async function unregisterDom(): Promise<void> {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
}

// ── import helper — dynamic so it evaluates AFTER registerDom() ────────────

async function importModal() {
  // Force fresh import per test suite (bun module cache is process-scoped;
  // the island has no side-effects at module level so re-import is safe).
  const mod = await import("../../../../src/web/client/islands/confirm-modal");
  return mod.confirmModal;
}

// ── helpers ────────────────────────────────────────────────────────────────

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function getOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-confirm-modal]");
}

// ── lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => {
  registerDom();
});

afterAll(async () => {
  await unregisterDom();
});

afterEach(() => {
  // Clean up any leaked overlay from a failed/stalled test.
  getOverlay()?.remove();
  document.body.style.overflow = "";
});

// ── tests ──────────────────────────────────────────────────────────────────

describe("confirmModal — basic resolution", () => {
  test("resolves true on confirm button click", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "Test", bodyLines: ["Line 1"], confirmLabel: "Go" });

    await tick(); // let any microtasks settle (modal appended synchronously, but be safe)

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn).not.toBeNull();
    confirmBtn!.click();

    const result = await p;
    expect(result).toBe(true);
  });

  test("resolves false on cancel button click", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "Test", bodyLines: [], confirmLabel: "OK" });
    await tick();

    const cancelBtn = getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]");
    expect(cancelBtn).not.toBeNull();
    cancelBtn!.click();

    expect(await p).toBe(false);
  });

  test("resolves false on Escape keydown", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "Esc test", bodyLines: [], confirmLabel: "OK" });
    await tick();

    expect(getOverlay()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    expect(await p).toBe(false);
  });

  test("resolves false on backdrop click", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "Backdrop", bodyLines: [], confirmLabel: "OK" });
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    // Click the overlay element itself (the backdrop), not the dialog box inside it.
    overlay!.click();
    await tick();

    expect(await p).toBe(false);
  });
});

describe("confirmModal — single-resolution guarantee", () => {
  test("listener removed after close: second Escape dispatch is a no-op", async () => {
    // What this proves: closeWith() removes the document keydown listener on first
    // close, so a subsequent Escape dispatch never reaches the handler at all.
    // This verifies listener cleanup — not the resolved guard itself.
    const confirmModal = await importModal();
    const results: boolean[] = [];
    const p = confirmModal({ title: "Double-close", bodyLines: [], confirmLabel: "OK" });
    p.then((v) => results.push(v));
    await tick();

    // First close: Escape — this resolves the promise AND removes the listener.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    // Second Escape dispatch — listener is already removed, so this is a true no-op.
    // The test proves the promise still resolves to exactly one value.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    const result = await p;
    expect(result).toBe(false);
    // Only one resolution; results array has exactly 1 entry (accumulated before await).
    expect(results.length).toBe(1);
  });

  test("resolved guard: sync cancel+confirm click resolves exactly once to false", async () => {
    // Genuine resolved-guard exercise: both cancelBtn and confirmBtn handlers run
    // synchronously back-to-back. cancelBtn.click() → closeWith(false) → sets
    // resolved = true, tears down overlay. confirmBtn.click() in the SAME tick →
    // closeWith(true) → hits `if (resolved) return` immediately. Promise must
    // resolve exactly once, to false (first click wins).
    const confirmModal = await importModal();
    const results: boolean[] = [];
    const p = confirmModal({ title: "Guard test", bodyLines: [], confirmLabel: "OK" });
    p.then((v) => results.push(v));
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();
    const cancelBtn = overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]");
    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(cancelBtn).not.toBeNull();
    expect(confirmBtn).not.toBeNull();

    // Fire both synchronously — no await between.
    cancelBtn!.click();
    confirmBtn!.click();

    await p;
    await tick();

    // Exactly one resolution, to false (cancel fired first).
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(false);
  });
});

describe("confirmModal — focus behaviour", () => {
  test("Cancel button receives focus on open", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "Focus", bodyLines: [], confirmLabel: "OK" });
    await tick();

    const overlay = getOverlay();
    const cancelBtn = overlay!.querySelector<HTMLButtonElement>("[data-cancel-btn]");
    expect(cancelBtn).not.toBeNull();

    // happy-dom assigns activeElement when .focus() is called.
    // We assert the cancel button is the active element.
    expect(document.activeElement).toBe(cancelBtn);

    // Clean up
    cancelBtn!.click();
    await p;
  });

  test("focus returns to the opener element after close", async () => {
    const confirmModal = await importModal();

    // Create an opener element and focus it.
    const opener = document.createElement("button");
    opener.textContent = "Open modal";
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const p = confirmModal({ title: "Focus return", bodyLines: [], confirmLabel: "OK" });
    await tick();

    // Close via cancel.
    getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await p;
    await tick();

    expect(document.activeElement).toBe(opener);

    // Cleanup
    opener.remove();
  });
});

describe("confirmModal — scroll-lock", () => {
  test("overflow hidden while open; exact pre-open value restored on close", async () => {
    // Use a sentinel value so we prove the exact pre-open value
    // is restored, not just that it is no longer "hidden".
    const confirmModal = await importModal();

    // Set a sentinel pre-open value.
    const sentinel = "auto";
    document.body.style.overflow = sentinel;

    const p = confirmModal({ title: "Lock", bodyLines: [], confirmLabel: "OK" });
    await tick();

    expect(document.body.style.overflow).toBe("hidden");

    getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await p;
    await tick();

    // Must restore exactly to the sentinel, not just "not hidden".
    expect(document.body.style.overflow).toBe(sentinel);

    // afterEach resets body.style.overflow — no manual cleanup needed.
  });
});

describe("confirmModal — content safety (XSS)", () => {
  test("bodyLine containing HTML renders as inert text (no element injected)", async () => {
    const confirmModal = await importModal();
    const xssLine = '<img src="x" onerror="window.__xss=true">';
    const p = confirmModal({ title: "XSS test", bodyLines: [xssLine], confirmLabel: "OK" });
    await tick();

    const overlay = getOverlay();
    expect(overlay).not.toBeNull();

    // No img element must exist inside the overlay.
    expect(overlay!.querySelector("img")).toBeNull();
    // The raw string must appear as text content somewhere in the body area.
    const bodyEl = overlay!.querySelector<HTMLElement>("[data-modal-body]");
    expect(bodyEl?.textContent).toContain('<img src="x"');

    // No XSS executed.
    expect((globalThis as Record<string, unknown>).__xss).toBeUndefined();

    getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await p;
  });
});

describe("confirmModal — concurrent calls", () => {
  test("two simultaneous modals are independent: closing first leaves second alive", async () => {
    // This primitive is declared the template for future modals;
    // concurrent-call semantics must be explicit. Each call is self-contained
    // (distinct overlay elements, distinct `resolved` closures, distinct
    // prevFocus/prevOverflow captures).
    const confirmModal = await importModal();

    // Open first modal.
    const p1 = confirmModal({ title: "Modal 1", bodyLines: [], confirmLabel: "Go1" });
    await tick();

    const overlay1 = getOverlay();
    expect(overlay1).not.toBeNull();

    // Open second modal before first is closed.
    const p2 = confirmModal({ title: "Modal 2", bodyLines: [], confirmLabel: "Go2" });
    await tick();

    // Both overlays are in the DOM (different [data-confirm-modal] elements).
    const allOverlays = document.querySelectorAll("[data-confirm-modal]");
    expect(allOverlays.length).toBe(2);

    // Close first via its own cancel button.
    overlay1!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    expect(await p1).toBe(false);
    await tick();

    // First overlay is gone; second is still present.
    const remaining = document.querySelectorAll("[data-confirm-modal]");
    expect(remaining.length).toBe(1);

    // Scroll-lock must still be active because second modal is still open.
    expect(document.body.style.overflow).toBe("hidden");

    // Second modal still resolves independently via confirm.
    remaining[0]!.querySelector<HTMLButtonElement>("[data-confirm-btn]")!.click();
    expect(await p2).toBe(true);
    await tick();

    // All cleaned up.
    expect(document.querySelectorAll("[data-confirm-modal]").length).toBe(0);

    // Scroll-lock must be fully released after all modals closed.
    expect(document.body.style.overflow).toBe("");
  });
});
describe("confirmModal — DOM cleanup", () => {
  test("overlay is removed from document.body after close", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "Cleanup", bodyLines: [], confirmLabel: "OK" });
    await tick();

    expect(getOverlay()).not.toBeNull();

    getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await p;
    await tick();

    expect(getOverlay()).toBeNull();
  });
});

describe("confirmModal — opts wiring", () => {
  test("title text is rendered via textContent (not innerHTML)", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "My Title", bodyLines: ["Body line"], confirmLabel: "Confirm it" });
    await tick();

    const overlay = getOverlay();
    const titleEl = overlay!.querySelector<HTMLElement>("[data-modal-title]");
    expect(titleEl).not.toBeNull();
    expect(titleEl!.textContent).toBe("My Title");

    const confirmBtn = overlay!.querySelector<HTMLButtonElement>("[data-confirm-btn]");
    expect(confirmBtn!.textContent).toBe("Confirm it");

    confirmBtn!.click();
    await p;
  });

  test("cancelLabel defaults to 'Cancel' when not provided", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "T", bodyLines: [], confirmLabel: "Go" });
    await tick();

    const cancelBtn = getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]");
    expect(cancelBtn!.textContent).toBe("Cancel");

    cancelBtn!.click();
    await p;
  });

  test("cancelLabel override is reflected on the cancel button", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "T", bodyLines: [], confirmLabel: "Go", cancelLabel: "Dismiss" });
    await tick();

    const cancelBtn = getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]");
    expect(cancelBtn!.textContent).toBe("Dismiss");

    cancelBtn!.click();
    await p;
  });

  test("a11y: dialog has role=dialog and aria-modal=true", async () => {
    const confirmModal = await importModal();
    const p = confirmModal({ title: "A11y", bodyLines: [], confirmLabel: "OK" });
    await tick();

    const overlay = getOverlay();
    const dialog = overlay!.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");

    // aria-labelledby points to the title element's id
    const titleId = dialog!.getAttribute("aria-labelledby");
    expect(titleId).not.toBeNull();
    const titleEl = document.getElementById(titleId!);
    expect(titleEl).not.toBeNull();
    expect(titleEl!.textContent).toBe("A11y");

    getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await p;
  });
});

describe("confirmModal — style injection", () => {
  test("injects style element exactly once across multiple modal opens", async () => {
    const confirmModal = await importModal();

    // Open and close first modal.
    const p1 = confirmModal({ title: "Style 1", bodyLines: [], confirmLabel: "OK" });
    await tick();
    getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await p1;

    // Open and close second modal.
    const p2 = confirmModal({ title: "Style 2", bodyLines: [], confirmLabel: "OK" });
    await tick();
    getOverlay()!.querySelector<HTMLButtonElement>("[data-cancel-btn]")!.click();
    await p2;

    // Only one style element with the canonical ID must exist.
    expect(document.querySelectorAll("style#confirm-modal-styles").length).toBe(1);
  });
});