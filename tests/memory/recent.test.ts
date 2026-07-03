import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRecent,
  readRecent,
  resolveRecentPath,
  type RecentEntry,
} from "../../src/memory/recent";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-recent-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function entry(id: string, verdict: RecentEntry["verdict"] = "forwarded"): RecentEntry {
  return {
    ts: new Date().toISOString(),
    critique_id: id,
    verdict,
    reason: null,
  };
}

test("readRecent returns empty array when file missing", async () => {
  const out = await readRecent(join(tmp, "recent.jsonl"));
  expect(out).toEqual([]);
});

test("appendRecent then readRecent round-trips", async () => {
  const p = join(tmp, "recent.jsonl");
  await appendRecent(p, entry("c-aaaa"));
  await appendRecent(p, entry("c-bbbb"));
  const out = await readRecent(p);
  expect(out.length).toBe(2);
  expect(out[0]?.critique_id).toBe("c-aaaa");
  expect(out[1]?.critique_id).toBe("c-bbbb");
});

test("rolling cap drops oldest when over maxEntries", async () => {
  const p = join(tmp, "recent.jsonl");
  for (let i = 0; i < 25; i++) {
    await appendRecent(p, entry(`c-${i.toString().padStart(4, "0")}`), 5);
  }
  const out = await readRecent(p, 5);
  expect(out.length).toBe(5);
  expect(out[0]?.critique_id).toBe("c-0020");
  expect(out[4]?.critique_id).toBe("c-0024");
});

test("malformed JSONL lines are skipped", async () => {
  const p = join(tmp, "recent.jsonl");
  writeFileSync(
    p,
    [
      JSON.stringify(entry("c-ok")),
      "{not json",
      JSON.stringify({ ts: "x", critique_id: "y", verdict: "INVALID" }),
      JSON.stringify(entry("c-good")),
    ].join("\n"),
  );
  const out = await readRecent(p);
  expect(out.length).toBe(2);
  expect(out.map((e) => e.critique_id)).toEqual(["c-ok", "c-good"]);
});

test("resolveRecentPath uses cwd .siltpoke when cwd provided", () => {
  const cwd = "/Users/test/project";
  const home = "/Users/test/.siltpoke";
  expect(resolveRecentPath(cwd, home)).toBe(
    "/Users/test/project/.siltpoke/recent_feedback.jsonl",
  );
});

test("resolveRecentPath falls back to home when cwd empty", () => {
  expect(resolveRecentPath(undefined, "/Users/test/.siltpoke")).toBe(
    "/Users/test/.siltpoke/recent_feedback.jsonl",
  );
  expect(resolveRecentPath("", "/Users/test/.siltpoke")).toBe(
    "/Users/test/.siltpoke/recent_feedback.jsonl",
  );
});
