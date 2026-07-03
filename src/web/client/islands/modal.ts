// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * modal — Linear-style peek modal with J/K navigation skeleton.
 *
 * Usage:
 *   <div x-data="modal"
 *        x-on:keydown.j.window="next"
 *        x-on:keydown.k.window="prev"
 *        x-on:keydown.escape.window="close">
 *     <template x-if="open">
 *       <!-- modal content; bind to `current()` for the active item -->
 *     </template>
 *   </div>
 *
 * `items` is populated by the host page before or after calling `show()`.
 * `cursor` wraps around at both ends.
 */

document.addEventListener("alpine:init", () => {
  globalThis.Alpine.data("modal", () => ({
    open: false,
    items: [] as unknown[],
    cursor: 0,
    show() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.cursor = 0;
    },
    next() {
      if (this.items.length === 0) return;
      this.cursor = (this.cursor + 1) % this.items.length;
    },
    prev() {
      if (this.items.length === 0) return;
      this.cursor = (this.cursor - 1 + this.items.length) % this.items.length;
    },
    current() {
      if (this.cursor >= this.items.length) this.cursor = 0;
      return this.items[this.cursor] ?? null;
    },
  }));
});
