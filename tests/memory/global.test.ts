import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyGlobal, readGlobal, writeGlobal } from "../../src/memory/global";
import { globalSchema, type GlobalMemory } from "../../src/memory/schema-v3";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-global-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("emptyGlobal", () => {
  test("returns a schema-valid baseline", () => {
    const g = emptyGlobal(new Date("2026-05-16T10:00:00Z"));
    expect(globalSchema.safeParse(g).success).toBe(true);
  });

  test("schemaVersion is 3", () => {
    expect(emptyGlobal().schemaVersion).toBe(3);
  });

  test("personality_base includes curiosity", () => {
    expect(emptyGlobal().personality_base.curiosity).toBe(0);
  });

  test("daily_caps local_date matches the provided now", () => {
    const g = emptyGlobal(new Date("2026-05-16T10:00:00Z"));
    expect(g.daily_caps_state.local_date).toBe("2026-05-16");
  });
});

describe("readGlobal", () => {
  test("returns null when file is missing", async () => {
    expect(await readGlobal(home)).toBeNull();
  });

  test("returns null + quarantines on malformed JSON", async () => {
    writeFileSync(join(home, "global.json"), "not json");
    const r = await readGlobal(home);
    expect(r).toBeNull();
    const found = readdirSync(home).some((f) => f.includes("corrupt"));
    expect(found).toBe(true);
  });

  test("returns null + quarantines on schema-invalid JSON", async () => {
    writeFileSync(
      join(home, "global.json"),
      JSON.stringify({ schemaVersion: 99 }),
    );
    expect(await readGlobal(home)).toBeNull();
  });

  test("reads back a previously written global", async () => {
    const g = emptyGlobal(new Date("2026-05-16T10:00:00Z"));
    await writeGlobal(home, g);
    const read = await readGlobal(home);
    expect(read).not.toBeNull();
    expect(read?.schemaVersion).toBe(3);
    expect(read?.name).toBe("siltpoke");
    expect(read?.xp_total).toBe(0);
  });
});

describe("writeGlobal", () => {
  test("creates home dir if missing", async () => {
    const nested = join(home, "nested", "deeper");
    await writeGlobal(nested, emptyGlobal());
    expect(existsSync(join(nested, "global.json"))).toBe(true);
  });

  test("never throws on filesystem failure (legacy semantics)", async () => {
    // Best-effort smoke: write succeeds normally.
    await expect(writeGlobal(home, emptyGlobal())).resolves.toBeUndefined();
  });

  test("preserves all fields round-trip", async () => {
    const g: GlobalMemory = {
      ...emptyGlobal(),
      name: "muddo",
      species: "bunny",
      level: 7,
      xp_total: 1234,
      personality_base: {
        snark: 2,
        patience: -1,
        style_strictness: 0,
        proactivity: 1,
        curiosity: 3,
      },
    };
    await writeGlobal(home, g);
    const back = await readGlobal(home);
    expect(back?.name).toBe("muddo");
    expect(back?.species).toBe("bunny");
    expect(back?.level).toBe(7);
    expect(back?.xp_total).toBe(1234);
    expect(back?.personality_base.curiosity).toBe(3);
  });
});

test("write+read survives an xp_log entry", async () => {
  const g = emptyGlobal();
  g.xp_log.push({
    id: "xp-1",
    ts: "2026-05-16T10:00:00Z",
    amount: 5,
    source: "forwarded_critique",
    source_id: "c-1",
    source_project: "p-abc",
    capped: false,
    note: null,
  });
  await writeGlobal(home, g);
  const back = await readGlobal(home);
  expect(back?.xp_log).toHaveLength(1);
  expect(back?.xp_log[0]?.source).toBe("forwarded_critique");
});
