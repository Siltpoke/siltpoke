// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Slice ③ Task 5 -- daemon endpoints:
 *
 *   GET  /api/repo-graph/seen?repo=<projHash>          delta + composed staleness
 *   POST /api/repo-graph/seen/advance   { repo, path }  secret-gated
 *   POST /api/repo-graph/seen/mark-all  { repo }        secret-gated
 *
 * Deliberately NO mocking of the store/seen-advance/seen-delta layer -- every
 * fixture builds a real index via `runIndexBuild`, writes/edits real files on
 * disk, and asserts on the REAL fingerprint re-hash + classifyAll + verdict
 * math + seen.json bytes. Mirrors
 * `tests/daemon/repo-graph-staleness-route.test.ts`'s harness.
 *
 * IMPORTANT fixture fact (Task 1, `seen-seed.ts`): the FIRST `runIndexBuild`
 * on a repo SEEDS `seen.json` with `files = current fingerprints` (nothing
 * is unseen right after a fresh index) -- it is NOT left absent. Every
 * SUBSEQUENT `runIndexBuild` call is a no-op on an EXISTING `seen.json`
 * (`seedSeenWatermark`'s `existsSync` guard fires first). Tests below are
 * written against that real behavior, not an "absent until first POST"
 * assumption.
 *
 * The central guard (C4, binding correction over the brief): NO producer
 * path -- not a re-index via `runIndexBuild`, not a bare
 * `GET /api/repo-graph/seen` read -- may ever ADVANCE an existing
 * `seen.json`. Only the two POST handlers may, and only via
 * `withHumanOrigin` (isolation enforced separately by a dependency-cruiser
 * rule -- see `.dependency-cruiser.cjs`).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { mountSeenRoutes } from "../../src/daemon/routes/seen";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { computeProjHash } from "../../src/repo-graph/proj-hash";
import { readSeen } from "../../src/repo-graph/store";
import type { SeenFileDelta } from "../../src/repo-graph/types";

const SECRET = "test-seen-secret";

interface SeenGetBody {
  success: boolean;
  data: {
    unknown_baseline: boolean;
    staleness: { level: string; headline: string; counts: Record<string, number> };
    deltas: SeenFileDelta[];
  } | null;
  error: string | null;
}

function seedRepo(): { home: string; repo: string } {
  const home = mkdtempSync(join(tmpdir(), "sp-home-"));
  const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
  return { home, repo };
}

function makeApp(cwd: string, home: string): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd, home, secret: SECRET });
  // The 3 seen handlers were extracted to their own mount (fast-follow after
  // slice ③ landed) -- mount both here so the seen routes stay reachable.
  mountSeenRoutes(app, { home, secret: SECRET });
  return app;
}

async function getSeen(app: Hono, hash: string): Promise<{ status: number; body: SeenGetBody }> {
  const res = await app.request(`/api/repo-graph/seen?repo=${hash}`);
  return { status: res.status, body: (await res.json()) as SeenGetBody };
}

function post(app: Hono, path: string, body: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Siltpoke-Secret"] = secret;
  return Promise.resolve(
    app.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    ),
  );
}

