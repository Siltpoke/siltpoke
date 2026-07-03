import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir, cwd as getCwd } from "node:process";
import {
  eventFragmentSchema,
  applyEventFragments,
  activeEventFragments,
  EVENT_TTL_DAYS,
  type EventFragment,
  type EventFragmentDraft,
} from "../../src/memory/event-fragment";
import { emptyMemory, readMemory, writeMemory, type CoreMemory } from "../../src/memory/memory";
import { migrateV2toV3 } from "../../src/memory/migrate-v3";

const MS_PER_DAY = 86_400_000;

function draft(text: string): EventFragmentDraft {
  return {
    text,
    occurred_at: "2026-07-01T10:00:00Z",
    sources: [{ kind: "commit", ref: "abc123" }],
    entities: [],
    confidence: 0.7,
    learned_from_stream: "commit",
  };
}

function fragment(id: string, text: string, expires_at: string): EventFragment {
  return {
    id,
    text,
    created_at: "2026-07-01T00:00:00Z",
    occurred_at: "2026-07-01T00:00:00Z",
    expires_at,
    sources: [{ kind: "commit", ref: "sha" }],
    entities: [],
    confidence: 0.7,
    learned_from_stream: "commit",
  };
}

describe("eventFragmentSchema", () => {
  test("parses a valid fragment", () => {
    const parsed = eventFragmentSchema.parse({
      id: "ev-1",
      text: "shipped the repo-graph index",
      created_at: "2026-07-01T00:00:00Z",
      occurred_at: "2026-06-30T12:00:00Z",
      expires_at: "2026-07-31T00:00:00Z",
      sources: [{ kind: "commit", ref: "deadbeef" }],
      entities: [{ name: "repo-graph" }],
      confidence: 0.9,
      learned_from_stream: "commit",
    });
    expect(parsed.text).toBe("shipped the repo-graph index");
    expect(parsed.sources).toHaveLength(1);
  });

  test("rejects an empty sources array (min 1)", () => {
    const r = eventFragmentSchema.safeParse({
      id: "ev-1",
      text: "no source",
      created_at: "t",
      occurred_at: "t",
      expires_at: "t",
      sources: [],
      learned_from_stream: "commit",
    });
    expect(r.success).toBe(false);
  });

  test("rejects a missing occurred_at", () => {
    const r = eventFragmentSchema.safeParse({
      id: "ev-1",
      text: "no occurred_at",
      created_at: "t",
      expires_at: "t",
      sources: [{ kind: "commit", ref: "sha" }],
      learned_from_stream: "commit",
    });
    expect(r.success).toBe(false);
  });

  test("entities defaults to []", () => {
    const parsed = eventFragmentSchema.parse({
      id: "ev-1",
      text: "defaults",
      created_at: "t",
      occurred_at: "t",
      expires_at: "t",
      sources: [{ kind: "critique", ref: "c-1" }],
      learned_from_stream: "critique",
    });
    expect(parsed.entities).toEqual([]);
    expect(parsed.confidence).toBe(0.7);
  });
});

describe("applyEventFragments", () => {
  const now = new Date("2026-07-01T00:00:00.000Z");

  test("appends incoming fragments with id + created_at + expires_at", () => {
    const mem = emptyMemory();
    const out = applyEventFragments(mem, [draft("shipped X")], now);
    expect(out.event_fragments).toHaveLength(1);
    const f = out.event_fragments[0]!;
    expect(f.id).toMatch(/^ev-/);
    expect(f.created_at).toBe(now.toISOString());
    expect(new Date(f.expires_at).getTime()).toBe(
      now.getTime() + EVENT_TTL_DAYS * MS_PER_DAY,
    );
    expect(f.text).toBe("shipped X");
  });

  test("dedups a same-normalized-text fragment already in the store", () => {
    const mem: CoreMemory = {
      ...emptyMemory(),
      event_fragments: [fragment("ev-old", "Shipped   X", "2026-08-01T00:00:00Z")],
    };
    const out = applyEventFragments(mem, [draft("shipped x")], now);
    expect(out.event_fragments).toHaveLength(1);
  });

  test("dedups duplicates within the incoming batch", () => {
    const out = applyEventFragments(emptyMemory(), [draft("same"), draft("SAME")], now);
    expect(out.event_fragments).toHaveLength(1);
  });

  test("does not mutate the input memory", () => {
    const mem = emptyMemory();
    const before = mem.event_fragments;
    applyEventFragments(mem, [draft("shipped X")], now);
    expect(mem.event_fragments).toBe(before);
    expect(mem.event_fragments).toHaveLength(0);
  });
});

describe("activeEventFragments", () => {
  test("filters expired fragments, keeps live ones", () => {
    const now = new Date("2026-07-15T00:00:00.000Z");
    const mem: CoreMemory = {
      ...emptyMemory(),
      event_fragments: [
        fragment("ev-live", "still valid", "2026-08-01T00:00:00Z"),
        fragment("ev-dead", "expired", "2026-07-01T00:00:00Z"),
      ],
    };
    const active = activeEventFragments(mem, now);
    expect(active.map((f) => f.id)).toEqual(["ev-live"]);
  });
});

describe("V3 round-trip", () => {
  let home: string;
  let projectCwd: string;
  let prevCwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-ev-home-"));
    projectCwd = mkdtempSync(join(tmpdir(), "siltpoke-ev-cwd-"));
    mkdirSync(join(projectCwd, ".git"));
    prevCwd = getCwd();
    chdir(projectCwd);
  });

  afterEach(() => {
    chdir(prevCwd);
    rmSync(home, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  test("event_fragments survive writeMemory → readMemory through the V3 split/merge", async () => {
    // Seed a minimal v2 store then migrate to the v3 layout.
    writeFileSync(join(home, "memory.json"), JSON.stringify(emptyMemory()));
    await migrateV2toV3({ home, cwd: projectCwd });

    const m1 = (await readMemory(home))!;
    const now = new Date("2026-07-01T00:00:00.000Z");
    const m2 = applyEventFragments(m1, [draft("shipped the V3 round-trip")], now);
    await writeMemory(home, m2);

    const m3 = (await readMemory(home))!;
    expect(m3.event_fragments).toHaveLength(1);
    expect(m3.event_fragments[0]!.text).toBe("shipped the V3 round-trip");
    expect(m3.event_fragments[0]!.id).toMatch(/^ev-/);
  });
});
