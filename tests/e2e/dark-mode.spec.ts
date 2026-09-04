import { test, expect } from "@playwright/test";

/**
 * Pins the cascade relationship the whole dark-mode design rests on.
 *
 * CORRECTED 2026-08-01 (fix round 1, review Critical): v1 of this test
 * appended its probe AFTER both tokens.css and tailwind.css in <head>, so
 * it won by BOTH source order AND specificity at once — it could not tell
 * "wins by specificity, independent of order" apart from "wins because
 * it's simply the newest rule." This version disentangles the two: every
 * probe is inserted BEFORE tailwind.css's <link> (order-disadvantaged
 * relative to Tailwind specifically — NOT before tokens.css's own <link>,
 * which would introduce an unrelated confound against tokens.css's own
 * `:root{--color-cream:#faf6ec}` default), and includes a case engineered
 * to actually LOSE, so the test can prove it discriminates rather than
 * being vacuously green.
 *
 * EMPIRICAL FINDING that changed this fix's shape from the literal review
 * suggestion: compiled public/static/tailwind.css does NOT emit an
 * unlayered `:root,:host` rule as the original brief assumed — it emits
 * `@layer theme{ :root,:host{ --color-cream:#faf6ec, ... } }` (confirmed
 * by reading the build output: `grep -o ':root,:host{[^}]*}'
 * public/static/tailwind.css` is wrapped in `@layer theme{...}`). Per the
 * CSS Cascade Layers spec, layer membership is compared BEFORE
 * specificity: ANY unlayered declaration beats ANY layered declaration for
 * the same property, REGARDLESS of specificity or source order. That is a
 * STRONGER and SIMPLER guarantee than "0,2,0 beats 0,1,0" — verified
 * empirically below by Case 2, a LOW-specificity (0,1,0) unlayered probe
 * that ties Tailwind's own specificity and still wins, proving cascade
 * layering — not selector specificity — is what actually decides it. As
 * long as a future dark override stays plain, unlayered CSS (i.e. lives in
 * tokens.css exactly as today, with no `@layer` wrapper), it beats
 * Tailwind's `@theme` value no matter what selector or link order is used.
 * The review's concrete regression scenario — `[data-theme="dark"]`
 * (0,1,0) tying Tailwind's `:root,:host` (0,1,0) and losing to it on
 * source order — cannot happen through selector or link-order choice
 * alone. The one construction that DOES lose is Case 3: wrapping the
 * override in the SAME `@layer` Tailwind uses, tying specificity,
 * order-disadvantaged. That is the real risk to avoid going forward (a
 * future edit that wraps a dark-mode override in `@layer`), and it is what
 * this test's negative control pins.
 *
 * Observed values from the run that produced this comment:
 *   varValue (Case 1, unlayered, 0,2,0)        = "#010203"           (wins)
 *   utilityValue (Case 1)                      = "rgb(1, 2, 3)"      (wins — dereferences the var, not a baked literal)
 *   unlayeredLowSpecVar (Case 2, unlayered, 0,1,0, ties Tailwind's spec) = "#040506" (still wins — proves layering, not specificity, decides it)
 *   sameLayerTieVar (Case 3, same layer as Tailwind, 0,1,0, order-disadvantaged) = "#faf6ec" (Tailwind's compiled default — LOSES, as expected)
 *
 * If the winning assertions (Case 1/2) ever fail: the fallback in spec
 * §4.2 applies — emit the dark overrides into tailwind.css as well. Do not
 * "fix" it by reordering the <link> tags — that would make correctness
 * depend on link order, which is the fragile arrangement this test exists
 * to rule out.
 */
