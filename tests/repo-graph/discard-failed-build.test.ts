/**
 * A failed or cancelled re-index must not destroy the index you already had.
 *
 * `builder.ts`'s own `cleanupFailedBuild` already gets this right — cold build
 * → remove the dir; re-index → keep the prior good data and just un-stick the
 * `building` flag. But the daemon route overrode that with an unconditional
 * `removeRepoIndex` on EVERY non-success outcome, so the distinction never
 * survived. Worse, that included `aborted`: pressing Cancel on a re-index of a
 * working repo deleted the map you already had. Cancelling is a deliberate user
 * action and must not be destructive.
 *
 * The discriminator is on disk and needs no bookkeeping from the caller:
 * `markBuildStart` writes `{...prior, building: true}` when a prior meta exists
 * and a `last_indexed_ts: ""` stub when it doesn't — and it deliberately never
 * bumps `last_indexed_ts` during an in-flight build, because that field means
 * "last COMPLETED indexing". So a non-empty `last_indexed_ts` is exactly
 * "there was a good index here before this attempt".
 *
 * Run: bun test tests/repo-graph/discard-failed-build.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardFailedBuild } from "../../src/repo-graph/repo-registry";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-discard-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const HASH = "aaaaaaaaaaaa";

function repoDir(projHash = HASH): string {
  return join(home, "repo-memory", projHash);
}

/** Seed a repo dir with a meta and a stand-in graph artifact. */
function seed(meta: Record<string, unknown>, projHash = HASH): void {
  const dir = repoDir(projHash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "nodes.jsonl"), '{"id":"n1"}\n');
}

function readMetaRaw(projHash = HASH): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoDir(projHash), "meta.json"), "utf8"));
}

/** What markBuildStart leaves for a re-index: prior fields kept, building set. */
const RE_INDEX_IN_FLIGHT = {
  schemaVersion: 1,
  project_root: "/projects/myrepo",
  proj_hash: HASH,
  last_indexed_ts: "2026-08-01T10:00:00.000Z",
  build_duration_ms: 4321,
  counters: { files_walked: 12 },
  building: true,
};

/** What markBuildStart leaves for a cold build: an empty-timestamp stub. */
const COLD_IN_FLIGHT = {
  schemaVersion: 1,
  project_root: "/projects/fresh",
  proj_hash: HASH,
  last_indexed_ts: "",
  build_duration_ms: 0,
  counters: {},
  building: true,
};

describe("re-index failure keeps the index that was already there", () => {
  test("prior good index → reverted, dir survives, building un-stuck", async () => {
    seed(RE_INDEX_IN_FLIGHT);

    const outcome = await discardFailedBuild(HASH, { home });

    expect(outcome).toBe("reverted");
    expect(existsSync(repoDir())).toBe(true);
    // The graph artifact is what the user actually loses — assert it directly,
    // not merely that the directory still exists.
    expect(existsSync(join(repoDir(), "nodes.jsonl"))).toBe(true);

    const meta = readMetaRaw();
    expect(meta.building).toBe(false); // no permanent "indexing…" ghost
    // Everything else untouched — especially last_indexed_ts, which drives the
    // picker's staleness maths.
    expect(meta.last_indexed_ts).toBe("2026-08-01T10:00:00.000Z");
    expect(meta.build_duration_ms).toBe(4321);
    expect(meta.counters).toEqual({ files_walked: 12 });
  });

  test("cancelling a re-index is not destructive either — same path", async () => {
    // The aborted branch used to remove the index too. Cancel is a deliberate
    // user action; it must cost nothing.
    seed(RE_INDEX_IN_FLIGHT);
    await discardFailedBuild(HASH, { home });
    expect(existsSync(join(repoDir(), "nodes.jsonl"))).toBe(true);
  });
});

describe("a cold build that failed leaves nothing behind", () => {
  test("empty last_indexed_ts → removed, no stuck 'indexing' entry", async () => {
    seed(COLD_IN_FLIGHT);

    const outcome = await discardFailedBuild(HASH, { home });

    expect(outcome).toBe("removed");
    expect(existsSync(repoDir())).toBe(false);
  });

  test("missing last_indexed_ts field is treated as cold, not as prior-good", async () => {
    // Defensive: an older or hand-edited meta without the field must not be
    // mistaken for a good index worth preserving.
    const { last_indexed_ts: _drop, ...noTs } = COLD_IN_FLIGHT;
    seed(noTs as unknown as Record<string, unknown>);
    expect(await discardFailedBuild(HASH, { home })).toBe("removed");
    expect(existsSync(repoDir())).toBe(false);
  });

  test("unreadable meta → removed, because nothing provably good is in there", async () => {
    const dir = repoDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), "{ not json");
    expect(await discardFailedBuild(HASH, { home })).toBe("removed");
    expect(existsSync(dir)).toBe(false);
  });
});

describe("nothing to discard", () => {
  test("no such repo dir → absent, and no throw", async () => {
    expect(await discardFailedBuild(HASH, { home })).toBe("absent");
  });

  test("an invalid proj_hash is refused rather than path-joined", async () => {
    // removeRepoIndex validates before joining because it rm -rf's a computed
    // path; this shares that guard and must not weaken it.
    expect(await discardFailedBuild("../../etc", { home })).toBe("absent");
    expect(await discardFailedBuild("", { home })).toBe("absent");
  });
});
