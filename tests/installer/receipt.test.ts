// [61] PR 2, S1 (spec 2026-10-02-61-full-uninstall-design.md §2, §2.1): the
// install receipt. Every install path writes an entry BEFORE it acts
// (`recordBefore`, state "pending") and flips it after (`markDone`). The
// planner later trusts "done" and checks the disk for "pending" — so the
// properties pinned here are exactly the ones that make that safe.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProjectRoot,
  markDone,
  type NewReceiptEntry,
  type ReceiptEntry,
  readReceipt,
  receiptPath,
  recordBefore,
} from "../../src/installer/receipt";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-receipt-"));
  // Explicit env: never inherit SILTPOKE_HOME from the machine running the
  // test, or this would write the real ~/.siltpoke/receipt.json.
  env = { HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const OPTS = { now: new Date("2026-10-03T10:00:00Z"), version: "1.3.0" };

function hook(byUs: boolean): NewReceiptEntry {
  return {
    id: "hook:codex",
    kind: "host-hook",
    target: "~/.codex/hooks.json",
    byUs,
    level: "uninstall",
    undo: { type: "remove-json-key", path: "hooks.Stop", match: "siltpoke" },
  };
}

const GOOD_ENTRY: ReceiptEntry = {
  ...hook(true),
  state: "done",
  at: "2026-10-03T10:00:00.000Z",
  siltpokeVersion: "1.3.0",
};

function rawFile(): unknown {
  return JSON.parse(readFileSync(receiptPath(env), "utf8"));
}

describe("receiptPath", () => {
  test("lives in ~/.siltpoke by default", () => {
    expect(receiptPath(env)).toBe(join(home, ".siltpoke", "receipt.json"));
  });
  test("respects SILTPOKE_HOME", () => {
    const alt = join(home, "alt");
    expect(receiptPath({ HOME: home, SILTPOKE_HOME: alt })).toBe(join(alt, "receipt.json"));
  });
});

describe("readReceipt", () => {
  test("no file → null", () => {
    expect(readReceipt(env)).toBeNull();
  });
  test("not JSON → null, never throws", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(receiptPath(env), "{ not json");
    expect(readReceipt(env)).toBeNull();
  });
  test("a well-formed file reads back (positive control for the shape check)", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(receiptPath(env), JSON.stringify({ version: 1, entries: [GOOD_ENTRY], projects: ["/w"] }));
    expect(readReceipt(env)?.entries).toEqual([GOOD_ENTRY]);
  });
  test("JSON of the wrong shape → null", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    for (const bad of [
      [],
      { version: 2, entries: [], projects: [] },
      { version: 1, entries: "x", projects: [] },
      { version: 1, entries: [{ id: "a" }], projects: [] },
      { version: 1, entries: [{ ...GOOD_ENTRY, kind: "registry-key" }], projects: [] },
      { version: 1, entries: [{ ...GOOD_ENTRY, state: "half" }], projects: [] },
      { version: 1, entries: [{ ...GOOD_ENTRY, byUs: "yes" }], projects: [] },
      { version: 1, entries: [], projects: [3] },
    ]) {
      writeFileSync(receiptPath(env), JSON.stringify(bad));
      expect(readReceipt(env)).toBeNull();
    }
  });
});