test("an unlayered :root override beats Tailwind's layered @theme value, regardless of specificity or link order", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(() => {
    const tailwindLink = document.querySelector('link[href="/static/tailwind.css"]');
    if (!tailwindLink) {
      throw new Error("tailwind.css <link> not found in <head> — layout.tsx markup changed");
    }

    const probe = document.createElement("div");
    // NOTE on this class name: `.bg-cream` only exists in the compiled CSS
    // because Tailwind's JIT @source scan finds the literal class name
    // "bg-cream" somewhere in a scanned .tsx/.ts file (see the @source
    // globs in src/web/tokens/tailwind.css). This <div> is created here in
    // JS at test time, which the scanner never sees at build time — it
    // compiles today only because "bg-cream" appears in real source files
    // elsewhere. If this assertion ever goes red, run
    // `grep bg-cream public/static/tailwind.css` BEFORE suspecting a
    // cascade regression — it may just be purge/JIT drift (the class
    // stopped appearing in scanned source), which is a different failure
    // mode than the cascade claim this test pins.
    probe.className = "bg-cream";
    document.body.appendChild(probe);

    const readVar = () =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-cream").trim();
    const readUtility = () => getComputedStyle(probe).backgroundColor;

    // Inserts `css` as a <style> immediately BEFORE tailwind.css's <link> —
    // i.e. order-disadvantaged relative to Tailwind specifically (Tailwind
    // comes later in source order, so on any cascade tie it would win) but
    // still AFTER tokens.css's own <link>, so this never accidentally
    // competes with tokens.css's own `:root{--color-cream:#faf6ec}`
    // default (an unrelated confound this fix removed).
    function withStyle<T>(css: string, setDataTheme: boolean, read: () => T): T {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.insertBefore(style, tailwindLink);
      if (setDataTheme) document.documentElement.setAttribute("data-theme", "probe");
      const value = read();
      style.remove();
      if (setDataTheme) document.documentElement.removeAttribute("data-theme");
      return value;
    }

    // Case 1 — the real shape: unlayered, HIGH specificity (0,2,0), the
    // selector shape the actual dark override will use
    // (`:root[data-theme="dark"]`). This is the load-bearing claim: the
    // utility class must dereference the overridden variable live.
    const case1 = withStyle(
      ':root[data-theme="probe"]{--color-cream:#010203}',
      true,
      () => ({ varValue: readVar(), utilityValue: readUtility() }),
    );

    // Case 2 — unlayered, LOW specificity (0,1,0), deliberately TYING
    // Tailwind's own specificity. Still order-disadvantaged. If this wins
    // (it does), specificity was never what decided Case 1 either —
    // cascade-layer membership is.
    const unlayeredLowSpecVar = withStyle(
      '[data-theme="probe"]{--color-cream:#040506}',
      true,
      readVar,
    );

    // Case 3 (negative control) — the ONE construction that actually
    // loses: SAME layer Tailwind uses ("theme"), tying specificity (0,1,0),
    // order-disadvantaged. Proves the test can fail, and pins the real
    // risk (a future override accidentally wrapped in `@layer`).
    const sameLayerTieVar = withStyle(
      "@layer theme{ :root{--color-cream:#070809} }",
      false,
      readVar,
    );

    probe.remove();
    return { ...case1, unlayeredLowSpecVar, sameLayerTieVar };
  });

  expect(result.varValue).toBe("#010203");
  // The utility must dereference the overridden variable, not a baked literal.
  expect(result.utilityValue).toBe("rgb(1, 2, 3)");
  expect(result.unlayeredLowSpecVar).toBe("#040506");
  // Negative control: must NOT win. If this ever resolves to anything other
  // than Tailwind's compiled default, the discriminating case has stopped
  // discriminating and this test can no longer be trusted to catch a real
  // cascade regression.
  expect(result.sameLayerTieVar).toBe("#faf6ec");
});

const BG_DARK = "rgb(21, 21, 21)";   // palette.dark.cream  #151515
const BG_LIGHT = "rgb(250, 246, 236)"; // palette.light.cream #faf6ec

