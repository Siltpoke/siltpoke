import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoCard } from "../../src/repo-graph/repo-card";
import { computeProjHash } from "../../src/repo-graph/proj-hash";

let home: string;
const ROOT = "/code/demo";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-card-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function repoDir(): string {
  const dir = join(home, "repo-memory", computeProjHash(ROOT));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMeta(dir: string, files: number, indexedAt: string): void {
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ last_indexed_ts: indexedAt, counters: { nodes: { file: files } } }),
  );
}

describe("loadRepoCard", () => {
  test("returns null when the repo was never indexed", () => {
    expect(loadRepoCard(home, ROOT)).toBeNull();
  });

  test("reads file count + index time from meta.json", () => {
    writeMeta(repoDir(), 499, "2026-06-22T19:35:33.457Z");
    const card = loadRepoCard(home, ROOT);
    expect(card?.files).toBe(499);
    expect(card?.indexed_at).toBe("2026-06-22T19:35:33.457Z");
    expect(card?.components).toBe(0); // no arch-model yet
    expect(card?.areas).toEqual([]);
    expect(card?.summary_text).toBeNull();
  });

  test("unwraps arch-model claim-wrapped bands + nodes", () => {
    const dir = repoDir();
    writeMeta(dir, 499, "2026-06-22T19:35:33.457Z");
    writeFileSync(
      join(dir, "arch-model.json"),
      JSON.stringify({
        boundary: "demo",
        bands: [
          { label: { value: "Surfaces", evidence: [], tier: "cited" } },
          { label: { value: "Server & UI", evidence: [] } },
        ],
        nodes: [
          { title: { value: "Daemon", evidence: [] } },
          { title: { value: "Critic", evidence: [] } },
          { title: { value: "Brain", evidence: [] } },
        ],
      }),
    );
    const card = loadRepoCard(home, ROOT);
    expect(card?.areas).toEqual(["Surfaces", "Server & UI"]);
    expect(card?.component_titles).toEqual(["Daemon", "Critic", "Brain"]);
    expect(card?.components).toBe(3);
  });

  test("reads the cached summary blurb when present", () => {
    const dir = repoDir();
    writeMeta(dir, 10, "2026-06-22T19:35:33.457Z");
    writeFileSync(
      join(dir, "repo-summary.json"),
      JSON.stringify({ text: "A local AI coding companion.", model: "claude-haiku-4-5" }),
    );
    expect(loadRepoCard(home, ROOT)?.summary_text).toBe("A local AI coding companion.");
  });

  test("blank/whitespace summary text is treated as not-generated (null)", () => {
    const dir = repoDir();
    writeMeta(dir, 10, "2026-06-22T19:35:33.457Z");
    writeFileSync(join(dir, "repo-summary.json"), JSON.stringify({ text: "   " }));
    expect(loadRepoCard(home, ROOT)?.summary_text).toBeNull();
  });

  test("corrupt arch-model degrades to stats-only without throwing", () => {
    const dir = repoDir();
    writeMeta(dir, 7, "2026-06-22T19:35:33.457Z");
    writeFileSync(join(dir, "arch-model.json"), "not json");
    const card = loadRepoCard(home, ROOT);
    expect(card?.files).toBe(7);
    expect(card?.areas).toEqual([]);
  });
});
