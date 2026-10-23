// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Keyboard focus for an Alpine-driven modal window: Tab and Shift+Tab stay
 * inside it while it is open.
 *
 * The Change-model window (Settings) left focus on the page behind it, so Tab
 * walked the hidden page and a screen reader never entered the window (small
 * item [7] of the chat mainline, 2026-10-15). `confirm-modal.ts` has its own
 * trap for the dialogs it builds; this one is for markup Alpine shows and hides.
 */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** The elements Tab can reach inside `root`, skipping ones x-show has hidden. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * On Tab at the last element, go to the first; on Shift+Tab at the first (or
 * at the window itself), go to the last. Any other key is left alone.
 */
export function keepTabInside(e: KeyboardEvent, root: HTMLElement): void {
  if (e.key !== "Tab") return;
  const items = focusableIn(root);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const at = root.ownerDocument.activeElement;
  if (!at || !root.contains(at)) {
    e.preventDefault();
    (e.shiftKey ? last : first)?.focus();
  } else if (e.shiftKey && (at === first || at === root)) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first?.focus();
  }
}