async function bodyBackground(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

test.describe("three-state override", () => {
  test.use({ colorScheme: "light" });

  test("cycles system -> light -> dark -> system and persists", async ({ page }) => {
    await page.goto("/");
    const toggle = page.locator("[data-theme-toggle]");
    await expect(toggle).toBeVisible();

    await expect(toggle).toHaveAttribute("data-state", "system");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "light");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-state", "dark");
    expect(await bodyBackground(page)).toBe(BG_DARK);

    await page.reload();
    expect(await bodyBackground(page)).toBe(BG_DARK);
    await expect(page.locator("[data-theme-toggle]")).toHaveAttribute("data-state", "dark");

    await page.locator("[data-theme-toggle]").click();
    await expect(page.locator("[data-theme-toggle]")).toHaveAttribute("data-state", "system");
    expect(await bodyBackground(page)).toBe(BG_LIGHT);
  });

  test("forced dark wins over a light OS", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("siltpokeTheme", "dark"));
    await page.reload();
    expect(await bodyBackground(page)).toBe(BG_DARK);
  });

  test("the toggle survives hx-boost navigation", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("siltpokeTheme", "dark"));
    await page.reload();
    await page.getByRole("link", { name: /timeline/i }).click();
    await page.waitForURL(/timeline/);
    expect(await bodyBackground(page)).toBe(BG_DARK);
    await expect(page.locator("[data-theme-toggle]")).toHaveAttribute("data-state", "dark");
  });

  test("the toggle stays reachable when the sidebar is collapsed", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-sidebar-collapse]").click();
    // Assert the PRECONDITION before the thing under test. Without this the
    // test passes vacuously the moment the collapse control stops collapsing
    // (wrong element carrying data-sidebar-collapse, broken toggle()) — it
    // would still be green while proving nothing about the 52px rail.
    await expect(page.locator("[data-sidebar]")).toHaveCSS("width", "52px");
    await expect(page.locator("[data-theme-toggle]")).toBeVisible();
    // Reachable means clickable, not merely painted: in a 52px rail an
    // overflow-clipped or zero-width control still reports "visible".
    const box = await page.locator("[data-theme-toggle]").boundingBox();
    expect(box).not.toBeNull();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    await page.locator("[data-theme-toggle]").click();
    await expect(page.locator("[data-theme-toggle]")).toHaveAttribute("data-state", "light");
  });
});

test.describe("system-following", () => {
  test.use({ colorScheme: "dark" });

  test("a dark OS with no override renders dark", async ({ page }) => {
    await page.goto("/");
    expect(await bodyBackground(page)).toBe(BG_DARK);
  });

  test("forced light wins over a dark OS — the fourth CSS block", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("siltpokeTheme", "light"));
    await page.reload();
    expect(await bodyBackground(page)).toBe(BG_LIGHT);
  });
});

// `/rubric` and `/preference-log` were added by the Task 7 review, which
// measured `ink` on the three LIGHT dark-theme accents at 1.66 (moss) / 1.85
// (sky) / 1.57 (amber) against a 4.5 floor — real, live, unreadable chips on
// exactly those two routes, and the original five-route list would have shipped
// them silently. The fix is NOT a mechanical swap to `onAccent`: that token is
// white in light mode, where those same fills are light too, so it needs a
// per-accent light+dark decision. This walk is what forces that decision.
// DECIDED 2026-08-01 (the maintainer): per-accent ink tokens (`onMoss`/`onSky`/
// `onAmber`), gated by a unit assertion in palette.test.ts — see Task 10
// Step 2(b). This walk stays the live confirmation, not the primary gate.
//
// WIDENED (fix round 1, Important #1): the original 7-route list was written
// before the Task 10b-4 review found a 1.26:1 Critical on a retired page — the
// exact composition-shaped defect this task exists to catch — and the walk
// could not reach it (a retired page was not in this list). Added every
// remaining live page: a retired page, `/chat`, `/few-shot`, `/repo-memory`,
// `/repo-graph`, `/history`, `/traces`. `/critic`, `/history` and `/traces`
// (bare, no `:trace_id`) are server-side redirects to `/timeline`
// (`critic.tsx`, `traces.tsx` route tables) — each entry below still drives a
// real navigation + render (and a redirect is itself part of what "actually
// renders" means), but they are not 3 further distinct pages: the 14 entries
// below cover 11 distinct pages.
const CONTRAST_ROUTES = [
  "/",
  "/timeline",
  "/memory",
  "/critic", // redirects to /timeline (critic.tsx) — not a distinct page
  // "/settings" removed 2026-08-06 — the route is unmounted; scanning a 404 would
  // collapse `examined` and trip the floor below for an unrelated reason.
  "/rubric",
  "/preference-log",
  // "a retired page" removed 2026-08-06 — the route is unmounted, and page.goto does not throw
  // on a 404, so leaving it here would collapse `examined` toward 0 and trip the floor
  // below for a reason that has nothing to do with contrast.
  "/chat",
  "/few-shot",
  "/repo-memory",
  "/repo-graph",
  "/history", // redirects to /timeline (critic.tsx) — not a distinct page
  "/traces", // redirects to /timeline (traces.tsx, bare route) — not a distinct page
] as const;

