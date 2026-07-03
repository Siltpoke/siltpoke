/**
 * anchor-popover primitive unit tests.
 *
 * Uses the happy-dom harness (GlobalRegistrator) for a real document/window.
 * Pattern mirrors confirm-modal.test.ts: self-contained register/unregister,
 * no _dom-harness import (avoids pulling in RepoGraphScreenProps types).
 *
 * focus() + document.activeElement: happy-dom honors .focus() and updates
 * activeElement — confirm-modal.test.ts precedent (lines 193-198).
 *
 * getComputedStyle: happy-dom supports it; the implementation guards with
 * try/catch per plan contingency note.
 *
 * CRITICAL: afterEach MUST clean document.body and close any open popover.
 * The `current` module-level var in anchor-popover.ts persists across tests
 * in the same Bun process (module cache). Failure to reset poisons later tests.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { openAnchorPopover, type AnchorPopoverHandle } from "../../../../src/web/client/islands/anchor-popover";

const realFetch = globalThis.fetch;

function registerDom(): void {
  GlobalRegistrator.register({ url: "http://127.0.0.1:9876/repo-graph" });
}

async function unregisterDom(): Promise<void> {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
}

// Settle microtasks / event queue
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function getPopover(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-anchor-popover]");
}

beforeAll(() => {
  registerDom();
});

afterAll(async () => {
  await unregisterDom();
});

afterEach(async () => {
  // Close any open popover + nuke stale DOM so tests are fully isolated.
  getPopover()?.remove();
  document.body.innerHTML = "";
  document.head.querySelectorAll("style[data-anchor-popover-style]").forEach((s) => s.remove());
  await tick();
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeTrigger(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = "chip";
  document.body.appendChild(btn);
  return btn;
}

// ── Test 1: open mounts + aria-expanded + content ─────────────────────────

describe("anchor-popover", () => {
  test("open mounts [data-anchor-popover], sets aria-expanded=true, renders content", () => {
    const trigger = makeTrigger();

    const handle = openAnchorPopover({
      trigger,
      contentHtml: '<p class="ap-formula">3,192 ÷ 4,186 = 76%</p>',
    });

    // Popover element is in the DOM
    const pop = getPopover();
    expect(pop).not.toBeNull();
    expect(pop!.getAttribute("data-anchor-popover")).toBe("");

    // aria-expanded toggled on trigger
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // Content HTML was injected
    expect(pop!.querySelector(".ap-formula")).not.toBeNull();
    expect(pop!.textContent).toContain("3,192 ÷ 4,186 = 76%");

    // handle.el reference matches the DOM element
    expect(pop).not.toBeNull();
    expect(handle.el).toBe(pop!);

    handle.close();
  });

  // ── role="region" needs an accessible name (review round-2, a11y) ────────
  test("ariaLabel option sets aria-label; omitted → no aria-label attr", () => {
    const trigger = makeTrigger();
    const handle = openAnchorPopover({
      trigger,
      contentHtml: "<b>WHY THIS PATH IS TRUSTWORTHY</b>",
      ariaLabel: "WHY THIS PATH IS TRUSTWORTHY",
    });
    expect(handle.el.getAttribute("role")).toBe("region");
    expect(handle.el.getAttribute("aria-label")).toBe("WHY THIS PATH IS TRUSTWORTHY");
    handle.close();

    const handle2 = openAnchorPopover({ trigger, contentHtml: "<b>x</b>" });
    expect(handle2.el.getAttribute("aria-label")).toBeNull();
    handle2.close();
  });

  // ── Test 2: Escape closes, focus returns to trigger ─────────────────────

  test("Escape keydown closes popover and returns focus to trigger", async () => {
    const trigger = makeTrigger();
    trigger.focus();
    // Confirm focus is on trigger before opening
    expect(document.activeElement).toBe(trigger);

    const handle = openAnchorPopover({ trigger, contentHtml: "<span>hello</span>" });
    expect(getPopover()).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();

    // Popover removed from DOM
    expect(getPopover()).toBeNull();

    // aria-expanded reset to false
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // Focus returned to trigger
    // NOTE: happy-dom honors .focus() calls and assigns document.activeElement.
    expect(document.activeElement).toBe(trigger);

    // handle is now a no-op (safe to call close again)
    handle.close();
  });

  // ── Test 3: outside click closes, inside click survives ─────────────────

  test("mousedown outside closes; mousedown inside does not", async () => {
    const trigger = makeTrigger();
    openAnchorPopover({ trigger, contentHtml: "<span>inner</span>" });
    expect(getPopover()).not.toBeNull();

    // Click inside the popover — must NOT close
    const pop = getPopover()!;
    pop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await tick();
    expect(getPopover()).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // Click outside (on document.body directly, not the trigger or popover)
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await tick();

    expect(getPopover()).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  // ── Test 4: double open is single-instance ────────────────────────────────

  test("calling open() while already open returns same handle (single-instance guard)", () => {
    const trigger = makeTrigger();

    const h1 = openAnchorPopover({ trigger, contentHtml: "<span>first</span>" });
    expect(getPopover()).not.toBeNull();

    // Second call with same trigger
    const h2 = openAnchorPopover({ trigger, contentHtml: "<span>second</span>" });

    // Must be the SAME handle object
    expect(h2).toBe(h1);

    // Must still be exactly one popover in the DOM
    expect(document.querySelectorAll("[data-anchor-popover]").length).toBe(1);

    // Content must be the ORIGINAL (first open wins)
    expect(getPopover()!.textContent).toContain("first");

    h1.close();
  });

  // ── Test 5: style injection idempotent ────────────────────────────────────

  test("opening twice injects style element exactly once", () => {
    const trigger1 = makeTrigger();
    const trigger2 = document.createElement("button");
    document.body.appendChild(trigger2);

    const h1 = openAnchorPopover({ trigger: trigger1, contentHtml: "<span>a</span>" });
    h1.close();

    // afterEach would clean the style, but we're testing within one test:
    // open a *second* popover (different trigger — so it opens fresh)
    const h2 = openAnchorPopover({ trigger: trigger2, contentHtml: "<span>b</span>" });

    // Exactly one <style data-anchor-popover-style> in head
    const styles = document.head.querySelectorAll("style[data-anchor-popover-style]");
    expect(styles.length).toBe(1);

    h2.close();
  });

  // ── Review round-1 fix: host position mutation must be reverted ──────────

  test("host position:relative mutation is reverted on close (inline value restored)", () => {
    // The primitive sets host.style.position="relative" when the trigger's
    // parent computes as static, so the absolute popover anchors to it.
    // Review finding: leaving that mutation behind permanently changes the
    // caller's layout context. close() must restore the exact prior INLINE value.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const trigger = document.createElement("button");
    host.appendChild(trigger);
    expect(host.style.position).toBe(""); // pre-open inline value (sentinel: empty)

    const handle = openAnchorPopover({ trigger, contentHtml: "<span>x</span>" });
    expect(host.style.position).toBe("relative"); // mutated while open

    handle.close();
    expect(host.style.position).toBe(""); // exact inline value restored
  });

  test("host with pre-existing non-static position is never mutated", () => {
    const host = document.createElement("div");
    host.style.position = "sticky"; // non-static: primitive must not touch it
    document.body.appendChild(host);
    const trigger = document.createElement("button");
    host.appendChild(trigger);

    const handle = openAnchorPopover({ trigger, contentHtml: "<span>x</span>" });
    expect(host.style.position).toBe("sticky");
    handle.close();
    expect(host.style.position).toBe("sticky");
  });

  // ── Test 6: close() removes node from DOM ────────────────────────────────

  test("close() removes the popover element from the DOM (no display:none residue)", () => {
    const trigger = makeTrigger();
    const handle = openAnchorPopover({ trigger, contentHtml: "<span>bye</span>" });

    expect(getPopover()).not.toBeNull();

    handle.close();

    // Element is GONE — not hidden, not display:none
    expect(getPopover()).toBeNull();
    expect(document.querySelector("[data-anchor-popover]")).toBeNull();

    // aria-expanded is false
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
