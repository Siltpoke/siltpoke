// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Slice ③ Task 7 (final) -- the cross-cutting E2E firing matrix for the
 * user-seen watermark. Every test here goes through the REAL stack: a real
 * `runIndexBuild` (real tree-sitter parse, real fingerprints), real file
 * edits on disk, and the REAL `GET/POST /api/repo-graph/seen*` routes --
 * the GET lives in `mountSeenRoutes`, the two POSTs alongside it (extracted
 * out of `mountRepoGraphRoutes` in a slice ③ fast-follow; both mounted here)
 * -- mirrors `tests/daemon/seen-routes.test.ts`'s harness. No mocking of the
 * store/seen-advance/seen-delta layer.
 *
 * Spec §10 firing-matrix rows already covered end-to-end elsewhere (NOT
 * duplicated here):
 *   - gesture-not-mount (mount the panel without a click -> no advance) --
 *     `tests/web/client/islands/since-you-looked-gestures.test.ts`.
 *   - unknown_baseline clears ONLY on mark-all (banner suppresses rows) --
 *     `tests/daemon/seen-routes.test.ts` case 3 (GET) +
 *     `tests/web/client/islands/since-you-looked-baseline.test.ts` (render).
 *   - version-bump-no-flood (pure classifyAll, synthetic sigs) --
 *     `tests/repo-graph/seen-delta.test.ts` describe("C8 ...").
 *   - no-premature-advance (the central C4 guard: no producer path may ever
 *     write seen.json) -- `tests/daemon/seen-routes.test.ts` describe("C4 ...").
 *   - empty-current abstain (classifyAll/advanceSeenFile/markAllSeen on an
 *     unindexed repo) -- `tests/repo-graph/seen-delta.test.ts` +
 *     `tests/repo-graph/seen-advance.test.ts` + `tests/daemon/seen-routes.test.ts`
 *     case C7.
 *   - index-stale composition (edit disk file WITHOUT re-indexing -> GET
 *     `data.staleness` reflects drift) -- ALREADY end-to-end via
 *     `tests/daemon/seen-routes.test.ts` case 6 (exact `StalenessVerdict`
 *     shape assertion). Skipped here to avoid a byte-for-byte duplicate.
 *
 * What's genuinely missing end-to-end (added below):
 *   1. A real signature edit vs a real body-only edit, both through actual
 *      tree-sitter parses (not synthetic `ast_sig` strings) -- proving
 *      `signature_changed`/`body_changed` land correctly through the real
 *      GET route.
 *   2. `new_to_you` (a real added file) alongside `deleted` (a real removed
 *      file) in the SAME real GET response. (Pure `deleted`-via-GET already
 *      has coverage in `seen-routes.test.ts`'s "advance through a deleted
 *      file" test; this adds the `new_to_you` half and proves both
 *      classifications co-occur correctly.)
 *   3. The multi-platform path case: advancing via a non-canonical path
 *      form (leading `./`) through the REAL daemon route, not just the pure
 *      `canonicalKey` unit test.
 *   4. `ast_sig_version` mismatch INJECTED directly onto the persisted
 *      `seen.json` on disk (never editing the global `AST_SIG_VERSION`
 *      constant), then a real structural edit through the real GET route --
 *      proving the version-mismatch mask holds end-to-end, not just in the
 *      pure `classifyAll` unit tests.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { mountSeenRoutes } from "../../src/daemon/routes/seen";
import { AST_SIG_VERSION } from "../../src/repo-graph/ast-signature";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { computeProjHash } from "../../src/repo-graph/proj-hash";
import { readSeen, writeSeen } from "../../src/repo-graph/store";
import type { SeenFileDelta } from "../../src/repo-graph/types";
import type { WhyAnchor } from "../../src/repo-graph/why-lookup";

const SECRET = "test-seen-e2e-secret";

interface SeenGetData {
  unknown_baseline: boolean;
  staleness: { level: string; headline: string; counts: Record<string, number> };
  deltas: Array<SeenFileDelta & { why: WhyAnchor }>;
}

