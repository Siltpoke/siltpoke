/**
 * Tests for src/cli/mute.ts.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDuration,
  runMute,
  formatMuteHuman,
  formatMuteJson,
  type MuteResult,
} from "../../src/cli/mute";

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-mute-cli-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = new Date("2026-05-27T15:30:00Z");

describe("parseDuration", () => {
  test("15m → 15 * 60 * 1000 ms", () => {
    const r = parseDuration("15m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ms).toBe(15 * 60_000);
      expect(r.value.indefinite).toBe(false);
      expect(r.value.label).toBe("15m");
    }
  });

  test("1h → 1h ms", () => {
    const r = parseDuration("1h");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ms).toBe(60 * 60_000);
  });

  test("2d → 2 days ms", () => {
    const r = parseDuration("2d");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ms).toBe(2 * 24 * 60 * 60_000);
  });

  test("indefinite → null ms + indefinite=true", () => {
    const r = parseDuration("indefinite");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ms).toBeNull();
      expect(r.value.indefinite).toBe(true);
      expect(r.value.label).toBe("indefinite");
    }
  });

  test("empty string → ok:false with usage error", () => {
    const r = parseDuration("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("duration is required");
  });

  test("garbage input → ok:false with usage error", () => {
    const r = parseDuration("abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid duration");
  });

  test("0m → ok:false (must be positive)", () => {
    const r = parseDuration("0m");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("positive");
  });

  test("negative not accepted (regex rejects)", () => {
    const r = parseDuration("-5m");
    expect(r.ok).toBe(false);
  });

  test("unknown unit '5s' rejected", () => {
    const r = parseDuration("5s");
    expect(r.ok).toBe(false);
  });

  test("trailing junk rejected", () => {
    const r = parseDuration("15m extra");
    expect(r.ok).toBe(false);
  });
});

describe("runMute", () => {
  test("writes mute.json with correct until_ms for timed mute", () => {
    const result = runMute({ homeBase, durationArg: "1h", now: () => NOW });
    expect(result.muted).toBe(true);
    expect(result.indefinite).toBe(false);
    expect(result.until_ms).toBe(NOW.getTime() + 60 * 60_000);
    expect(result.label).toBe("1h");
    expect(existsSync(result.mute_path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(result.mute_path, "utf8"));
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.indefinite).toBe(false);
    expect(onDisk.until_ms).toBe(result.until_ms);
  });

  test("writes mute.json with null until_ms for indefinite mute", () => {
    const result = runMute({ homeBase, durationArg: "indefinite", now: () => NOW });
    expect(result.indefinite).toBe(true);
    expect(result.until_ms).toBeNull();
    const onDisk = JSON.parse(readFileSync(result.mute_path, "utf8"));
    expect(onDisk.indefinite).toBe(true);
    expect(onDisk.until_ms).toBeNull();
  });

  test("throws on invalid duration arg", () => {
    expect(() => runMute({ homeBase, durationArg: "abc", now: () => NOW })).toThrow();
  });

  test("throws on empty duration arg", () => {
    expect(() => runMute({ homeBase, durationArg: "", now: () => NOW })).toThrow(/required/);
  });

  test("overwrites existing mute (writes are atomic)", () => {
    runMute({ homeBase, durationArg: "15m", now: () => NOW });
    const second = runMute({ homeBase, durationArg: "1h", now: () => NOW });
    expect(second.until_ms).toBe(NOW.getTime() + 60 * 60_000);
  });
});

describe("formatters", () => {
  const timedResult: MuteResult = {
    muted: true,
    indefinite: false,
    until_ms: new Date("2026-05-27T16:30:00Z").getTime(),
    set_at: NOW.toISOString(),
    mute_path: "/tmp/mute.json",
    label: "1h",
  };
  const indefResult: MuteResult = {
    muted: true,
    indefinite: true,
    until_ms: null,
    set_at: NOW.toISOString(),
    mute_path: "/tmp/mute.json",
    label: "indefinite",
  };

  test("formatMuteHuman timed mentions duration label + 'until'", () => {
    const out = formatMuteHuman(timedResult);
    expect(out).toContain("muted until");
    expect(out).toContain("1h from now");
    expect(out).toContain("/siltpoke-unmute");
  });

  test("formatMuteHuman indefinite says 'indefinitely'", () => {
    const out = formatMuteHuman(indefResult);
    expect(out).toContain("indefinitely");
    expect(out).toContain("/siltpoke-unmute");
    expect(out).not.toContain("until");
  });

  test("formatMuteJson emits valid JSON", () => {
    const out = formatMuteJson(timedResult);
    const parsed = JSON.parse(out);
    expect(parsed.muted).toBe(true);
    expect(parsed.until_ms).toBe(timedResult.until_ms);
    expect(parsed.label).toBe("1h");
  });
});