/**
 * Per-route floor for `examined` (fix round 1, Critical): `toEqual([])` on
 * `failures` alone cannot tell "walked 174 elements, all clean" apart from
 * "walked zero elements" — and there are two reachable zero-element paths.
 * `page.goto` does not throw on a 4xx/5xx (Playwright only throws on network
 * failure), so a route that regressed to Hono's default 404 plain-text body
 * has no element wrapper and `querySelectorAll("body *")` (which excludes
 * `body` itself) matches nothing. Same for content sitting behind an
 * `x-show`/`x-if` that starts closed — `display:none` is skipped by design.
 * Each value below is the real dark-mode count measured during fix round 1
 * review (see the Task Close Report), rounded down with headroom: low enough
 * to survive an ordinary content edit (a new stat tile, a copy change), high
 * enough that a collapse to 0 (or to a handful of chrome-only elements) still
 * fails.
 */
const EXAMINED_FLOOR: Record<(typeof CONTRAST_ROUTES)[number], number> = {
  "/": 50,
  "/timeline": 25,
  "/memory": 130,
  "/critic": 25,
  "/rubric": 55,
  "/preference-log": 12,
  "/chat": 11,
  "/few-shot": 12,
  "/repo-memory": 13,
  "/repo-graph": 18,
  "/history": 25,
  "/traces": 25,
};

interface ContrastFailure {
  tag: string;
  className: string;
  /** Up to 3 ancestors, nearest-first-to-root, e.g. "div.card>div.row>span". */
  path: string;
  /** The offending TEXT NODE's own content, not the wrapper's whole subtree text. */
  text: string;
  fg: string;
  bg: string;
  ratio: number;
  floor: number;
}
interface WalkResult {
  examined: number;
  failures: ContrastFailure[];
}

/**
 * Walks visible text-bearing elements, resolves each one's EFFECTIVE background
 * by climbing ancestors until a non-transparent one is found, and returns any
 * pair under its floor. This is the part that cannot be done on static HTML.
 *
 * Returns `{ examined, failures }`, not a bare array (fix round 1, Critical)
 * — `examined` is the population size the caller asserts a floor on, so a
 * collapse-to-zero-elements is distinguishable from a genuine clean pass.
 *
 * Known blind spots (fix round 1 review; recorded, not fixed — see the Task
 * Close Report "Blind spots" section for the full list and why each is out
 * of this task's scope): backgrounds at alpha <= 0.5 are stepped over rather
 * than composited; foreground alpha is parsed and discarded (`rgba(…,.6)`
 * text measures at full strength); ancestor `opacity` is not accumulated;
 * `background-image`/gradient surfaces read as transparent; SVG text is
 * measured against `color` while glyphs paint with `fill`; `::selection` and
 * other pseudo-element content is unreachable; focus/hover/active/error
 * states are never exercised; anything `display:none` at load is skipped
 * (modals, dropdowns, the closed FloatingChat panel); single-character text
 * is dropped by `length > 1`; and the WCAG 3:1 GRAPHICAL floor (borders,
 * dividers, icon strokes, focus rings) is never checked — this walk only
 * ever compares text `color` to a background.
 */
