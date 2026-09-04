// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The favicon scheme script — the half of the tab icon that no other test can
 * see.
 *
 * Written after the first implementation shipped green. It put both glyph
 * variants inside one SVG favicon and picked between them with
 * `@media (prefers-color-scheme: dark)`. Chrome rasterises a favicon SVG
 * WITHOUT applying its stylesheet, so both images drew and the last one won: a
 * white cat on a white tab bar, permanently, in light mode. Every assertion
 * about the served file passed — the file was correct. The icon is painted in
 * browser chrome, which no screenshot and no e2e assertion can read.
 *
 * The rewrite moved the choice into `matchMedia`, which IS reachable. What is
 * pinned here is exactly that reachable part: which href the script installs
 * for each scheme, and that it re-runs when the scheme changes. Whether the
 * browser then paints the file it was handed remains outside any test we can
 * write, and is why the two variants are separate single-colour files rather
 * than one conditional asset.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "../client/islands/_dom-harness";
import {
  FAVICON_DARK_HREF,
  FAVICON_LIGHT_HREF,
  FAVICON_SCHEME_SCRIPT,
} from "../../../src/web/_shared/brand-icons";

// PER-FILE SCOPE, via the shared harness — see its docstring.
beforeAll(() => registerDom());
afterAll(async () => {
  await unregisterDom();
});

/** A `matchMedia` stub: happy-dom cannot be told what colour scheme to report. */
function stubMatchMedia(dark: boolean): { fire: (nowDark: boolean) => void; calls: string[] } {
  const listeners: Array<() => void> = [];
  const calls: string[] = [];
  const mql = {
    matches: dark,
    addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
  };
  (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => {
    calls.push(q);
    return mql;
  };
  return {
    fire: (nowDark: boolean) => {
      mql.matches = nowDark;
      for (const fn of listeners) fn();
    },
    calls,
  };
}

function installedHref(): string | undefined {
  const links = Array.from(document.querySelectorAll('link[rel="icon"]'));
  // More than one would mean the script appended without removing, and the
  // browser would be free to pick either.
  expect(links.length).toBe(1);
  return (links[0] as HTMLLinkElement).getAttribute("href") ?? undefined;
}

describe("favicon scheme script", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    // The static markup the component renders before the script runs.
    const link = document.createElement("link");
    link.setAttribute("rel", "icon");
    link.setAttribute("type", "image/png");
    link.setAttribute("sizes", "64x64");
    link.setAttribute("href", FAVICON_LIGHT_HREF);
    document.head.appendChild(link);
  });
  afterEach(() => {
    document.head.innerHTML = "";
  });

  test("a dark tab bar gets the white-ink glyph", () => {
    const mq = stubMatchMedia(true);
    new Function(FAVICON_SCHEME_SCRIPT)();
    expect(mq.calls).toContain("(prefers-color-scheme: dark)");
    expect(installedHref()).toBe(FAVICON_DARK_HREF);
  });

  test("a light tab bar keeps the black-ink glyph", () => {
    stubMatchMedia(false);
    new Function(FAVICON_SCHEME_SCRIPT)();
    expect(installedHref()).toBe(FAVICON_LIGHT_HREF);
  });

  test("flipping the system appearance under a live tab re-swaps it", () => {
    // The case that only shows up when someone changes their Mac's appearance
    // with the dashboard already open — no reload, so nothing re-renders the
    // <head>. Without the listener the icon stays whatever it was at load.
    const mq = stubMatchMedia(false);
    new Function(FAVICON_SCHEME_SCRIPT)();
    expect(installedHref()).toBe(FAVICON_LIGHT_HREF);

    mq.fire(true);
    expect(installedHref()).toBe(FAVICON_DARK_HREF);

    mq.fire(false);
    expect(installedHref()).toBe(FAVICON_LIGHT_HREF);
  });

  test("it replaces the link element rather than reassigning href", () => {
    // Browsers cache the favicon against the element; an in-place href change
    // is unreliably picked up. This is invisible to the assertions above,
    // which only read the attribute.
    const before = document.querySelector('link[rel="icon"]');
    stubMatchMedia(true);
    new Function(FAVICON_SCHEME_SCRIPT)();
    expect(document.querySelector('link[rel="icon"]')).not.toBe(before);
  });

  test("a hostile DOM cannot take the page down with it", () => {
    // The script runs inline in <head> on every page the daemon serves,
    // including the /explain error pages. An icon is never worth a page.
    (window as unknown as { matchMedia: unknown }).matchMedia = () => {
      throw new Error("no matchMedia here");
    };
    expect(() => new Function(FAVICON_SCHEME_SCRIPT)()).not.toThrow();
  });
});
