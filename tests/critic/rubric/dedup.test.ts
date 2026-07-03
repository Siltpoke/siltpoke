import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suppressionKey,
  partitionByRecency,
  loadSeen,
  saveSeen,
  ledgerPath,
  dedupRubricTriggers,
  type SeenLedger,
} from "../../../src/critic/rubric/dedup";
import type { RubricTrigger } from "../../../src/critic/rubric/types";

function trig(over: Partial<RubricTrigger> & { file: string; message: string }): RubricTrigger {
  return {
    rule_id: over.rule_id ?? "god-file",
    tier: over.tier ?? 1,
    severity: over.severity ?? "high",
    file: over.file,
    line: over.line ?? 1,
    end_line: over.end_line,
    snippet: over.snippet ?? "",
    message: over.message,
    suggested_fix: over.suggested_fix,
  };
}

const NOW = new Date("2026-06-27T12:00:00Z");
const TTL = 24 * 60 * 60 * 1000;

describe("suppressionKey", () => {
  test("same rule+file+message → same key", () => {
    const a = trig({ file: "/a.ts", message: "File is 900 lines (threshold: 500)." });
    const b = trig({ file: "/a.ts", message: "File is 900 lines (threshold: 500)." });
    expect(suppressionKey(a)).toBe(suppressionKey(b));
  });
  test("different message (LOC changed) → different key", () => {
    const a = trig({ file: "/a.ts", message: "File is 900 lines (threshold: 500)." });
    const b = trig({ file: "/a.ts", message: "File is 950 lines (threshold: 500)." });
    expect(suppressionKey(a)).not.toBe(suppressionKey(b));
  });
  test("different file → different key", () => {
    const a = trig({ file: "/a.ts", message: "m" });
    const b = trig({ file: "/b.ts", message: "m" });
    expect(suppressionKey(a)).not.toBe(suppressionKey(b));
  });
  test("different rule → different key", () => {
    const a = trig({ rule_id: "god-file", file: "/a.ts", message: "m" });
    const b = trig({ rule_id: "god-function", file: "/a.ts", message: "m" });
    expect(suppressionKey(a)).not.toBe(suppressionKey(b));
  });
});

describe("partitionByRecency", () => {
  test("first sighting surfaces and is stamped", () => {
    const t = trig({ file: "/a.ts", message: "m900" });
    const { surfaced, nextSeen } = partitionByRecency([t], {}, NOW, TTL);
    expect(surfaced).toHaveLength(1);
    expect(nextSeen[suppressionKey(t)]).toBe(NOW.toISOString());
  });

  test("a flag seen within TTL is suppressed", () => {
    const t = trig({ file: "/a.ts", message: "m900" });
    const seen: SeenLedger = { [suppressionKey(t)]: "2026-06-27T06:00:00Z" }; // 6h ago
    const { surfaced } = partitionByRecency([t], seen, NOW, TTL);
    expect(surfaced).toHaveLength(0);
  });

  test("suppressed flag keeps its ORIGINAL timestamp (suppression expires from last surfacing)", () => {
    const t = trig({ file: "/a.ts", message: "m900" });
    const key = suppressionKey(t);
    const original = "2026-06-27T06:00:00Z";
    const { nextSeen } = partitionByRecency([t], { [key]: original }, NOW, TTL);
    expect(nextSeen[key]).toBe(original); // NOT refreshed to NOW
  });

  test("a flag last seen beyond TTL re-surfaces and is re-stamped", () => {
    const t = trig({ file: "/a.ts", message: "m900" });
    const key = suppressionKey(t);
    const seen: SeenLedger = { [key]: "2026-06-26T06:00:00Z" }; // 30h ago > TTL
    const { surfaced, nextSeen } = partitionByRecency([t], seen, NOW, TTL);
    expect(surfaced).toHaveLength(1);
    expect(nextSeen[key]).toBe(NOW.toISOString());
  });

  test("expired ledger entries are pruned", () => {
    const stale = "god-file::/old.ts::deadbeef";
    const { nextSeen } = partitionByRecency([], { [stale]: "2026-06-25T00:00:00Z" }, NOW, TTL);
    expect(nextSeen[stale]).toBeUndefined();
  });

  test("a changed flag (new message) surfaces even though the file was recently flagged", () => {
    const old = trig({ file: "/a.ts", message: "File is 900 lines (threshold: 500)." });
    const grown = trig({ file: "/a.ts", message: "File is 1200 lines (threshold: 500)." });
    const seen: SeenLedger = { [suppressionKey(old)]: "2026-06-27T11:00:00Z" };
    const { surfaced } = partitionByRecency([grown], seen, NOW, TTL);
    expect(surfaced).toHaveLength(1);
  });

  test("intra-Stop duplicate triggers collapse to one", () => {
    const t = trig({ file: "/a.ts", message: "m900" });
    const { surfaced } = partitionByRecency([t, { ...t }], {}, NOW, TTL);
    expect(surfaced).toHaveLength(1);
  });

  test("does not mutate the input ledger", () => {
    const t = trig({ file: "/a.ts", message: "m900" });
    const seen: SeenLedger = {};
    partitionByRecency([t], seen, NOW, TTL);
    expect(Object.keys(seen)).toHaveLength(0);
  });
});

describe("loadSeen / saveSeen", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-dedup-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("missing ledger → empty", () => {
    expect(loadSeen(home)).toEqual({});
  });

  test("round-trips", () => {
    const led: SeenLedger = { "god-file::/a.ts::abc": NOW.toISOString() };
    saveSeen(home, led);
    expect(existsSync(ledgerPath(home))).toBe(true);
    expect(loadSeen(home)).toEqual(led);
  });

  test("corrupt ledger → empty (non-critical cache)", () => {
    writeFileSync(ledgerPath(home), "not json");
    expect(loadSeen(home)).toEqual({});
  });

  test("non-string values are dropped", () => {
    writeFileSync(ledgerPath(home), JSON.stringify({ good: NOW.toISOString(), bad: 42 }));
    expect(loadSeen(home)).toEqual({ good: NOW.toISOString() });
  });
});

describe("dedupRubricTriggers (integration)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-dedup-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.SILTPOKE_RUBRIC_DEDUP;
  });

  test("undefined homeBase → pass-through (test/legacy path)", () => {
    const t = trig({ file: "/a.ts", message: "m" });
    expect(dedupRubricTriggers([t], undefined, NOW)).toHaveLength(1);
  });

  test("SILTPOKE_RUBRIC_DEDUP=0 disables suppression", () => {
    process.env.SILTPOKE_RUBRIC_DEDUP = "0";
    const t = trig({ file: "/a.ts", message: "m" });
    dedupRubricTriggers([t], home, NOW);
    expect(dedupRubricTriggers([t], home, NOW)).toHaveLength(1); // still surfaced
  });

  test("second identical Stop is suppressed; persists across calls", () => {
    const t = trig({ file: "/a.ts", message: "m900" });
    expect(dedupRubricTriggers([t], home, NOW)).toHaveLength(1); // 1st surfaces
    const later = new Date("2026-06-27T13:00:00Z"); // 1h later
    expect(dedupRubricTriggers([t], home, later)).toHaveLength(0); // 2nd suppressed
  });
});
