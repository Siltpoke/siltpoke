/** @jsxImportSource hono/jsx */
/**
 * Critic.golden — characterization snapshot for src/web/screens/Critic.tsx.
 *
 * Empty-state telemetry (no rows, all-pass gates) keeps the SSR output
 * deterministic — the `new Date()` inside Critic() only affects per-row
 * formatTimeAgo, which never runs when telemetry.recent is empty.
 */
import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { Critic } from "../../../src/web/screens/Critic";
import type { CriticTelemetry } from "../../../src/state/critic-event-log";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const CAPTURE = process.env.R1_GOLDEN_MODE === "capture";

const EMPTY_TELEMETRY: CriticTelemetry = {
  recent: [],
  breakdown: { total: 0, counts: {} },
  budget: {
    stage: "ok",
    used_pct: 0,
    remaining_tokens: 1_000_000,
    config: {
      dailyTokenLimit: 1_000_000,
      perCallMaxInputTokens: 100_000,
      softWarnAtPercent: 80,
      hardStopAtPercent: 100,
      softModeOverride: "on_demand",
      resetAtMinutes: 0,
    },
    rollup: null,
  },
  triggerConfig: { mode: "diff" },
  quietConfig: { startMinutes: null, endMinutes: null },
  gateState: {
    blocking: null,
    detail: "All gates open — critic should fire on next Stop hook.",
    checks: [
      { name: "quiet_hours", pass: true, detail: "Not configured (always pass)" },
      { name: "budget", pass: true, detail: "0% used" },
    ],
  },
  projects: [],
  activeProject: null,
  activeStatus: null,
  activeKind: null,
  activeRange: "all",
  activeSort: "newest",
  preferenceStats: null,
  activeQuery: null,
  actionStats: { dismissed: 0, acked: 0, total: 0 },
  homeBasename: "user",
} as unknown as CriticTelemetry;

test("golden: Critic.tsx SSR output is stable for empty telemetry", () => {
  const html = String(<Critic telemetry={EMPTY_TELEMETRY} />);
  const fixturePath = join(FIXTURE_DIR, "Critic-empty.html");

  if (CAPTURE || !existsSync(fixturePath)) {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, html, "utf8");
    expect(html).toBe(html);
    return;
  }

  const expected = readFileSync(fixturePath, "utf8");
  if (html !== expected) {
    throw new Error(
      `Critic.golden mismatch.\n` +
        `Fixture: ${fixturePath}\n` +
        `Expected ${expected.length} bytes, got ${html.length} bytes.\n` +
        `Re-capture with: R1_GOLDEN_MODE=capture bun test tests/web/screens/Critic.golden.test.tsx`,
    );
  }
  expect(html).toBe(expected);
});
