// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * theme-toggle island — behaviour the e2e spec cannot reach.
 *
 * Written after an independent review demonstrated four surviving mutations
 * against the e2e suite alone: deleting the whole `storage` listener, deleting
 * the `matchMedia` listener and both `siltpoke:theme-changed` dispatches,
 * breaking `icon`/`label`, and deleting `apply()` from `init()`. Each is
 * either invisible to a single-page browser test or already masked by the
 * pre-paint script in layout.tsx. Every one of them is pinned here.
 *
 * The e2e spec keeps what only a browser can prove — that the CSS actually
 * repaints and that the choice survives a reload and an hx-boost navigation.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./_dom-harness";
import {
  iconFor,
  labelFor,
  normalizeTheme,
  THEME_CHANGED,
  THEME_KEY,
  THEME_ORDER,
  type ThemeState,
} from "../../../../src/web/_shared/theme-state";

// PER-FILE SCOPE, via the shared harness — see its docstring. Registering
// happy-dom at module top level (as an earlier draft of this file did) breaks
// sibling island suites: `bun test` runs every file in one process, so the
// next file's own registerDom() throws on an already-registered global.
// The island is imported LAZILY inside loadIsland() for the same reason — its
// module body wires window listeners, so it must not be evaluated before the
// DOM exists.
beforeAll(() => {
  registerDom();
});

afterAll(async () => {
  await unregisterDom();
});

type Instance = { state: ThemeState; init(): void; cycle(): void; icon: string; label: string };

/**
 * Imports the island fresh so its module-level listener registration runs
 * against the CURRENT happy-dom window, and returns the Alpine factory it
 * hands to `Alpine.data()`. A cache-busting query keeps each test's module
 * instance (and therefore its listeners) independent.
 */
async function loadIsland(): Promise<() => Instance> {
  let factory: (() => Instance) | null = null;
  const mod = await import(`../../../../src/web/client/islands/theme-toggle?t=${Math.random()}`);
  (mod as { registerThemeToggle: (a: { data: (n: string, f: () => unknown) => void }) => void }).registerThemeToggle({
    data: (_name, f) => {
      factory = f as () => Instance;
    },
  });
  if (!factory) throw new Error("registerThemeToggle did not register a factory");
  return factory;
}

async function mount(): Promise<Instance> {
  const instance = (await loadIsland())();
  instance.init();
  return instance;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme vocabulary (shared with SSR)", () => {
  test("an unrecognised stored value normalises to system, not to itself", () => {
    // The pre-paint script in layout.tsx makes the same decision. If these two
    // ever disagree the page paints one theme and the toggle reports another.
    for (const junk of ["", "DARK", "sepia", "null", "0", null]) {
      expect(normalizeTheme(junk)).toBe("system");
    }
    expect(normalizeTheme("dark")).toBe("dark");
    expect(normalizeTheme("light")).toBe("light");
  });

  test("every state has a distinct glyph and a distinct label", () => {
    const icons = THEME_ORDER.map(iconFor);
    const labels = THEME_ORDER.map(labelFor);
    expect(new Set(icons).size).toBe(3);
    expect(new Set(labels).size).toBe(3);
    expect(icons.every((i) => i.length > 0)).toBe(true);
    expect(labels.every((l) => l.length > 0)).toBe(true);
  });

  test("the cycle order is system -> light -> dark", () => {
    expect([...THEME_ORDER]).toEqual(["system", "light", "dark"]);
  });
});