describe("GET /api/repo-graph/seen", () => {
  test("case 1: fresh-seeded repo (first index build) -> deltas empty, unknown_baseline false", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    const { status, body } = await getSeen(app, hash);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.unknown_baseline).toBe(false);
    expect(body.data?.deltas).toEqual([]);
    // C12: exact StalenessVerdict shape, not a vague check.
    expect(body.data?.staleness.level).toBe("fresh");
    expect(body.data?.staleness.headline).toBe("index is current");
    expect(body.data?.staleness.counts).toEqual({
      content_changed: 0,
      deleted_still_indexed: 0,
      unindexed_files: 0,
      indexed: 2,
      wrong_ratio: 0,
    });
  });

  test("case 2: edit a file's body + re-index -> GET seen reports body_changed", async () => {
    const { home, repo } = seedRepo();
    // The FIRST index build seeds seen.json with baseline = current
    // fingerprints (seedSeenWatermark, Task 1) -- nothing is unseen yet.
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);
    const first = await getSeen(app, hash);
    expect(first.body.data?.deltas).toEqual([]);

    // Edit a.ts's body + re-index (a re-index never touches an EXISTING
    // seen.json -- seedSeenWatermark's existsSync guard). The old baseline
    // now disagrees with current -> a real delta.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 999;\n");
    await runIndexBuild({ cwd: repo, force: true, home });

    const { status, body } = await getSeen(app, hash);
    expect(status).toBe(200);
    const aDelta = body.data?.deltas.find((d) => d.path === "src/a.ts");
    expect(aDelta).toBeDefined();
    expect(aDelta?.body_changed).toBe(true);
    expect(aDelta?.baseline_status).toBe("tracked");
    expect(body.data?.deltas.find((d) => d.path === "src/b.ts")).toBeUndefined();
  });

  test("case 3: unknown_baseline true -> deltas EMPTY (banner case, no dump)", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const storageDir = join(home, "repo-memory", hash);
    // Corrupt seen.json directly (bypassing the write core) to force
    // unknown_baseline:true via readSeen's own broken-shape guard.
    writeFileSync(join(storageDir, "seen.json"), "{not valid json");

    const app = makeApp(repo, home);
    const { status, body } = await getSeen(app, hash);
    expect(status).toBe(200);
    expect(body.data?.unknown_baseline).toBe(true);
    expect(body.data?.deltas).toEqual([]);
  });

  test("case 6: index-staleness composition -- edit disk file WITHOUT re-indexing -> staleness reflects drift, not bare zero", async () => {
    const { home, repo } = seedRepo();
    // 5 files so 1/5 = 20% lands on "stale" (mirrors the staleness-route fixture).
    for (let i = 2; i < 5; i++) {
      writeFileSync(join(repo, "src", `f${i}.ts`), `export const f${i}=${i};\n`);
    }
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    // Drift ONE file's content on disk -- do NOT re-index.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 12345;\n");

    const { status, body } = await getSeen(app, hash);
    expect(status).toBe(200);
    expect(body.data?.staleness.level).toBe("stale");
    expect(body.data?.staleness.counts.content_changed).toBe(1);
  });

  test("C12: missing ?repo= -> 400 bad_repo", async () => {
    const { home, repo } = seedRepo();
    const app = makeApp(repo, home);
    const res = await app.request("/api/repo-graph/seen");
    expect(res.status).toBe(400);
    const body = (await res.json()) as SeenGetBody;
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error).toBe("bad_repo");
  });

  test("C12: malformed ?repo= (fails proj-hash shape) -> 400 bad_repo", async () => {
    const { home, repo } = seedRepo();
    const app = makeApp(repo, home);
    const res = await app.request("/api/repo-graph/seen?repo=not-a-hash");
    expect(res.status).toBe(400);
    const body = (await res.json()) as SeenGetBody;
    expect(body.error).toBe("bad_repo");
  });

  test("C12: valid-shaped but unknown repo hash -> 400 unknown_repo", async () => {
    const { home, repo } = seedRepo();
    const app = makeApp(repo, home);
    const res = await app.request("/api/repo-graph/seen?repo=aaaaaaaaaaaa");
    expect(res.status).toBe(400);
    const body = (await res.json()) as SeenGetBody;
    expect(body.error).toBe("unknown_repo");
  });

  test("C7: unindexed repo (no fingerprints.json at all) -> 200, empty deltas, no crash", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a=1;\n");
    const hash = computeProjHash(repo);
    // Seed the repo-memory dir + a minimal meta.json WITHOUT running the
    // indexer, so resolveRepoByHash resolves it but readFingerprints hits an
    // absent/empty fingerprints.json (the C7 unindexed-repo scenario).
    const storageDir = join(home, "repo-memory", hash);
    mkdirSync(storageDir, { recursive: true });
    writeFileSync(join(storageDir, "meta.json"), JSON.stringify({ schemaVersion: 1, project_root: repo }));

    const app = makeApp(repo, home);
    const { status, body } = await getSeen(app, hash);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data?.deltas).toEqual([]);
  });
});