interface SeenGetBody {
  success: boolean;
  data: SeenGetData | null;
  error: string | null;
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeApp(cwd: string, home: string): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd, home, secret: SECRET });
  // The GET/advance/mark-all seen routes were extracted to their own mount
  // (slice ③ fast-follow) -- mount both here so they stay reachable.
  mountSeenRoutes(app, { home, secret: SECRET });
  return app;
}

async function getSeen(app: Hono, hash: string): Promise<SeenGetBody> {
  const res = await app.request(`/api/repo-graph/seen?repo=${hash}`);
  return (await res.json()) as SeenGetBody;
}

async function postAdvance(app: Hono, hash: string, path: string): Promise<Response> {
  return app.request("/api/repo-graph/seen/advance", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
    body: JSON.stringify({ repo: hash, path }),
  });
}

describe("seen-watermark E2E firing matrix (slice ③, Task 7)", () => {
  test("real signature edit vs real body-only edit, through real tree-sitter -> GET reflects correct flags", async () => {
    const home = tmp("sp-home-");
    const repo = tmp("sp-repo-");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "greet.ts"),
      'export function greet(name: string): string {\n  return "hi " + name;\n}\n',
    );
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    // Body-only edit: change the string literal's TEXT only. The node
    // types/counts (function_declaration, formal_parameters, string,
    // binary_expression, ...) are unchanged, so the real AST signature
    // must be identical -- only content_sha256 differs.
    writeFileSync(
      join(repo, "src", "greet.ts"),
      'export function greet(name: string): string {\n  return "hello " + name;\n}\n',
    );
    await runIndexBuild({ cwd: repo, force: true, home });

    const bodyOnly = await getSeen(app, hash);
    const bodyDelta = bodyOnly.data?.deltas.find((d) => d.path === "src/greet.ts");
    expect(bodyDelta).toBeDefined();
    expect(bodyDelta?.baseline_status).toBe("tracked");
    expect(bodyDelta?.body_changed).toBe(true);
    expect(bodyDelta?.signature_changed).toBe(false);

    // Advance to a clean baseline before the next (signature) edit, so the
    // next delta isolates JUST that edit's effect.
    const advRes = await postAdvance(app, hash, "src/greet.ts");
    expect(advRes.status).toBe(200);
    expect((await getSeen(app, hash)).data?.deltas).toEqual([]);

    // Real structural edit: add a parameter + a conditional -- genuinely
    // shifts the node-type histogram, so the real ast_sig must differ.
    writeFileSync(
      join(repo, "src", "greet.ts"),
      'export function greet(name: string, loud: boolean): string {\n  return loud ? "HELLO " + name : "hello " + name;\n}\n',
    );
    await runIndexBuild({ cwd: repo, force: true, home });

    const sigEdit = await getSeen(app, hash);
    const sigDelta = sigEdit.data?.deltas.find((d) => d.path === "src/greet.ts");
    expect(sigDelta).toBeDefined();
    expect(sigDelta?.baseline_status).toBe("tracked");
    expect(sigDelta?.body_changed).toBe(true);
    expect(sigDelta?.signature_changed).toBe(true);
  });

  test("slice ④ task 6: every delta through the real GET route carries a why:WhyAnchor, never sinks the response", async () => {
    const home = tmp("sp-home-");
    const repo = tmp("sp-repo-"); // deliberately NOT a git repo -- the real
    // `lookupWhy` -> `blameLines` git-blame call fails ("not a git
    // repository") on every row here, so `attachWhy` must degrade EVERY
    // row to rung 3 through the real route, not crash the whole response.
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "why-a.ts"), "export const a = 1;\n");
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    writeFileSync(join(repo, "src", "why-a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "src", "why-b.ts"), "export const b = 1;\n");
    await runIndexBuild({ cwd: repo, force: true, home });

    const { data } = await getSeen(app, hash);
    expect(data?.deltas.length).toBeGreaterThan(0);
    for (const delta of data?.deltas ?? []) {
      expect(delta.why).toBeDefined();
      expect(delta.why.rung).toBe(3);
      expect(delta.why.anchor_scope).toBe("none");
    }
  });

  test("new_to_you (added file) + deleted (removed file) together in one real GET", async () => {
    const home = tmp("sp-home-");
    const repo = tmp("sp-repo-");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    const seeded = await getSeen(app, hash);
    expect(seeded.data?.deltas).toEqual([]);

    // Add a genuinely new file + delete an existing one, then re-index (the
    // real producer path -- never touches an existing seen.json, per C4).
    writeFileSync(join(repo, "src", "c.ts"), "export const c = 3;\n");
    rmSync(join(repo, "src", "b.ts"));
    await runIndexBuild({ cwd: repo, force: true, home });

    const { data } = await getSeen(app, hash);
    const cDelta = data?.deltas.find((d) => d.path === "src/c.ts");
    const bDelta = data?.deltas.find((d) => d.path === "src/b.ts");
    expect(cDelta?.baseline_status).toBe("new_to_you");
    expect(bDelta?.baseline_status).toBe("deleted");
    // a.ts is untouched tracked -- must not appear at all.
    expect(data?.deltas.find((d) => d.path === "src/a.ts")).toBeUndefined();
    expect(data?.deltas.length).toBe(2);
  });

  test("multi-platform path: POST advance via './src/x.ts' canonically matches -> x.ts does not reappear as new_to_you", async () => {
    const home = tmp("sp-home-");
    const repo = tmp("sp-repo-");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const app = makeApp(repo, home);

    // Drift x.ts so there's a real delta to advance (re-index never touches
    // an existing seen.json).
    writeFileSync(join(repo, "src", "x.ts"), "export const x = 2;\n");
    await runIndexBuild({ cwd: repo, force: true, home });

    const before = await getSeen(app, hash);
    expect(before.data?.deltas.some((d) => d.path === "src/x.ts")).toBe(true);

    // Advance using a NON-canonical form of the same path (leading "./") --
    // proves canonicalKey handling through the real daemon route, not just
    // the pure function in isolation.
    const res = await postAdvance(app, hash, "./src/x.ts");
    expect(res.status).toBe(200);

    const after = await getSeen(app, hash);
    expect(after.data?.deltas.find((d) => d.path === "src/x.ts")).toBeUndefined();
    expect(after.data?.deltas).toEqual([]);
  });

  test("ast_sig_version mismatch INJECTED on disk -> GET shows no signature_changed flood, content-only signal survives", async () => {
    const home = tmp("sp-home-");
    const repo = tmp("sp-repo-");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "shape.ts"),
      "export function shape(a: number): number {\n  return a + 1;\n}\n",
    );
    await runIndexBuild({ cwd: repo, force: true, home });
    const hash = computeProjHash(repo);
    const storageDir = join(home, "repo-memory", hash);
    const app = makeApp(repo, home);

    // Inject a stale ast_sig_version directly onto the persisted seen.json
    // -- NOT the global AST_SIG_VERSION constant.
    const seeded = await readSeen(storageDir);
    expect(seeded.ast_sig_version).toBe(AST_SIG_VERSION);
    await writeSeen(storageDir, { ...seeded, ast_sig_version: AST_SIG_VERSION + 41 });

    // A REAL structural edit (added parameter) -- the ast_sig genuinely
    // differs, but the injected version mismatch must mask signature_changed
    // entirely while body_changed still reflects the real content diff.
    writeFileSync(
      join(repo, "src", "shape.ts"),
      "export function shape(a: number, b: number): number {\n  return a + b;\n}\n",
    );
    await runIndexBuild({ cwd: repo, force: true, home });

    const { data } = await getSeen(app, hash);
    const delta = data?.deltas.find((d) => d.path === "src/shape.ts");
    expect(delta).toBeDefined();
    expect(delta?.baseline_status).toBe("tracked");
    expect(delta?.body_changed).toBe(true);
    expect(delta?.signature_changed).toBe(false);
  });
});
