/** Canary: bun test runs every file in ONE
 * process; the DOM-harness file (repo-graph-boot.test.ts) registers happy-dom
 * globals and MUST fully restore them in afterAll. This file's name sorts
 * after that file, so by the time it runs the harness's globals must be back
 * to Bun-native. Catches a leaked register() / failed unregister() / lost
 * native fetch — the exact leak class that would silently poison the
 * 1000+ non-DOM tests (bun#8774).
 *
 * Maintenance round #2 (2026-06-10): chat-stream.test.ts's bare
 * `globalThis.window` stub is now deleted in that file's afterEach, so the
 * canary tightened from "any surviving window is not happy-dom" to "no
 * window survives at all" — `typeof window` is reliable suite-wide again. */
import { expect, test } from "bun:test";

test("happy-dom globals are not leaked into the wider suite", () => {
  expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
  expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
  // Bun-native fetch reports as a native function; happy-dom's replacement
  // is a JS class wrapper and does not. ASSUMPTION: Bun keeps fetch native —
  // if a future Bun wraps fetch in a JS trampoline this turns false-positive;
  // re-anchor the check then (e.g. identity against a captured boot-time ref).
  expect(String(globalThis.fetch)).toContain("[native code]");
});