describe("POST /api/repo-graph/seen/advance + mark-all", () => {
  test("case 4: advance one file -> GET seen no longer reports it", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    // Drift a.ts (re-index never touches an existing seen.json) so there's
    // an actual delta to advance.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 7;\n");
    await runIndexBuild({ cwd: repo, force: true, home });

    const before = await getSeen(app, hash);
    expect(before.body.data?.deltas.some((d) => d.path === "src/a.ts")).toBe(true);
    expect(before.body.data?.deltas.some((d) => d.path === "src/b.ts")).toBe(false);

    const res = await post(app, "/api/repo-graph/seen/advance", { repo: hash, path: "src/a.ts" });
    expect(res.status).toBe(200);
    const advBody = (await res.json()) as { success: boolean };
    expect(advBody.success).toBe(true);

    const after = await getSeen(app, hash);
    expect(after.body.data?.deltas.some((d) => d.path === "src/a.ts")).toBe(false);
    expect(after.body.data?.deltas).toEqual([]);
  });

  test("case 5: mark-all -> GET seen deltas empty, unknown_baseline false", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    // Drift BOTH files so mark-all has real work to do.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 7;\n");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 8;\n");
    await runIndexBuild({ cwd: repo, force: true, home });
    const before = await getSeen(app, hash);
    expect(before.body.data?.deltas.length).toBe(2);

    const res = await post(app, "/api/repo-graph/seen/mark-all", { repo: hash });
    expect(res.status).toBe(200);

    const { body } = await getSeen(app, hash);
    expect(body.data?.deltas).toEqual([]);
    expect(body.data?.unknown_baseline).toBe(false);
  });

  test("C12: POST advance with no secret header -> 401 unauthorized", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);
    const res = await post(app, "/api/repo-graph/seen/advance", { repo: hash, path: "src/a.ts" }, null);
    expect(res.status).toBe(401);
  });

  test("C12: POST advance with WRONG secret -> 401 unauthorized", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);
    const res = await post(app, "/api/repo-graph/seen/advance", { repo: hash, path: "src/a.ts" }, "wrong-secret");
    expect(res.status).toBe(401);
  });

  test("C12: POST mark-all with no secret header -> 401 unauthorized", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);
    const res = await post(app, "/api/repo-graph/seen/mark-all", { repo: hash }, null);
    expect(res.status).toBe(401);
  });

  test("C12: POST advance missing repo -> 400 bad_repo", async () => {
    const { home, repo } = seedRepo();
    const app = makeApp(repo, home);
    const res = await post(app, "/api/repo-graph/seen/advance", { path: "src/a.ts" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_repo");
  });

  test("C12: POST advance missing path -> 400 bad_path", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);
    const res = await post(app, "/api/repo-graph/seen/advance", { repo: hash });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_path");
  });

  test("C12: POST advance unknown repo hash -> 400 unknown_repo", async () => {
    const { home, repo } = seedRepo();
    const app = makeApp(repo, home);
    const res = await post(app, "/api/repo-graph/seen/advance", { repo: "aaaaaaaaaaaa", path: "src/a.ts" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_repo");
  });

  test("C12: POST mark-all unknown repo hash -> 400 unknown_repo", async () => {
    const { home, repo } = seedRepo();
    const app = makeApp(repo, home);
    const res = await post(app, "/api/repo-graph/seen/mark-all", { repo: "aaaaaaaaaaaa" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_repo");
  });

  test("advance through a deleted file: file removed from disk + re-indexed, then advanced -> key removed from seen.json", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    // Delete b.ts on disk + re-index -- it now shows as `deleted` in the delta
    // (b.ts was in the seeded baseline, gone from current).
    rmSync(join(repo, "src", "b.ts"));
    await runIndexBuild({ cwd: repo, force: true, home });

    const mid = await getSeen(app, hash);
    const bDelta = mid.body.data?.deltas.find((d) => d.path === "src/b.ts");
    expect(bDelta?.baseline_status).toBe("deleted");

    const res = await post(app, "/api/repo-graph/seen/advance", { repo: hash, path: "src/b.ts" });
    expect(res.status).toBe(200);

    const storageDir = join(home, "repo-memory", hash);
    const seen = await readSeen(storageDir);
    expect(seen.files["src/b.ts"]).toBeUndefined();

    const after = await getSeen(app, hash);
    expect(after.body.data?.deltas.find((d) => d.path === "src/b.ts")).toBeUndefined();
  });
});

describe("C4: NO-PREMATURE-ADVANCE -- the central guard", () => {
  test("re-index (the producer path) never touches an EXISTING seen.json", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home }); // first build -- seeds seen.json
    const hash = computeProjHash(repo);
    const storageDir = join(home, "repo-memory", hash);
    const seenPath = join(storageDir, "seen.json");

    const beforeBytes = readFileSync(seenPath, "utf8");

    // Run the producer path again (a second index build -- the real
    // review/Stop-adjacent re-index this repo exposes). Content drifted on
    // disk, but that must NOT be reflected into seen.json by this path.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    await runIndexBuild({ cwd: repo, force: true, home });

    const afterBytes = readFileSync(seenPath, "utf8");
    expect(afterBytes).toBe(beforeBytes); // byte-identical -- no producer path advanced it
  });

  test("GET /api/repo-graph/seen (the read path) has no side-effect that advances seen.json", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);
    const storageDir = join(home, "repo-memory", hash);
    const seenPath = join(storageDir, "seen.json");

    // Introduce real drift so classifyAll has something to report -- proves
    // the GET's classification math itself has no write side-effect, not
    // just that an already-quiescent file stays quiet.
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 55;\n");
    await runIndexBuild({ cwd: repo, force: true, home });

    const before = readFileSync(seenPath, "utf8");

    const { body } = await getSeen(app, hash); // read path
    expect(body.data?.deltas.length).toBeGreaterThan(0); // confirms it saw the drift
    await getSeen(app, hash);
    await getSeen(app, hash);

    const after = readFileSync(seenPath, "utf8");
    expect(after).toBe(before); // byte-identical
  });

  test("seen.json is byte-identical across producer (re-index) + read (GET) paths when no human POST fired", async () => {
    const { home, repo } = seedRepo();
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);
    const storageDir = join(home, "repo-memory", hash);
    const seenPath = join(storageDir, "seen.json");

    const s0 = readFileSync(seenPath, "utf8");
    await getSeen(app, hash); // read path
    const s1 = readFileSync(seenPath, "utf8");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 42;\n");
    await runIndexBuild({ cwd: repo, force: true, home }); // producer path
    const s2 = readFileSync(seenPath, "utf8");
    await getSeen(app, hash); // read path again
    const s3 = readFileSync(seenPath, "utf8");

    expect(s1).toBe(s0);
    expect(s2).toBe(s0);
    expect(s3).toBe(s0);
  });
});