describe("theme-toggle island", () => {
  test("init adopts the persisted choice and stamps it on <html>", async () => {
    localStorage.setItem(THEME_KEY, "dark");
    const t = await mount();
    expect(t.state).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("init on a system choice leaves NO attribute for the media query to fight", async () => {
    document.documentElement.setAttribute("data-theme", "dark"); // stale from a previous page
    const t = await mount();
    expect(t.state).toBe("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("cycle walks system -> light -> dark -> system, persisting and clearing", async () => {
    const t = await mount();
    expect(t.state).toBe("system");

    t.cycle();
    expect(t.state).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    t.cycle();
    expect(t.state).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    t.cycle();
    expect(t.state).toBe("system");
    // Back to system must REMOVE the key, not write the string "system" —
    // layout.tsx's pre-paint script treats any unrecognised value as system,
    // so writing it would still work but would leave the key permanently set.
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("icon and label track the state through a full cycle", async () => {
    const t = await mount();
    const seen: Array<[string, string]> = [];
    for (let i = 0; i < 3; i++) {
      seen.push([t.icon, t.label]);
      t.cycle();
    }
    expect(seen).toEqual([
      [iconFor("system"), labelFor("system")],
      [iconFor("light"), labelFor("light")],
      [iconFor("dark"), labelFor("dark")],
    ]);
  });

  test("cycle broadcasts the theme-changed event", async () => {
    const t = await mount();
    let fired = 0;
    window.addEventListener(THEME_CHANGED, () => {
      fired++;
    });
    t.cycle();
    expect(fired).toBe(1);
  });

  test("another tab writing the key re-applies the theme in THIS tab", async () => {
    // The single behaviour a one-page browser test cannot reach, and the one
    // the reviewer could delete wholesale with the e2e suite still green.
    await mount();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

    let broadcasts = 0;
    window.addEventListener(THEME_CHANGED, () => {
      broadcasts++;
    });

    localStorage.setItem(THEME_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    // Applying the attribute is not enough: values JS read once via
    // readColor() and cached are stale until the broadcast tells them to
    // re-read. Without this assertion the whole dispatch can be deleted and
    // every other test stays green.
    expect(broadcasts).toBeGreaterThanOrEqual(1);

    localStorage.removeItem(THEME_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: null }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("an unrelated storage key is ignored", async () => {
    await mount();
    localStorage.setItem(THEME_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "siltpokeSidebarCollapsed", newValue: "1" }));
    // The guard must return early — not opportunistically re-read and apply.
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("an OS theme flip broadcasts ONLY while we are following the system", async () => {
    // matchMedia change cannot be fired for real in happy-dom, so capture the
    // handler the island registers and invoke it. Without this the entire
    // matchMedia listener is deletable with every other test still green.
    const realMatchMedia = window.matchMedia;
    let onChange: (() => void) | null = null;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_type: string, handler: () => void) => {
        onChange = handler;
      },
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

    try {
      const factory = await loadIsland();
      const t = factory();
      t.init();
      expect(onChange).not.toBeNull();

      let broadcasts = 0;
      window.addEventListener(THEME_CHANGED, () => {
        broadcasts++;
      });

      // Following the system: an OS flip must invalidate cached JS colors.
      (onChange as unknown as () => void)();
      expect(broadcasts).toBe(1);

      // Forced to a theme: an OS flip changes nothing we render, so staying
      // silent is the point — a broadcast here would re-render for no reason.
      t.cycle(); // -> light, and cycle() broadcasts once itself
      const afterForce = broadcasts;
      (onChange as unknown as () => void)();
      expect(broadcasts).toBe(afterForce);
    } finally {
      window.matchMedia = realMatchMedia;
      localStorage.removeItem(THEME_KEY);
      document.documentElement.removeAttribute("data-theme");
    }
  });

  test("the document listeners are registered ONCE per module, not per component", async () => {
    // Regression guard for a MEASURED leak: the listeners used to live in
    // init(), which re-runs on every hx-boost navigation, so they accumulated
    // without bound (storage:1 -> 3 -> 6 across three navigations), each dead
    // closure pinning a discarded Alpine proxy. Count registrations directly
    // rather than counting fired events — the module-per-test import in this
    // file means other tests' modules are also listening on this window, so an
    // event count would measure the harness, not the island.
    const realAdd = window.addEventListener.bind(window);
    const counts = new Map<string, number>();
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      counts.set(type, (counts.get(type) ?? 0) + 1);
      return (realAdd as (t: string, ...r: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;

    try {
      const factory = await loadIsland(); // module body runs -> listeners wired
      const afterLoad = counts.get("storage") ?? 0;
      for (let i = 0; i < 4; i++) factory().init(); // four "navigations"
      expect(counts.get("storage") ?? 0).toBe(afterLoad);
      expect(afterLoad).toBe(1);
    } finally {
      window.addEventListener = realAdd;
    }
  });
});
