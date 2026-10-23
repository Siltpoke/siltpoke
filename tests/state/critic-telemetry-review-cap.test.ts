/**
 * Defect [70]: the telemetry carries the review daily cap as configured now, so
 * the timeline can say "N calls" on a quota_cap row. Temp home only.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCriticTelemetry } from "../../src/state/critic-event-log";

const now = new Date("2026-10-15T15:00:00Z");

describe("readCriticTelemetry — reviewDailyCap", () => {
  test("reads brain.quota_daily_cap from the home's config.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "critic-cap-"));
    await writeFile(join(home, "config.json"), JSON.stringify({ brain: { quota_daily_cap: 17 } }));
    expect((await readCriticTelemetry(home, now)).reviewDailyCap).toBe(17);
  });

  test("no config = the default 50", async () => {
    const home = await mkdtemp(join(tmpdir(), "critic-cap-"));
    expect((await readCriticTelemetry(home, now)).reviewDailyCap).toBe(50);
  });
});
