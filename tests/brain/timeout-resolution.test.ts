// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The brain call's kill timer, and why it needed a knob before it needed a
 * different number.
 *
 * `DEFAULT_TIMEOUT_MS = 90_000` was a module constant read in exactly one
 * place. `CallBrainOptions.timeoutMs` existed as a seam, but neither critic
 * phase passed it and nothing read an env var or config key — so the critic's
 * timer was 90s always, and could not be changed without editing code. That is
 * also the stated reason an acceptance test has sat skipped: "timeoutMs is
 * never plumbed from config/env through to CallBrainOptions on the critic
 * seam".
 *
 * It matters because of what was measured, not because 90s is obviously wrong.
 * Across `~/.siltpoke/traces/` (n=3809 spans) the critic call's median is
 * 31.4s and 6% of calls end at 90.5–90.7s — the timer firing, not a workload
 * that happens to land there. The uncapped tail reaches 87.8s, right up
 * against the wall. Whether the killed calls would finish in 91s or in 400s is
 * the question that decides if raising the cap helps at all, and it cannot be
 * answered without being able to raise it.
 *
 * So: a knob, defaulting to exactly the value it has today. This changes no
 * behaviour on its own — it makes the decision measurable, which is not the
 * same as making it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { BRAIN_TIMEOUT_ENV, DEFAULT_TIMEOUT_MS, resolveBrainTimeoutMs, runBrainCall } from "../../src/brain/brain";

const original = process.env[BRAIN_TIMEOUT_ENV];
afterEach(() => {
  if (original === undefined) delete process.env[BRAIN_TIMEOUT_ENV];
  else process.env[BRAIN_TIMEOUT_ENV] = original;
});

function withEnv(value: string | undefined): number {
  if (value === undefined) delete process.env[BRAIN_TIMEOUT_ENV];
  else process.env[BRAIN_TIMEOUT_ENV] = value;
  return resolveBrainTimeoutMs();
}

describe("resolveBrainTimeoutMs", () => {
  test("unset env resolves to exactly today's value — the knob changes nothing by existing", () => {
    expect(withEnv(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(90_000);
  });

  test("a valid override is honoured — this is the whole point", () => {
    expect(withEnv("300000")).toBe(300_000);
  });

  test("an explicit caller argument outranks the env", () => {
    // `run-diff-summary` and any test seam pass a deliberate value; an
    // environment variable set for one experiment must not silently retune
    // callers that already decided.
    process.env[BRAIN_TIMEOUT_ENV] = "300000";
    expect(resolveBrainTimeoutMs(5_000)).toBe(5_000);
  });

  test("garbage falls back to the default rather than to zero", () => {
    // The dangerous failure is not "ignored" — it is a timer of 0 or NaN,
    // which either kills every call instantly or never fires at all. Each of
    // these must land on 90s.
    for (const bad of ["", "   ", "abc", "0", "-1", "1e5x", "NaN", "Infinity", "12.5"]) {
      expect(withEnv(bad)).toBe(DEFAULT_TIMEOUT_MS);
    }
  });

  test("values outside the sane band fall back, so a typo cannot disable the timer", () => {
    // A missing zero (9_000_000 instead of 900_000) would leave a hung
    // subprocess alive for 2.5 hours; a stray small value would kill every
    // call before it could answer.
    expect(withEnv("999")).toBe(DEFAULT_TIMEOUT_MS);
    expect(withEnv("600001")).toBe(DEFAULT_TIMEOUT_MS);
    // ...and the edges themselves are accepted, so the band is a band and not
    // an off-by-one.
    expect(withEnv("1000")).toBe(1_000);
    expect(withEnv("600000")).toBe(600_000);
  });


  /**
   * The resolver being correct proves nothing about `runBrainCall` USING it.
   * Reverting that one line to the old `opts.timeoutMs ?? DEFAULT_TIMEOUT_MS`
   * left every other test in this file green — measured, not assumed — so the
   * knob would have shipped tested and inert. This drives the real call with a
   * subprocess that never exits and asserts the env value is what kills it.
   */
  test("runBrainCall actually honours the env — the resolver being right is not the same as it being used", async () => {
    process.env[BRAIN_TIMEOUT_ENV] = "1000";
    let killed = false;
    const started = Date.now();
    // A process that never finishes on its own: only the timer can end this.
    // `kill()` resolves `exited`, the way a real SIGTERM does — otherwise the
    // call hangs after the timer fires and the test measures the harness's
    // own timeout instead of the subject's.
    let settle: (code: number) => void = () => {};
    const spawnFn = (() => ({
      exited: new Promise<number>((r) => {
        settle = r;
      }),
      kill: () => {
        killed = true;
        settle(143);
      },
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      stdin: { write: () => {}, end: () => {} },
    })) as unknown as typeof Bun.spawn;

    await runBrainCall({ systemPrompt: "s", contextBundle: "c", spawnFn }).catch(() => undefined);
    const elapsed = Date.now() - started;

    expect(killed).toBe(true);
    // Comfortably under the 90s default: if the env were being ignored, this
    // would still be waiting when the test timed out.
    expect(elapsed).toBeLessThan(30_000);
  }, 30_000);
});
