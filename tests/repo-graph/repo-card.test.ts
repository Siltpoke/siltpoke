import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoCard } from "../../src/repo-graph/repo-card";
import { computeProjHash } from "../../src/repo-graph/proj-hash";
import { anchoredRepoRoot, foreignRepoRoot, cleanupArchRepoRoots } from "../_shared/arch-repo-root";

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

afterAll(cleanupArchRepoRoots);

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

  // The card reads arch-model.json directly instead of going through
  // readArchModel, so it needs the repo scope applied here too — otherwise a
  // project that has never called a review CLI still lists four of them as its
  // own components, and the count is inflated to match.
  function writePollutedModel(dir: string): void {
    writeFileSync(
      join(dir, "arch-model.json"),
      JSON.stringify({
        boundary: "some-travel-app",
        bands: [{ label: { value: "Core", evidence: [] } }],
        nodes: [
          { title: { value: "Search Agent", evidence: [] } },
          { kind: "ext", provenance: "registry-declared", externalFamily: "codex", title: { value: "Codex CLI", evidence: [] } },
          { kind: "ext", provenance: "registry-declared", externalFamily: "qoder", title: { value: "Qoder CLI", evidence: [] } },
        ],
      }),
    );
  }

  test("out-of-scope registry-declared externals are not listed or counted", () => {
    const root = foreignRepoRoot();
    const dir = join(home, "repo-memory", computeProjHash(root));
    mkdirSync(dir, { recursive: true });
    writeMeta(dir, 10, "2026-08-21T00:00:00.000Z");
    writePollutedModel(dir);
    const card = loadRepoCard(home, root);
    expect(card?.component_titles).toEqual(["Search Agent"]);
    expect(card?.components).toBe(1);
  });

  test("a repo carrying the registry anchor keeps them", () => {
    const root = anchoredRepoRoot();
    const dir = join(home, "repo-memory", computeProjHash(root));
    mkdirSync(dir, { recursive: true });
    writeMeta(dir, 10, "2026-08-21T00:00:00.000Z");
    writePollutedModel(dir);
    const card = loadRepoCard(home, root);
    expect(card?.component_titles).toEqual(["Search Agent", "Codex CLI", "Qoder CLI"]);
    expect(card?.components).toBe(3);
  });

  test("the cached blurb is withheld while the model is still polluted", () => {
    // The blurb was WRITTEN from this model, so it describes a repo built partly
    // out of code-review CLIs. Filtering the component list does not rewrite a
    // paragraph — and nothing else invalidates repo-summary.json, so without
    // this it is served unchanged forever.
    const root = foreignRepoRoot();
    const dir = join(home, "repo-memory", computeProjHash(root));
    mkdirSync(dir, { recursive: true });
    writeMeta(dir, 10, "2026-08-21T00:00:00.000Z");
    writePollutedModel(dir);
    writeFileSync(join(dir, "repo-summary.json"), JSON.stringify({ text: "A travel app built on four review CLIs." }));
    expect(loadRepoCard(home, root)?.summary_text).toBeNull();
  });

  test("a clean model keeps its cached blurb (the suppression is targeted, not blanket)", () => {
    const root = foreignRepoRoot();
    const dir = join(home, "repo-memory", computeProjHash(root));
    mkdirSync(dir, { recursive: true });
    writeMeta(dir, 10, "2026-08-21T00:00:00.000Z");
    writeFileSync(
      join(dir, "arch-model.json"),
      JSON.stringify({ boundary: "clean-app", nodes: [{ title: { value: "Search Agent", evidence: [] } }] }),
    );
    writeFileSync(join(dir, "repo-summary.json"), JSON.stringify({ text: "A travel app." }));
    expect(loadRepoCard(home, root)?.summary_text).toBe("A travel app.");
  });

  test("an llm-callsite external survives even in a repo without the anchor", () => {
    const root = foreignRepoRoot();
    const dir = join(home, "repo-memory", computeProjHash(root));
    mkdirSync(dir, { recursive: true });
    writeMeta(dir, 10, "2026-08-21T00:00:00.000Z");
    writeFileSync(
      join(dir, "arch-model.json"),
      JSON.stringify({
        boundary: "other-agent-repo",
        nodes: [
          { kind: "ext", provenance: "llm-callsite", externalFamily: "codex", title: { value: "Codex CLI", evidence: [] } },
        ],
      }),
    );
    expect(loadRepoCard(home, root)?.component_titles).toEqual(["Codex CLI"]);
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