const CONTRAST_WALK = `() => {
  const lum = (r, g, b) => {
    const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  // Compared on the UNROUNDED ratio; only the value REPORTED in a failure is
  // rounded (toFixed(2), below). Rounding before the comparison would let a
  // true ratio of e.g. 2.995 round-trip to "3.00" and pass a 3:1 floor it
  // does not actually clear.
  const ratio = (x, y) => { const a = lum(x.r, x.g, x.b), b = lum(y.r, y.g, y.b);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  const effectiveBg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return parse(getComputedStyle(document.body).backgroundColor);
  };
  const short = (n) => {
    if (!n || !n.tagName) return "";
    const cls = (n.className && typeof n.className === "string" && n.className.trim())
      ? "." + n.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    return n.tagName.toLowerCase() + cls;
  };
  const failures = [];
  let examined = 0;
  for (const el of document.querySelectorAll("body *")) {
    const textNode = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!textNode) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.5) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    examined++;
    const fg = parse(cs.color); const bg = effectiveBg(el);
    if (!fg || !bg) continue;
    const px = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const floor = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < floor) {
      const path = [el.parentElement ? el.parentElement.parentElement : null, el.parentElement, el]
        .map(short).filter(Boolean).join(">");
      failures.push({
        tag: el.tagName.toLowerCase(),
        className: (el.className && typeof el.className === "string") ? el.className : "",
        path,
        text: textNode.textContent.trim().slice(0, 40),
        fg: cs.color, bg: \`rgb(\${bg.r}, \${bg.g}, \${bg.b})\`,
        ratio: Number(r.toFixed(2)), floor,
      });
    }
  }
  return { examined, failures };
}`;

test.describe("dark mode contrast, measured where it renders", () => {
  for (const route of CONTRAST_ROUTES) {
    test(`${route} clears the WCAG floors in dark mode`, async ({ page }) => {
      await page.goto("/");
      await page.evaluate(() => localStorage.setItem("siltpokeTheme", "dark"));
      await page.goto(route);
      // Deprecated upstream; ten existing sites in this suite already use
      // it, so left as-is (fix round 1, noted-no-action).
      await page.waitForLoadState("networkidle");
      // NOTE (brief mismatch, fixed here): the brief's own snippet calls
      // `page.evaluate(CONTRAST_WALK)` with CONTRAST_WALK as a bare
      // `"() => {...}"` string. Playwright's page.evaluate(string) evaluates
      // that string as an EXPRESSION rather than invoking it as a function —
      // the expression evaluates to a function VALUE, which is not
      // serializable across the page boundary, so evaluate silently resolves
      // to `undefined` (confirmed empirically: a throwaway probe test showed
      // `page.evaluate("() => [1,2,3]")` returns `undefined`, while
      // `page.evaluate("(() => [1,2,3])()")` returns `[1,2,3]`). As written,
      // every one of these route tests would fail on EVERY run with
      // "Expected [] Received undefined" — not because the walk found a
      // contrast violation, but because the walk never runs at all. Wrapping
      // in an extra pair of parens + a trailing `()` makes the string a
      // self-invoking expression, which Playwright DOES serialize the return
      // value of. Verified against Playwright's own client: it always sends
      // `isFunction: typeof pageFunction === "function"`, so a string
      // argument sends `isFunction: false` explicitly — the auto-detect
      // branch that might otherwise rescue it is unreachable.
      const result = await page.evaluate<WalkResult>(`(${CONTRAST_WALK})()`);
      expect(result.examined, JSON.stringify(result)).toBeGreaterThanOrEqual(EXAMINED_FLOOR[route]);
      expect(result.failures, JSON.stringify(result.failures, null, 2)).toEqual([]);
    });
  }
});

test.describe("contrast walk negative control", () => {
  test("a planted composition bug — a light-literal ancestor background under theme-following ink — is caught", async ({
    page,
  }) => {
    // Fix round 1, Critical #2: a plant-and-revert proves the walk caught
    // ONE thing ONCE; it proves nothing to the next reader, since the code
    // it exercised is gone by the time they read the test. This control
    // plants the defect AT RUNTIME via page.evaluate — no production file
    // is touched, so the control is permanent and re-runs on every CI pass.
    // It is deliberately the same defect shape as the real Task 10b-4
    // a retired screen Critical (1.26:1): a surface pinned to one theme (a
    // hardcoded LIGHT literal background) while the ink painted on top
    // keeps following the theme. This is exactly what `tests/e2e/dark-mode.
    // spec.ts:36-47`'s Case 3 already does for the cascade-layering claim
    // above — a probe engineered to LOSE, so the green cases mean something.
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("siltpokeTheme", "dark"));
    // Was /settings until 2026-08-06; that route is unmounted, and a 404 has no <h1>
    // for the probe to wrap, which would make this negative control pass vacuously.
    await page.goto("/memory");
    await page.waitForLoadState("networkidle");
    const result = await page.evaluate<WalkResult>(`(() => {
      const h1 = document.querySelector("h1");
      const wrap = document.createElement("div");
      wrap.style.background = "#f4eedf";
      h1.parentElement.insertBefore(wrap, h1);
      wrap.appendChild(h1);
      return (${CONTRAST_WALK})();
    })()`);
    expect(result.failures, JSON.stringify(result.failures, null, 2)).toHaveLength(1);
    const [failure] = result.failures;
    expect(failure.tag).toBe("h1");
    // rgb(232,232,232) ink on the planted rgb(244,238,223) background — the
    // exact pair captured in the Task Close Report.
    expect(failure.ratio).toBeCloseTo(1.06, 1);
    expect(failure.floor).toBe(3);
  });
});

