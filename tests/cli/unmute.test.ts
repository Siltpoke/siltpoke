/**
 * Tests for src/cli/unmute.ts.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUnmute, formatUnmuteHuman, formatUnmuteJson } from "../../src/cli/unmute";
import { writeMute, MUTE_FILENAME, type MuteFile } from "../../src/state/mute";

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-unmute-cli-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function plantMute(): void {
  const mute: MuteFile = {
    schemaVersion: 1,
    until_ms: Date.now() + 60_000,
    indefinite: false,
    set_at: new Date().toISOString(),
  };
  writeMute(homeBase, mute);
}

describe("runUnmute", () => {
  test("removes existing mute.json and reports was_muted=true", () => {
    plantMute();
    expect(existsSync(join(homeBase, MUTE_FILENAME))).toBe(true);
    const r = runUnmute({ homeBase });
    expect(r.muted).toBe(false);
    expect(r.was_muted).toBe(true);
    expect(existsSync(join(homeBase, MUTE_FILENAME))).toBe(false);
  });

  test("no-op when no mute.json exists; reports was_muted=false", () => {
    const r = runUnmute({ homeBase });
    expect(r.muted).toBe(false);
    expect(r.was_muted).toBe(false);
  });

  test("idempotent — second call returns was_muted=false", () => {
    plantMute();
    expect(runUnmute({ homeBase }).was_muted).toBe(true);
    expect(runUnmute({ homeBase }).was_muted).toBe(false);
  });
});

describe("formatters", () => {
  test("human says 'unmuted' when was_muted=true", () => {
    const out = formatUnmuteHuman({ muted: false, was_muted: true });
    expect(out).toContain("Siltpoke unmuted");
  });

  test("human says 'wasn't muted' when was_muted=false", () => {
    const out = formatUnmuteHuman({ muted: false, was_muted: false });
    expect(out).toContain("wasn't muted");
  });

  test("json emits structured output", () => {
    const out = formatUnmuteJson({ muted: false, was_muted: true });
    const parsed = JSON.parse(out);
    expect(parsed.muted).toBe(false);
    expect(parsed.was_muted).toBe(true);
  });
});
