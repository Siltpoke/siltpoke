// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_MODELS_AS_OF,
  type ModelListRunner,
  parseModelList,
  readModelLists,
  refreshModelList,
  refreshModelLists,
} from "../../src/brain/model-lists";

// Spec §11.3 / §12.5: the Change-model window lists every agent's own models,
// read from each CLI. Fixtures are real output: agy / qoder / codebuddy from
// evidence-49-real-runs/step1a/model-lists.txt; codex from `codex debug models`
// run 2026-10-14, trimmed to the four fields read here (the real reply is 472 KB).

const FIX = join(import.meta.dir, "..", "fixtures", "model-lists");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

describe("parseModelList — each CLI's own format", () => {
  test("agy: `id TAB name`, the banner line skipped; description = the display name", () => {
    const rows = parseModelList("agy", fixture("agy.txt"));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      id: "gemini-3.8-flash-high",
      family: "agy",
      description: "Gemini 3.8 Flash (High)",
      tier: false,
    });
  });

  test("qoder: one per line, header MODEL skipped; its four own tiers marked", () => {
    const rows = parseModelList("qoder", fixture("qoder.txt"));
    expect(rows).toHaveLength(17);
    expect(rows.filter((r) => r.tier).map((r) => r.id)).toEqual(["Auto", "Ultimate", "Performance", "Efficient"]);
    expect(rows.find((r) => r.id === "Qwen3.8-Max")).toEqual({
      id: "Qwen3.8-Max",
      family: "qoder",
      description: null,
      tier: false,
    });
  });

  test("codex: JSON models[], only visibility list, description from the CLI", () => {
    const rows = parseModelList("codex", fixture("codex.json"));
    expect(rows.map((r) => r.id)).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(rows[0]?.description).toBe("Frontier intelligence for the most demanding work.");
  });

  test("codebuddy: the --model help line's list; its seven own tiers marked", () => {
    const rows = parseModelList("codebuddy", fixture("codebuddy.txt"));
    expect(rows).toHaveLength(19);
    expect(rows.filter((r) => r.tier).map((r) => r.id)).toEqual([
      "default-model",
      "fast-model",
      "balanced-model",
      "primary-model",
      "deep-model",
      "hy4-preview",
      "hy3",
    ]);
    expect(rows.at(-1)?.id).toBe("kimi-k2.8-preview");
  });

  test("output that is not the expected shape → empty, never a throw", () => {
    expect(parseModelList("codex", "not json")).toEqual([]);
    expect(parseModelList("codebuddy", "no such line")).toEqual([]);
    expect(parseModelList("agy", "")).toEqual([]);
  });
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "model-lists-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const answers =
  (stdout: string): ModelListRunner =>
  async () => ({ stdout, code: 0 });

describe("readModelLists / refreshModelList — the saved lists", () => {
  test("never fetched: every CLI family empty with no date; claude is the dated hand list", () => {
    const lists = readModelLists(home);
    expect(lists.families.agy).toEqual({ entries: [], error: null, fetchedAt: null });
    expect(lists.families.claude.entries.map((e) => e.id)).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-opus-4-8",
    ]);
    expect(lists.families.claude.fetchedAt).toBe(CLAUDE_MODELS_AS_OF);
  });

  test("a refresh saves the list with its time, and it reads back", async () => {
    const now = new Date("2026-10-15T09:00:00.000Z");
    await refreshModelList(home, "agy", answers(fixture("agy.txt")), now);
    const lists = readModelLists(home);
    expect(lists.families.agy.entries).toHaveLength(6);
    expect(lists.families.agy.fetchedAt).toBe(now.toISOString());
    expect(lists.families.agy.error).toBeNull();
  });

  test("a CLI that does not answer in time: the saved list is kept, the error says so", async () => {
    await refreshModelList(home, "qoder", answers(fixture("qoder.txt")), new Date("2026-10-14T00:00:00.000Z"));
    const hang: ModelListRunner = () => new Promise(() => {});
    await refreshModelList(home, "qoder", hang, new Date(), 20);
    const q = readModelLists(home).families.qoder;
    expect(q.entries).toHaveLength(17);
    expect(q.error).toBe("no answer in 10s");
    expect(q.fetchedAt).toBe("2026-10-14T00:00:00.000Z");
  });

  test("a CLI that fails or prints nothing usable: error recorded, saved list kept", async () => {
    await refreshModelList(home, "agy", answers(fixture("agy.txt")));
    await refreshModelList(home, "agy", async () => ({ stdout: "", code: 1 }));
    const a = readModelLists(home).families.agy;
    expect(a.entries).toHaveLength(6);
    expect(a.error).toContain("exit 1");
  });

  test("a CLI that is not installed: the error names it", async () => {
    await refreshModelList(home, "codebuddy", async () => {
      throw new Error("ENOENT");
    });
    expect(readModelLists(home).families.codebuddy.error).toContain("codebuddy");
  });

  test("all families at once: each is saved, one slow CLI does not cost the others", async () => {
    const byCmd: ModelListRunner = async (argv) => {
      if (argv[0] === "agy") return { stdout: fixture("agy.txt"), code: 0 };
      if (argv[0] === "qodercli") return { stdout: fixture("qoder.txt"), code: 0 };
      if (argv[0] === "codebuddy") return { stdout: fixture("codebuddy.txt"), code: 0 };
      return new Promise(() => {}); // codex hangs
    };
    const lists = await refreshModelLists(home, undefined, byCmd, new Date(), 20);
    expect(lists.families.agy.entries).toHaveLength(6);
    expect(lists.families.qoder.entries).toHaveLength(17);
    expect(lists.families.codebuddy.entries).toHaveLength(19);
    expect(lists.families.codex.error).toBe("no answer in 10s");
  });

  test("two refreshes landing together keep each other's family", async () => {
    await Promise.all([
      refreshModelList(home, "agy", answers(fixture("agy.txt"))),
      refreshModelList(home, "qoder", answers(fixture("qoder.txt"))),
    ]);
    const lists = readModelLists(home);
    expect(lists.families.agy.entries).toHaveLength(6);
    expect(lists.families.qoder.entries).toHaveLength(17);
  });

  test("a corrupt cache file reads as never fetched", () => {
    writeFileSync(join(home, "model-lists.json"), "{ nope");
    expect(readModelLists(home).families.agy.fetchedAt).toBeNull();
  });
});