test.describe("first paint", () => {
  test("a forced dark theme lands before first-contentful-paint — the actual no-flash claim", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.setItem("siltpokeTheme", "dark"));

    // MEASURED (fix round 1, Important #2): the previous version read
    // `data-theme` after `page.reload({waitUntil:"commit"})`, but
    // `page.evaluate` round-trips over CDP and waits for an execution
    // context — by which time a page this small has almost certainly
    // finished parsing. That assertion would pass identically even if the
    // bootstrap script were moved to the end of <body>, made `defer`, or run
    // by Alpine after `load` — it did not discriminate against any of the
    // regressions this test exists to prevent, and "no flash" is a timing
    // claim with no timestamp in it.
    //
    // This version installs a MutationObserver via `page.addInitScript` (so
    // it runs before ANY of the page's own scripts, including the inline
    // bootstrap script) that timestamps the moment `data-theme` actually
    // lands, plus a PerformanceObserver that timestamps the browser's own
    // `first-contentful-paint` entry, then asserts the former is no later
    // than the latter.
    //
    // Empirically verified to discriminate against the exact regressions
    // named above: temporarily wrapping the real bootstrap script's body in
    // `window.addEventListener('load', function(){...})` — the "run by
    // Alpine after load" case — moved the measured dataThemeAt from ~15ms to
    // ~59ms while fcpAt stayed ~32-40ms, flipping this assertion RED
    // (captured: "Expected: <= 32, Received: 58.8"). The unmodified script
    // passes with dataThemeAt (~13-15ms) well before fcpAt (~36-40ms).
    // Reverted; `git diff` after revert showed no change to src/.
    await page.addInitScript(() => {
      type ThemeTiming = { dataThemeAt: number | null; fcpAt: number | null };
      const w = window as unknown as { __themeTiming: ThemeTiming };
      w.__themeTiming = { dataThemeAt: null, fcpAt: null };
      const check = () => {
        const de = document.documentElement;
        if (de && de.getAttribute("data-theme") === "dark" && w.__themeTiming.dataThemeAt === null) {
          w.__themeTiming.dataThemeAt = performance.now();
        }
      };
      check();
      const arm = () => {
        if (!document.documentElement) {
          requestAnimationFrame(arm);
          return;
        }
        check();
        new MutationObserver(check).observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
      };
      arm();
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === "first-contentful-paint" && w.__themeTiming.fcpAt === null) {
              w.__themeTiming.fcpAt = entry.startTime;
            }
          }
        }).observe({ type: "paint", buffered: true });
      } catch {
        // "paint" entry type unsupported — surfaced below: fcpAt stays null
        // and the not-null assertion fails rather than the test going green
        // on a comparison that silently never ran.
      }
    });

    await page.reload();
    await page
      .waitForFunction(() => (window as unknown as { __themeTiming?: { fcpAt: number | null } }).__themeTiming?.fcpAt !== null, {
        timeout: 5000,
      })
      .catch(() => {
        // Let the assertions below report the actual (likely still-null) state
        // rather than a bare waitForFunction timeout.
      });

    const timing = await page.evaluate(
      () => (window as unknown as { __themeTiming: { dataThemeAt: number | null; fcpAt: number | null } }).__themeTiming,
    );
    expect(timing.dataThemeAt, JSON.stringify(timing)).not.toBeNull();
    expect(timing.fcpAt, JSON.stringify(timing)).not.toBeNull();
    expect(timing.dataThemeAt, JSON.stringify(timing)).toBeLessThanOrEqual(timing.fcpAt as number);
  });
});
