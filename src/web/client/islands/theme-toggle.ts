// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Three-state theme control: system -> light -> dark -> system.
 *
 * This island does NOT decide colors. All four theme states resolve in CSS
 * (src/web/tokens/tokens.css); the only job here is stamping `data-theme` on
 * <html> and persisting the choice.
 */
import {
  iconFor,
  labelFor,
  normalizeTheme,
  THEME_CHANGED,
  THEME_KEY as KEY,
  THEME_ORDER as ORDER,
  type ThemeState,
} from "../../_shared/theme-state";

export function read(): ThemeState {
  try {
    return normalizeTheme(localStorage.getItem(KEY));
  } catch {
    return "system";
  }
}

export function apply(state: ThemeState): void {
  // `system` removes the attribute so the media query governs. Removing rather
  // than leaving a stale value is what makes the storage listener correct when
  // ANOTHER tab resets to `system`.
  if (state === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", state);
}

/**
 * Explicit return shape for the Alpine.data() factory. Needed (not just
 * decorative) because `registerThemeToggle`'s Alpine param is deliberately
 * narrow (`() => unknown`, so a DOM-mount test can pass a bare stub without
 * pulling in the real alpinejs types — same shape as since-you-looked.ts's
 * AlpineLike). Against that narrow signature TypeScript cannot fall back to
 * the "this = the containing object literal" contextual-typing trick,  so
 * every `this.state` read/write below would resolve to `{}` and fail to
 * compile. An explicit `const data: ThemeToggleData = {...}` annotation on
 * the object literal itself sidesteps that — same fix since-you-looked.ts
 * already uses for its `self: SinceYouLookedData` factory.
 */
interface ThemeToggleData {
  state: ThemeState;
  init(): void;
  cycle(): void;
  readonly icon: string;
  readonly label: string;
}

/**
 * Document-level listeners, wired ONCE at module load rather than per
 * component instance.
 *
 * They were originally inside `init()`, on the assumption (stated in a comment
 * there) that alpine-morph would morph nodes across an hx-boost body swap so
 * `init()` might not re-run. Review measured the opposite: `init()` runs on
 * EVERY boosted navigation and neither listener was ever removed, so they
 * accumulated without bound —
 *
 *     initial load        storage:1 mql:1
 *     boost -> a retired surface-log  storage:3 mql:3
 *     boost -> repo-graph storage:6 mql:6
 *
 * — each dead closure pinning a discarded Alpine proxy. Alpine's `destroy()`
 * does not fire in this app either, so the usual per-component teardown idiom
 * would have been a no-op.
 *
 * Neither listener needs a component instance: `apply()` and `read()` are
 * document-global, and a component picks the state up in its own `init()`,
 * which re-reads anyway. Module scope also makes this correct in BOTH worlds —
 * it does not regress if alpine-morph is ever actually made to load (today it
 * is not: layout.tsx pins htmx-ext-alpine-morph@2.0.4, which does not exist on
 * npm — latest is 2.0.2 — so the extension 404s and every boost destroys and
 * recreates all Alpine state; captured separately, out of this track's scope).
 */
if (typeof window !== "undefined") {
  // Multi-tab sync: another tab changed the choice.
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== KEY) return;
    apply(read());
    window.dispatchEvent(new CustomEvent(THEME_CHANGED));
  });

  // Only needed to invalidate values JS read via readColor() and cached; CSS
  // -driven colors re-evaluate on their own.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (read() === "system") window.dispatchEvent(new CustomEvent(THEME_CHANGED));
  });
}

export function registerThemeToggle(Alpine: { data: (n: string, f: () => unknown) => void }): void {
  Alpine.data("themeToggle", () => {
    const data: ThemeToggleData = {
      state: "system",

      init() {
        // Re-read on every init: this runs again after every hx-boost
        // navigation. It must stay cheap and side-effect-free beyond applying
        // the already-persisted choice — the document-level listeners above
        // are deliberately NOT registered here (see their docstring).
        this.state = read();
        apply(this.state);
      },

      cycle() {
        const next = ORDER[(ORDER.indexOf(this.state) + 1) % ORDER.length] as ThemeState;
        this.state = next;
        try {
          if (next === "system") localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, next);
        } catch {
          // Private-mode / storage-disabled: the theme still applies for this page.
        }
        apply(next);
        window.dispatchEvent(new CustomEvent(THEME_CHANGED));
      },

      get icon(): string {
        return iconFor(this.state);
      },

      get label(): string {
        return labelFor(this.state);
      },
    };
    return data;
  });
}

// ── Registration ──────────────────────────────────────────────────────────
// Self-registers on alpine:init, matching since-you-looked.ts /
// repo-graph.ts's pattern (an exported registerX function so a DOM-mount
// test can capture the factory directly, plus a guard that calls it once
// Alpine is on globalThis). index.ts wires this in via a plain side-effect
// import, same as every other island.

if (typeof document !== "undefined") {
  document.addEventListener("alpine:init", () => {
    const Alpine = (globalThis as { Alpine?: { data: (n: string, f: () => unknown) => void } }).Alpine;
    if (Alpine) registerThemeToggle(Alpine);
  });
}
