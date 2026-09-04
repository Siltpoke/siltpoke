// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * confirm-modal — imperative Promise-based confirmation dialog (first modal
 * primitive in the codebase; this file is the template for future modals).
 *
 * Usage:
 *   const confirmed = await confirmModal({
 *     title: "Re-generate diagram?",
 *     bodyLines: ["Diagram is outdated."],
 *     confirmLabel: "Re-generate",
 *   });
 *
 * Design notes:
 * - Build-on-open / remove-on-close: the overlay is created fresh per call and
 *   removed immediately on close. No SSR skeleton dependency — the primitive is
 *   self-contained and usable from any surface.
 * - Cancel is the visual default and receives focus on open.
 * - All close paths (Cancel click / Escape / backdrop click) resolve false.
 *   Confirm click resolves true.
 * - Single-resolution guard: a `resolved` flag prevents any double-settle.
 * - textContent only: caller-supplied strings never touch innerHTML.
 * - a11y: role="dialog", aria-modal="true", aria-labelledby wired to the title.
 * - Focus trap: Tab / Shift+Tab cycle within the dialog.
 *   (Implementation note: happy-dom does not model native tab-order, so Tab
 *   cycling is wired via keydown listener; focus() calls are still testable.)
 * - Scroll-lock: document.body.style.overflow = "hidden" while open, restored
 *   to the pre-open value on close.
 * - Stacked modals: unsupported pattern — each modal registers its own keydown
 *   listener, so Escape closes ALL open modals simultaneously. Callers must not
 *   stack confirmModal calls without awaiting resolution of the first.
 * - Styles injected once (idempotent) into <head> on first call.
 */
import { tokens } from "../../tokens/tokens";

export interface ConfirmModalOpts {
  title: string;
  bodyLines: string[];
  cancelLabel?: string;
  confirmLabel: string;
}

// ── Style injection ────────────────────────────────────────────────────────

const STYLE_ID = "confirm-modal-styles";

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Scoped under [data-confirm-modal] to avoid colliding with .rg-host tokens.
  // Every color below is a `tokens.color.X`/`tokens.shadow.X` PROPERTY
  // ACCESS interpolated into the template, not a hand-written `var(--color-
  // X)` string — a typo here is a compile error, not a silent no-op (the
  // brief's own island-import rule, Task 10b batch 3 review round 1,
  // Important 1). The overlay backdrop uses `tokens.shadow.scrim`, the SAME
  // token MemoryModal.tsx / FloatingChat.tsx already use (Task 10b batch 1
  // fix round, Important 3) — completing the 3-way modal-backdrop
  // consolidation the classification flagged (this file's old `.45` is now
  // the shared scrim's `.42`, a value delta of 0.03). The dialog's own
  // box-shadow is `tokens.shadow.lg` — a physical drop shadow under the
  // panel, not ink-derived (the ink-polarity rule: shadows simulate fixed
  // real-world depth and must NOT flip to near-white in dark mode).
  style.textContent = `
[data-confirm-modal]{
  position:fixed;inset:0;z-index:9000;
  display:flex;align-items:center;justify-content:center;
  background:${tokens.shadow.scrim};
}
[data-confirm-modal] .cm-dialog{
  background:${tokens.color.cream};border:1px solid ${tokens.color.edge};border-radius:10px;
  box-shadow:${tokens.shadow.lg};
  padding:24px 28px 20px;min-width:320px;max-width:480px;width:100%;
  font-family:"Geist",system-ui,sans-serif;font-size:14px;color:${tokens.color.ink};
}
[data-confirm-modal] .cm-title{
  font-size:16px;font-weight:600;margin:0 0 12px;letter-spacing:-.2px;
}
[data-confirm-modal] .cm-body{
  color:${tokens.color.ink2};margin:0 0 20px;display:flex;flex-direction:column;gap:4px;
}
[data-confirm-modal] .cm-body p{margin:0;line-height:1.5;}
[data-confirm-modal] .cm-actions{
  display:flex;align-items:center;justify-content:flex-end;gap:8px;
}
[data-confirm-modal] .cm-cancel{
  font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;
  background:${tokens.color.cream};border:1px solid ${tokens.color.edge};border-radius:6px;
  padding:7px 14px;color:${tokens.color.ink};
}
[data-confirm-modal] .cm-cancel:hover{background:${tokens.color.paper};border-color:${tokens.color.ink3};}
[data-confirm-modal] .cm-confirm{
  font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;
  background:${tokens.color.ink};border:1px solid ${tokens.color.ink};border-radius:6px;
  padding:7px 14px;color:${tokens.color.cream};
}
[data-confirm-modal] .cm-confirm:hover{filter:brightness(1.15);}
[data-confirm-modal] .cm-confirm:disabled{opacity:.6;cursor:default;}
[data-confirm-modal] .cm-cancel:focus-visible{outline:2px solid ${tokens.color.ink3};outline-offset:2px;}
[data-confirm-modal] .cm-confirm:focus-visible{outline:2px solid ${tokens.color.cream};outline-offset:2px;}
`.trim();
  document.head.appendChild(style);
}

