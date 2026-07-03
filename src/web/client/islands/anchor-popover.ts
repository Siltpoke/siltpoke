// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// src/web/client/islands/anchor-popover.ts
// Anchored read-only "why" popover: build-on-open / remove-on-close.
// NOT confirm-modal (that is a confirmation flow w/ overlay); this anchors
// below a trigger with no blocking overlay.
//
// Consumed by: confidence popover + grounded popover.

export interface AnchorPopoverOpts {
  /** Chip button that opens the popover; receives aria-expanded toggle. */
  trigger: HTMLElement;
  /**
   * Pre-built inner HTML (callers own content — set via el.innerHTML).
   * IMPORTANT: callers are responsible for escaping/sanitizing any
   * user-controlled or LLM-generated data (e.g. ArchModelDoc claim text)
   * before interpolating it into this string. The primitive performs
   * NO sanitization.
   */
  contentHtml: string;
  /**
   * Width of the popover in pixels.
   * Single width knob — widen HERE only (contingency: never per-popover CSS forks).
   * Default: 320.
   */
  width?: number;
  /** Which edge to align to the trigger. Default: "left". */
  align?: "left" | "right";
  /**
   * Accessible name for the popover (role="region" requires one to be
   * announced usefully by assistive tech). Pass the popover's title text.
   */
  ariaLabel?: string;
}

export interface AnchorPopoverHandle {
  close(): void;
  el: HTMLElement;
}

const STYLE_ID = "anchor-popover-style";

// Module-level singleton: at most one open popover across the page.
// Closing one before opening another ensures callers don't juggle handles.
let current: { handle: AnchorPopoverHandle; trigger: HTMLElement } | null = null;

function injectStyle(): void {
  if (document.querySelector(`style[data-${STYLE_ID}]`)) return;
  const s = document.createElement("style");
  s.setAttribute(`data-${STYLE_ID}`, "");
  s.textContent = `
[data-anchor-popover]{
  position:absolute;top:calc(100% + 6px);z-index:60;
  background:var(--paper,#fffdf6);
  border:1px solid var(--edge,#d8d2c2);border-radius:8px;
  box-shadow:0 6px 24px rgba(0,0,0,.10);
  padding:12px 14px;font-size:12.5px;line-height:1.45;text-align:left;cursor:default;
}
[data-anchor-popover] .ap-formula{
  font-family:ui-monospace,Menlo,monospace;font-size:14px;font-weight:700;margin-bottom:2px;
}
[data-anchor-popover] .ap-def{
  color:var(--ink-soft,#6b6557);margin-bottom:8px;
}
[data-anchor-popover] .ap-row{margin:8px 0;}
[data-anchor-popover] .ap-row + .ap-def{margin-top:10px;}
[data-anchor-popover] .ap-epistemic{
  color:var(--ink-soft,#6b6557);
  border-top:1px dashed var(--edge,#d8d2c2);
  padding-top:8px;margin-top:8px;
}
`;
  document.head.appendChild(s);
}

export function openAnchorPopover(opts: AnchorPopoverOpts): AnchorPopoverHandle {
  // Single-instance guard: same trigger already open → return existing handle.
  if (current?.trigger === opts.trigger) return current.handle;

  // Close any previously open popover before opening a new one.
  current?.handle.close();

  injectStyle();

  const el = document.createElement("div");
  el.setAttribute("data-anchor-popover", "");
  el.setAttribute("role", "region");
  if (opts.ariaLabel) el.setAttribute("aria-label", opts.ariaLabel);
  el.style.width = `${opts.width ?? 320}px`;
  if ((opts.align ?? "left") === "right") {
    el.style.right = "0";
  } else {
    el.style.left = "0";
  }
  el.innerHTML = opts.contentHtml;

  // Anchor: append to trigger's parent so `position:absolute` is relative to it.
  // Ensure the host has a positioning context. Browsers report unpositioned
  // elements as "static"; happy-dom reports "" — treat both as unpositioned.
  // The mutation is REVERTED on close (leaving it behind
  // permanently changes the caller's layout context). We save/restore the
  // INLINE style.position value, which is safe because this primitive is a
  // singleton — at most one popover (and thus one pending restore) exists.
  // (try/catch: plan contingency for envs without getComputedStyle.)
  const host = opts.trigger.parentElement ?? document.body;
  let restoreHostPosition: (() => void) | null = null;
  try {
    const computed = getComputedStyle(host).position;
    if (computed === "static" || computed === "") {
      const prevInline = host.style.position;
      host.style.position = "relative";
      restoreHostPosition = () => {
        host.style.position = prevInline;
      };
    }
  } catch {
    // getComputedStyle unavailable in this environment — skip position guard.
  }
  host.appendChild(el);

  opts.trigger.setAttribute("aria-expanded", "true");

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  const onDown = (e: MouseEvent): void => {
    const t = e.target as Node;
    if (!el.contains(t) && t !== opts.trigger && !opts.trigger.contains(t)) close();
  };

  function close(): void {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onDown, true);
    el.remove();
    restoreHostPosition?.();
    restoreHostPosition = null;
    opts.trigger.setAttribute("aria-expanded", "false");
    opts.trigger.focus();
    if (current?.handle === handle) current = null;
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onDown, true);

  const handle: AnchorPopoverHandle = { close, el };
  current = { handle, trigger: opts.trigger };
  return handle;
}
