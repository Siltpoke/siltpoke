import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadQuietHoursConfig,
  isQuietHour,
  DEFAULT_QUIET_HOURS,
} from "../../src/state/quiet-hours";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-quiet-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function at(hours: number, minutes: number = 0): Date {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

test("default config: quiet hours disabled", () => {
  expect(isQuietHour(at(3), DEFAULT_QUIET_HOURS)).toBe(false);
  expect(isQuietHour(at(23), DEFAULT_QUIET_HOURS)).toBe(false);
});

test("loadQuietHoursConfig: malformed times → defaults (null)", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ quietHours: { start: "bad", end: "25:00" } }),
  );
  const cfg = await loadQuietHoursConfig(tmp);
  expect(cfg.start).toBeNull();
  expect(cfg.end).toBeNull();
});

test("loadQuietHoursConfig: valid times persist", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ quietHours: { start: "23:00", end: "08:00" } }),
  );
  const cfg = await loadQuietHoursConfig(tmp);
  expect(cfg.start).toBe("23:00");
  expect(cfg.end).toBe("08:00");
});

test("isQuietHour: same-day window inclusive of start, exclusive of end", () => {
  const cfg = { start: "09:00", end: "17:00", timezone: "local" };
  expect(isQuietHour(at(8, 59), cfg)).toBe(false);
  expect(isQuietHour(at(9, 0), cfg)).toBe(true);
  expect(isQuietHour(at(12, 0), cfg)).toBe(true);
  expect(isQuietHour(at(16, 59), cfg)).toBe(true);
  expect(isQuietHour(at(17, 0), cfg)).toBe(false);
});

test("isQuietHour: wrap-around (23:00 → 08:00)", () => {
  const cfg = { start: "23:00", end: "08:00", timezone: "local" };
  expect(isQuietHour(at(22, 0), cfg)).toBe(false);
  expect(isQuietHour(at(23, 0), cfg)).toBe(true);
  expect(isQuietHour(at(2, 0), cfg)).toBe(true);
  expect(isQuietHour(at(7, 59), cfg)).toBe(true);
  expect(isQuietHour(at(8, 0), cfg)).toBe(false);
  expect(isQuietHour(at(12, 0), cfg)).toBe(false);
});

test("isQuietHour: start equals end is treated as disabled", () => {
  const cfg = { start: "10:00", end: "10:00", timezone: "local" };
  expect(isQuietHour(at(10, 0), cfg)).toBe(false);
  expect(isQuietHour(at(9, 59), cfg)).toBe(false);
});

test("isQuietHour: returns false when either bound null", () => {
  expect(
    isQuietHour(at(3), { start: null, end: "08:00", timezone: "local" }),
  ).toBe(false);
  expect(
    isQuietHour(at(3), { start: "23:00", end: null, timezone: "local" }),
  ).toBe(false);
});