// ── DOM builder ────────────────────────────────────────────────────────────

function buildOverlay(
  opts: ConfirmModalOpts,
  titleId: string,
): { overlay: HTMLElement; cancelBtn: HTMLButtonElement; confirmBtn: HTMLButtonElement } {
  const overlay = document.createElement("div");
  const bodyId = `cm-body-${titleId.replace("cm-title-", "")}`;
  overlay.setAttribute("data-confirm-modal", "");

  const dialog = document.createElement("div");
  dialog.className = "cm-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.setAttribute("aria-describedby", bodyId);

  // Title
  const titleEl = document.createElement("h2");
  titleEl.className = "cm-title";
  titleEl.id = titleId;
  titleEl.setAttribute("data-modal-title", "");
  titleEl.textContent = opts.title;

  // Body
  const bodyEl = document.createElement("div");
  bodyEl.className = "cm-body";
  bodyEl.setAttribute("data-modal-body", "");
  bodyEl.id = bodyId;
  for (const line of opts.bodyLines) {
    const p = document.createElement("p");
    p.textContent = line; // textContent only — never innerHTML
    bodyEl.appendChild(p);
  }

  // Actions
  const actions = document.createElement("div");
  actions.className = "cm-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "cm-cancel";
  cancelBtn.setAttribute("data-cancel-btn", "");
  cancelBtn.type = "button";
  cancelBtn.textContent = opts.cancelLabel ?? "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "cm-confirm";
  confirmBtn.setAttribute("data-confirm-btn", "");
  confirmBtn.type = "button";
  confirmBtn.textContent = opts.confirmLabel;

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);

  dialog.appendChild(titleEl);
  dialog.appendChild(bodyEl);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);

  return { overlay, cancelBtn, confirmBtn };
}

// ── Focus trap ─────────────────────────────────────────────────────────────

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  );
}

// ── Main export ────────────────────────────────────────────────────────────

let _modalSeq = 0;
let _lockCount = 0;
let _savedOverflow = "";

export function confirmModal(opts: ConfirmModalOpts): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    ensureStyles();

    const titleId = `cm-title-${++_modalSeq}`;
    const { overlay, cancelBtn, confirmBtn } = buildOverlay(opts, titleId);

    let resolved = false;
    if (_lockCount === 0) _savedOverflow = document.body.style.overflow;
    _lockCount++;
    const prevFocus = document.activeElement as HTMLElement | null;

    function closeWith(value: boolean): void {
      if (resolved) return;
      resolved = true;

      // Remove event listeners
      document.removeEventListener("keydown", onKeydown);
      overlay.removeEventListener("click", onBackdropClick);

      // Tear down overlay
      overlay.remove();

      // Restore scroll lock + focus
      _lockCount--;
      if (_lockCount === 0) document.body.style.overflow = _savedOverflow;
      prevFocus?.focus();

      resolve(value);
    }

    // Cancel paths
    cancelBtn.addEventListener("click", () => closeWith(false));

    // Confirm path
    confirmBtn.addEventListener("click", () => closeWith(true));

    // Backdrop click — only when the click target IS the overlay backdrop itself
    function onBackdropClick(evt: MouseEvent): void {
      if (evt.target === overlay) closeWith(false);
    }
    overlay.addEventListener("click", onBackdropClick);

    // Escape key
    function onKeydown(evt: KeyboardEvent): void {
      if (evt.key === "Escape") {
        evt.preventDefault();
        closeWith(false);
        return;
      }

      // Focus trap: Tab / Shift+Tab cycle within the dialog
      if (evt.key === "Tab") {
        const dialogEl = overlay.querySelector<HTMLElement>(".cm-dialog") ?? overlay;
        const focusable = getFocusable(dialogEl);
        if (focusable.length === 0) {
          evt.preventDefault();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (evt.shiftKey) {
          if (document.activeElement === first) {
            evt.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            evt.preventDefault();
            first.focus();
          }
        }
      }
    }
    document.addEventListener("keydown", onKeydown);

    // Append, lock scroll, focus cancel
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    cancelBtn.focus();
  });
}
