/**
 * repo-registry tests (multi-repo picker).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enumerateRepos,
  removeRepoIndex,
  resolveRepoByHash,
  restorePreservedArchModel,
} from "../../src/repo-graph/repo-registry";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-repo-registry-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedRepo(projHash: string, meta: unknown | null): void {
  const dir = join(home, "repo-memory", projHash);
  mkdirSync(dir, { recursive: true });
  if (meta !== null) {
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  }
}

const VALID_META = {
  schemaVersion: 1,
  project_root: "/projects/myrepo",
  proj_hash: "abc",
  last_indexed_ts: "2026-05-28T10:00:00.000Z",
  build_duration_ms: 1234,
  counters: { files_walked: 5 },
};

describe("enumerateRepos — status derivation", () => {
  test("meta with building=true → status: indexing", async () => {
    seedRepo("aaaaaaaaaaaa", { ...VALID_META, building: true });
    const repos = await enumerateRepos({ home });
    expect(repos).toHaveLength(1);
    expect(repos[0]!.status).toBe("indexing");
  });

  test("meta with building=false + valid last_indexed_ts → status: ready", async () => {
    seedRepo("aaaaaaaaaaaa", { ...VALID_META, building: false });
    const repos = await enumerateRepos({ home });
    expect(repos[0]!.status).toBe("ready");
  });

  test("meta missing `building` field (backward-compat) + valid last_indexed_ts → status: ready", async () => {
    seedRepo("aaaaaaaaaaaa", VALID_META);
    const repos = await enumerateRepos({ home });
    expect(repos[0]!.status).toBe("ready");
  });

  test("meta.json missing entirely → status: not-indexed", async () => {
    seedRepo("aaaaaaaaaaaa", null);
    const repos = await enumerateRepos({ home });
    expect(repos[0]!.status).toBe("not-indexed");
  });

  test("meta.json corrupt JSON → status: not-indexed", async () => {
    const dir = join(home, "repo-memory", "aaaaaaaaaaaa");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), "{ not valid json");
    const repos = await enumerateRepos({ home });
    expect(repos[0]!.status).toBe("not-indexed");
  });

  test("meta with last_indexed_ts empty string (cold-build in-flight) + building=true → indexing", async () => {
    seedRepo("aaaaaaaaaaaa", { ...VALID_META, last_indexed_ts: "", building: true });
    const repos = await enumerateRepos({ home });
    expect(repos[0]!.status).toBe("indexing");
  });

  test("meta with no last_indexed_ts and no building → status: not-indexed", async () => {
    seedRepo("aaaaaaaaaaaa", { schemaVersion: 1, project_root: "/x", proj_hash: "a" });
    const repos = await enumerateRepos({ home });
    expect(repos[0]!.status).toBe("not-indexed");
  });
});

describe("enumerateRepos — directory enumeration", () => {
  test("empty / missing home → returns []", async () => {
    const repos = await enumerateRepos({ home });
    expect(repos).toEqual([]);
  });

  test("repo-memory dir exists but empty → returns []", async () => {
    mkdirSync(join(home, "repo-memory"), { recursive: true });
    const repos = await enumerateRepos({ home });
    expect(repos).toEqual([]);
  });

  test("hidden entries (starting with .) ignored", async () => {
    seedRepo(".DS_Store", null);
    seedRepo("abcdef012345", VALID_META);
    const repos = await enumerateRepos({ home });
    expect(repos).toHaveLength(1);
    expect(repos[0]!.proj_hash).toBe("abcdef012345");
  });

  test("non-directory entries ignored (e.g. stray files in repo-memory)", async () => {
    mkdirSync(join(home, "repo-memory"), { recursive: true });
    writeFileSync(join(home, "repo-memory", "stray.txt"), "noise");
    seedRepo("abcdef012345", VALID_META);
    const repos = await enumerateRepos({ home });
    expect(repos).toHaveLength(1);
  });

  test("non-proj_hash-format directory names ignored (e.g. `summaries/` sibling)", async () => {
    seedRepo("summaries", VALID_META); // not a proj_hash
    seedRepo("abcdef012345", VALID_META);
    const repos = await enumerateRepos({ home });
    expect(repos).toHaveLength(1);
    expect(repos[0]!.proj_hash).toBe("abcdef012345");
  });

  test("multiple repos enumerated with proj_hash matching directory name", async () => {
    seedRepo("aaaaaaaaaaaa", VALID_META);
    seedRepo("bbbbbbbbbbbb", { ...VALID_META, building: true });
    seedRepo("cccccccccccc", null);
    const repos = await enumerateRepos({ home });
    expect(repos).toHaveLength(3);
    const hashes = repos.map((r) => r.proj_hash).sort();
    expect(hashes).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"]);
  });
});

describe("enumerateRepos — entry hydration", () => {
  test("ready entry surfaces project_root and last_indexed_ts from meta", async () => {
    seedRepo("aaaaaaaaaaaa", VALID_META);
    const repos = await enumerateRepos({ home });
    expect(repos[0]!.project_root).toBe("/projects/myrepo");
    expect(repos[0]!.last_indexed_ts).toBe("2026-05-28T10:00:00.000Z");
  });

  test("not-indexed entry has project_root null and last_indexed_ts null", async () => {
    seedRepo("aaaaaaaaaaaa", null);
    const repos = await enumerateRepos({ home });
    expect(repos[0]!.project_root).toBeNull();
    expect(repos[0]!.last_indexed_ts).toBeNull();
  });
});

// ── removeRepoIndex + hash-validation guard ──
describe("removeRepoIndex — forget primitive", () => {
  test("valid 12-hex hash with a seeded dir → removes it, returns true", async () => {
    seedRepo("abcdef012345", VALID_META);
    const dir = join(home, "repo-memory", "abcdef012345");
    expect(existsSync(dir)).toBe(true);
    const removed = await removeRepoIndex("abcdef012345", { home });
    expect(removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("missing dir → returns false (idempotent, no throw)", async () => {
    const removed = await removeRepoIndex("abcdef012345", { home });
    expect(removed).toBe(false);
  });

  test("malformed hash (traversal) → refused, deletes nothing outside repo-memory/<hash>", async () => {
    // a victim file at home/secret.txt; join(home,"repo-memory","../../secret.txt") would escape
    const victim = join(home, "secret.txt");
    writeFileSync(victim, "do not delete");
    const removed = await removeRepoIndex("../../secret.txt", { home });
    expect(removed).toBe(false);
    expect(existsSync(victim)).toBe(true);
  });

  test("invalid short hash → refused (false), no rm", async () => {
    expect(await removeRepoIndex("abc", { home })).toBe(false);
    expect(await removeRepoIndex("", { home })).toBe(false);
    expect(await removeRepoIndex("ABCDEF012345", { home })).toBe(false); // uppercase not hex-lower
  });
});

// ── Maintenance round #2: forget must not destroy the PAID arch-model ──
// (real loss 2026-06-09: forget×N burned ~$1 of cached generated models).
// Pattern = content-addressed-cache survival (bazel/sccache class): the paid
// artifact moves to `repo-memory/.preserved/<hash>/` (dot-dir → invisible to
// enumerateRepos, no picker ghost), restored on the next successful index.
describe("removeRepoIndex — paid arch-model preservation", () => {
  const HASH = "abcdef012345";
  const dir = (): string => join(home, "repo-memory", HASH);
  const preserved = (): string => join(home, "repo-memory", ".preserved", HASH);

  function seedWithModel(): void {
    seedRepo(HASH, VALID_META);
    writeFileSync(join(dir(), "graph.json"), "{}");
    writeFileSync(join(dir(), "arch-model.json"), JSON.stringify({ paid: true }));
    writeFileSync(join(dir(), "arch-model.meta.json"), JSON.stringify({ cost_usd: 0.4 }));
  }

  test("forget moves arch-model files to .preserved/<hash> and removes the index dir", async () => {
    seedWithModel();
    expect(await removeRepoIndex(HASH, { home })).toBe(true);
    expect(existsSync(dir())).toBe(false); // true forget — no picker ghost
    expect(readFileSync(join(preserved(), "arch-model.json"), "utf8")).toBe(
      JSON.stringify({ paid: true }),
    );
    expect(existsSync(join(preserved(), "arch-model.meta.json"))).toBe(true);
  });

  test("forget without an arch-model behaves exactly as before (no .preserved dir)", async () => {
    seedRepo(HASH, VALID_META);
    expect(await removeRepoIndex(HASH, { home })).toBe(true);
    expect(existsSync(dir())).toBe(false);
    expect(existsSync(preserved())).toBe(false);
  });

  test("purge deletes everything including a previously preserved model", async () => {
    seedWithModel();
    await removeRepoIndex(HASH, { home }); // → preserved
    expect(existsSync(preserved())).toBe(true);
    seedRepo(HASH, VALID_META); // re-appeared (e.g. partial re-index)
    expect(await removeRepoIndex(HASH, { home, purge: true })).toBe(true);
    expect(existsSync(dir())).toBe(false);
    expect(existsSync(preserved())).toBe(false);
  });

  test("forgotten repo with a preserved model does NOT ghost in enumerateRepos", async () => {
    seedWithModel();
    await removeRepoIndex(HASH, { home });
    expect(await enumerateRepos({ home })).toHaveLength(0);
  });

  test("restorePreservedArchModel moves the model back into a re-indexed dir", async () => {
    seedWithModel();
    await removeRepoIndex(HASH, { home });
    seedRepo(HASH, VALID_META); // simulate a fresh successful re-index
    expect(await restorePreservedArchModel(HASH, { home })).toBe(true);
    expect(readFileSync(join(dir(), "arch-model.json"), "utf8")).toBe(
      JSON.stringify({ paid: true }),
    );
    expect(existsSync(preserved())).toBe(false); // emptied + cleaned up
  });

  test("partial restore (one dest occupied) keeps the stash — skipped file is never deleted", async () => {
    seedWithModel();
    await removeRepoIndex(HASH, { home }); // both files → stash
    seedRepo(HASH, VALID_META);
    // dest already has a NEWER meta (e.g. crash-split write) → that slot skips
    writeFileSync(join(dir(), "arch-model.meta.json"), JSON.stringify({ cost_usd: 9.9 }));
    expect(await restorePreservedArchModel(HASH, { home })).toBe(true); // model moved
    expect(readFileSync(join(dir(), "arch-model.json"), "utf8")).toBe(JSON.stringify({ paid: true }));
    expect(readFileSync(join(dir(), "arch-model.meta.json"), "utf8")).toBe(
      JSON.stringify({ cost_usd: 9.9 }), // newer in-place wins
    );
    // stash NOT rm'd: the skipped meta survives for a future full drain
    expect(readFileSync(join(preserved(), "arch-model.meta.json"), "utf8")).toBe(
      JSON.stringify({ cost_usd: 0.4 }),
    );
  });

  test("restore is a no-op (false) when nothing was preserved or target dir missing", async () => {
    expect(await restorePreservedArchModel(HASH, { home })).toBe(false);
    seedWithModel();
    await removeRepoIndex(HASH, { home }); // preserved, but storage dir now gone
    expect(await restorePreservedArchModel(HASH, { home })).toBe(false);
    expect(existsSync(join(preserved(), "arch-model.json"))).toBe(true); // still safe
  });
});

describe("resolveRepoByHash — hash-validation guard", () => {
  test("valid seeded hash resolves to its location", async () => {
    seedRepo("abcdef012345", VALID_META);
    const loc = await resolveRepoByHash("abcdef012345", { home });
    expect(loc?.proj_hash).toBe("abcdef012345");
    expect(loc?.project_root).toBe("/projects/myrepo");
  });

  test("traversal hash → null (never path-joins outside repo-memory)", async () => {
    // even if the target exists, a malformed hash must not resolve
    writeFileSync(join(home, "meta.json"), JSON.stringify(VALID_META));
    expect(await resolveRepoByHash("../../", { home })).toBeNull();
    expect(await resolveRepoByHash("../..", { home })).toBeNull();
  });

  test("non-proj_hash-format name → null", async () => {
    seedRepo("summaries", VALID_META);
    expect(await resolveRepoByHash("summaries", { home })).toBeNull();
  });
});

describe("enumerateRepos — deterministic order (picker + default-fallback share it)", () => {
  test("sorts by last_indexed_ts desc, never-indexed last, proj_hash asc tiebreak", async () => {
    // Seed in an order unlike the expected output so raw readdir order can't
    // accidentally pass: oldest first, never-indexed in the middle, newest last.
    seedRepo("cccccccccccc", { ...VALID_META, last_indexed_ts: "2026-06-01T00:00:00.000Z" });
    seedRepo("eeeeeeeeeeee", { ...VALID_META, last_indexed_ts: null });
    seedRepo("dddddddddddd", { ...VALID_META, last_indexed_ts: null });
    seedRepo("aaaaaaaaaaaa", { ...VALID_META, last_indexed_ts: "2026-06-09T00:00:00.000Z" });
    seedRepo("bbbbbbbbbbbb", { ...VALID_META, last_indexed_ts: "2026-06-09T00:00:00.000Z" });
    const repos = await enumerateRepos({ home });
    expect(repos.map((r) => r.proj_hash)).toEqual([
      "aaaaaaaaaaaa", // newest ts, tiebreak a < b
      "bbbbbbbbbbbb", // same ts, hash tiebreak
      "cccccccccccc", // older ts
      "dddddddddddd", // never indexed → last, null-null hash tiebreak d < e
      "eeeeeeeeeeee", // never indexed → last
    ]);
  });
});
