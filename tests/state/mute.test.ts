/**
 * Tests for src/state/mute.ts.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMute,
  writeMute,
  clearMute,
  isMuted,
  MUTE_FILENAME,
  type MuteFile,
} from "../../src/state/mute";

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-mute-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = new Date("2026-05-27T15:30:00Z");

function timedMute(untilMsOffset: number): MuteFile {
  return {
    schemaVersion: 1,
    until_ms: NOW.getTime() + untilMsOffset,
    indefinite: false,
    set_at: NOW.toISOString(),
  };
}

function indefiniteMute(): MuteFile {
  return {
    schemaVersion: 1,
    until_ms: null,
    indefinite: true,
    set_at: NOW.toISOString(),
  };
}

describe("readMute", () => {
  test("returns null when file is absent", () => {
    expect(readMute(homeBase)).toBeNull();
  });

  test("returns parsed MuteFile when valid timed mute exists", () => {
    writeMute(homeBase, timedMute(60_000));
    const m = readMute(homeBase);
    expect(m).not.toBeNull();
    expect(m?.indefinite).toBe(false);
    expect(m?.until_ms).toBe(NOW.getTime() + 60_000);
  });

  test("returns parsed MuteFile when valid indefinite mute exists", () => {
    writeMute(homeBase, indefiniteMute());
    const m = readMute(homeBase);
    expect(m?.indefinite).toBe(true);
    expect(m?.until_ms).toBeNull();
  });

  test("returns null on corrupt JSON", () => {
    writeFileSync(join(homeBase, MUTE_FILENAME), "{ broken");
    expect(readMute(homeBase)).toBeNull();
  });

  test("returns null on wrong schemaVersion", () => {
    writeFileSync(
      join(homeBase, MUTE_FILENAME),
      JSON.stringify({ schemaVersion: 99, until_ms: 1, indefinite: false, set_at: "x" }),
    );
    expect(readMute(homeBase)).toBeNull();
  });

  test("returns null when indefinite=true but until_ms is set", () => {
    writeFileSync(
      join(homeBase, MUTE_FILENAME),
      JSON.stringify({ schemaVersion: 1, until_ms: 123, indefinite: true, set_at: "x" }),
    );
    expect(readMute(homeBase)).toBeNull();
  });

  test("returns null when timed mute has non-numeric until_ms", () => {
    writeFileSync(
      join(homeBase, MUTE_FILENAME),
      JSON.stringify({ schemaVersion: 1, until_ms: "soon", indefinite: false, set_at: "x" }),
    );
    expect(readMute(homeBase)).toBeNull();
  });

  test("returns null on null root", () => {
    writeFileSync(join(homeBase, MUTE_FILENAME), "null");
    expect(readMute(homeBase)).toBeNull();
  });
});

describe("writeMute", () => {
  test("writes JSON to mute.json at homeBase and returns the path", () => {
    const path = writeMute(homeBase, timedMute(30 * 60_000));
    expect(path).toBe(join(homeBase, MUTE_FILENAME));
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as MuteFile;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.indefinite).toBe(false);
  });

  test("overwrites existing mute.json atomically", () => {
    writeMute(homeBase, timedMute(60_000));
    writeMute(homeBase, indefiniteMute());
    const m = readMute(homeBase);
    expect(m?.indefinite).toBe(true);
  });
});

describe("clearMute", () => {
  test("returns false when file is absent", () => {
    expect(clearMute(homeBase)).toBe(false);
  });

  test("deletes file and returns true when file exists", () => {
    writeMute(homeBase, timedMute(60_000));
    expect(clearMute(homeBase)).toBe(true);
    expect(existsSync(join(homeBase, MUTE_FILENAME))).toBe(false);
  });

  test("is idempotent — second call returns false", () => {
    writeMute(homeBase, timedMute(60_000));
    expect(clearMute(homeBase)).toBe(true);
    expect(clearMute(homeBase)).toBe(false);
  });
});

describe("isMuted", () => {
  test("returns false when no mute file", () => {
    expect(isMuted(homeBase, NOW)).toBe(false);
  });

  test("returns true for indefinite mute", () => {
    writeMute(homeBase, indefiniteMute());
    expect(isMuted(homeBase, NOW)).toBe(true);
  });

  test("returns true for fresh timed mute", () => {
    writeMute(homeBase, timedMute(60 * 60_000)); // 1h from NOW
    expect(isMuted(homeBase, NOW)).toBe(true);
  });

  test("returns false for expired timed mute (until_ms < now)", () => {
    writeMute(homeBase, timedMute(-60_000)); // 1min in past
    expect(isMuted(homeBase, NOW)).toBe(false);
  });

  test("returns false at exactly until_ms (strict >)", () => {
    writeMute(homeBase, timedMute(0));
    expect(isMuted(homeBase, NOW)).toBe(false);
  });

  test("returns false on corrupt file (fail-open)", () => {
    writeFileSync(join(homeBase, MUTE_FILENAME), "{ corrupt");
    expect(isMuted(homeBase, NOW)).toBe(false);
  });
});
