// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The user's own statusline command (inner.txt) has a time limit.
 *
 * It had none: the wrapper read its stdout to the end and waited for its
 * exit, so a hung command — or a child of it still holding stdout — held the
 * whole statusline. Past the limit the command is stopped and the face renders
 * alone. Every test runs a REAL process; bounds carry slack for a loaded machine.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSpecies } from "../../src/face/species";
import { runWrapper } from "../../src/face/wrapper";

let base: string;
const FACE = getSpecies(undefined).art.base.split("\n")[0]!.trim();

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "siltpoke-inner-timeout-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function timed(inner: string, innerTimeoutMs?: number): Promise<{ out: string; ms: number }> {
  writeFileSync(join(base, "inner.txt"), inner);
  const t0 = Date.now();
  const out = await runWrapper({ basePath: base, termWidth: 200, innerStdin: "{}", innerTimeoutMs });
  return { out, ms: Date.now() - t0 };
}

test("a hung command is stopped and the face renders alone", async () => {
  const { out, ms } = await timed("sleep 10", 300);
  expect(ms).toBeLessThan(2_500); // before: 10 s
  expect(out).toContain(FACE);
  expect(readFileSync(join(base, "logs", "errors.log"), "utf8")).toContain("took over 300 ms");
}, 15_000);

test("a command that ignores SIGTERM is still stopped", async () => {
  const { out, ms } = await timed("trap '' TERM; sleep 10", 300);
  expect(ms).toBeLessThan(3_000); // limit + SIGKILL grace + drain grace + slack
  expect(out).toContain(FACE);
}, 15_000);

test("a child holding stdout after the command exits does not hold the statusline", async () => {
  const { out, ms } = await timed("sleep 10 & echo hud-line");
  expect(ms).toBeLessThan(1_800); // drain grace only; before: 10 s
  expect(out).toContain("hud-line");
  expect(out).toContain(FACE);
}, 15_000);

test("a command that exits inside the limit keeps its output while a child still holds stdout past it", async () => {
  // bash exits at ~50 ms; its child holds stdout through the 500 ms drain
  // grace, so the drain ends (~550 ms) past the 400 ms limit. The limit is on
  // the command, which finished in time. Keep limit < 50 + 500 or this stops
  // being a guard.
  const { out } = await timed("sleep 10 & sleep 0.05; echo in-time-line", 400);
  expect(out).toContain("in-time-line");
  let log = "";
  try {
    log = readFileSync(join(base, "logs", "errors.log"), "utf8");
  } catch {
    // no log file: nothing was logged
  }
  expect(log).not.toContain("took over");
}, 15_000);

test("a fast command inside the limit is unchanged and logs nothing", async () => {
  const { out } = await timed("echo fast-line", 300);
  expect(out).toContain("fast-line");
  expect(out).toContain(FACE);
  let log = "";
  try {
    log = readFileSync(join(base, "logs", "errors.log"), "utf8");
  } catch {
    // no log file: nothing was logged
  }
  expect(log).not.toContain("took over");
});