describe("recordBefore / markDone", () => {
  test("recordBefore writes a pending entry with time and version, before anything else exists", () => {
    recordBefore(hook(true), env, OPTS);
    const r = readReceipt(env);
    expect(r).not.toBeNull();
    expect(r?.entries).toHaveLength(1);
    expect(r?.entries[0]).toEqual({
      ...hook(true),
      state: "pending",
      at: "2026-10-03T10:00:00.000Z",
      siltpokeVersion: "1.3.0",
    });
    expect(r?.projects).toEqual([]);
  });

  test("pending then done: markDone flips only that entry", () => {
    recordBefore(hook(true), env, OPTS);
    recordBefore({ ...hook(true), id: "hook:qoder", target: "~/.qoder/settings.json" }, env, OPTS);
    expect(markDone("hook:codex", env)).toBe(true);
    const states = readReceipt(env)?.entries.map((e) => [e.id, e.state]);
    expect(states).toEqual([
      ["hook:codex", "done"],
      ["hook:qoder", "pending"],
    ]);
  });

  test("a crash between recordBefore and markDone leaves the entry pending — nothing claims done", () => {
    recordBefore(hook(true), env, OPTS);
    // (the action "crashes" here: markDone is never called)
    const r = readReceipt(env);
    expect(r?.entries[0]?.state).toBe("pending");
    expect(r?.entries.some((e) => e.state === "done")).toBe(false);
  });

  test("markDone on an unknown id changes nothing and says so", () => {
    recordBefore(hook(true), env, OPTS);
    const before = readFileSync(receiptPath(env), "utf8");
    expect(markDone("hook:nope", env)).toBe(false);
    expect(readFileSync(receiptPath(env), "utf8")).toBe(before);
  });

  test("markDone with no receipt at all writes nothing", () => {
    expect(markDone("hook:codex", env)).toBe(false);
    expect(existsSync(receiptPath(env))).toBe(false);
  });

  test("re-running the same install path keeps ONE entry, updated in place and pending again", () => {
    recordBefore(hook(true), env, OPTS);
    markDone("hook:codex", env);
    const later = { now: new Date("2026-10-04T00:00:00Z"), version: "1.4.0" };
    recordBefore({ ...hook(true), target: "~/.codex/hooks2.json" }, env, later);
    const r = readReceipt(env);
    expect(r?.entries).toHaveLength(1);
    expect(r?.entries[0]).toMatchObject({
      id: "hook:codex",
      target: "~/.codex/hooks2.json",
      state: "pending",
      at: "2026-10-04T00:00:00.000Z",
      siltpokeVersion: "1.4.0",
    });
  });

  test("byUs is sticky: once false (it was there before us), a later true never flips it", () => {
    recordBefore(hook(false), env, OPTS);
    markDone("hook:codex", env);
    recordBefore(hook(true), env, OPTS);
    expect(readReceipt(env)?.entries[0]?.byUs).toBe(false);
  });

  test("first observation wins: once true (we put it there), a re-run that finds it present never flips it to false", () => {
    // The re-run sees the thing because WE installed it last time; that is not "it was there before".
    recordBefore(hook(true), env, OPTS);
    markDone("hook:codex", env);
    recordBefore(hook(false), env, OPTS);
    expect(readReceipt(env)?.entries[0]?.byUs).toBe(true);
  });

  // Decided overnight (orchestrator), the maintainer to confirm: byUs freezes once the entry is DONE.
  test("a PENDING entry's byUs may be replaced: pending-true later seen present records false (we'd rather not offer removal)", () => {
    recordBefore(hook(true), env, OPTS); // installer started, never finished
    recordBefore(hook(false), env, OPTS);
    expect(readReceipt(env)?.entries[0]?.byUs).toBe(false);
  });

  test("a PENDING entry's byUs may be replaced the other way too (the later observation is the better one)", () => {
    recordBefore(hook(false), env, OPTS);
    recordBefore(hook(true), env, OPTS);
    expect(readReceipt(env)?.entries[0]?.byUs).toBe(true);
  });

  test("unknown version is stored as null, not invented", () => {
    recordBefore(hook(true), env, { now: OPTS.now, version: null });
    expect(readReceipt(env)?.entries[0]?.siltpokeVersion).toBeNull();
  });

  test("an unreadable receipt is moved aside, not overwritten, and a fresh one is started", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(receiptPath(env), "{ not json");
    recordBefore(hook(true), env, OPTS);
    expect(readReceipt(env)?.entries).toHaveLength(1);
    const aside = readdirSync(join(home, ".siltpoke")).filter((n) => n.startsWith("receipt.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(home, ".siltpoke", aside[0] as string), "utf8")).toBe("{ not json");
  });

  test("the file on disk has the spec's top-level shape", () => {
    recordBefore(hook(true), env, OPTS);
    expect(Object.keys(rawFile() as object).sort()).toEqual(["entries", "projects", "version"]);
    expect((rawFile() as { version: number }).version).toBe(1);
  });

  test("no temp files are left beside the receipt", () => {
    recordBefore(hook(true), env, OPTS);
    markDone("hook:codex", env);
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["receipt.json"]);
  });
});

describe("addProjectRoot", () => {
  test("adds a root once; a second add is a no-op", () => {
    addProjectRoot("/work/a", env);
    addProjectRoot("/work/a", env);
    addProjectRoot("/work/b", env);
    expect(readReceipt(env)?.projects).toEqual(["/work/a", "/work/b"]);
  });
  test("keeps existing entries", () => {
    recordBefore(hook(true), env, OPTS);
    addProjectRoot("/work/a", env);
    expect(readReceipt(env)?.entries.map((e) => e.id)).toEqual(["hook:codex"]);
  });
});

// Every install path will call recordBefore with `process.env` by default. A
// test that forgets to pass a sandbox env would then write the developer's
// real receipt (memory: test-omitting-env-writes-the-real-install). Under
// `bun test` the module refuses that one path, loudly. The process HOME is
// pointed at the sandbox for these tests, so even a broken guard writes only
// into the temp dir.
describe("refuses the real home's receipt under bun test", () => {
  let realHome: string | undefined;
  beforeEach(() => {
    realHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = realHome;
  });

  test("recordBefore / addProjectRoot throw and write nothing", () => {
    expect(process.env.NODE_ENV).toBe("test");
    const asIfReal = { HOME: home };
    expect(() => recordBefore(hook(true), asIfReal, OPTS)).toThrow(/sandbox/);
    expect(() => addProjectRoot("/work/a", asIfReal)).toThrow(/sandbox/);
    expect(existsSync(join(home, ".siltpoke", "receipt.json"))).toBe(false);
  });

  test("an unreadable real receipt is not moved aside either", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "receipt.json"), "{ not json");
    expect(() => recordBefore(hook(true), { HOME: home }, OPTS)).toThrow(/sandbox/);
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["receipt.json"]);
  });

  test("a SILTPOKE_HOME elsewhere is allowed (positive control)", () => {
    const alt = { HOME: home, SILTPOKE_HOME: join(home, "alt") };
    recordBefore(hook(true), alt, OPTS);
    expect(markDone("hook:codex", alt)).toBe(true);
  });
});
