/**
 * Parse degradation must be COUNTED, not silently absorbed.
 *
 * tree-sitter is an error-TOLERANT parser: given input it cannot fully parse it
 * does not fail — it inserts ERROR nodes (unparseable spans) and MISSING nodes
 * (tokens synthesized to recover) and returns a tree anyway. `parseSource` only
 * returns `null` on a parser-level failure, so a file the parser choked on still
 * arrives as a "successful" walk and is under-extracted with no signal.
 *
 * Measured on siltpoke at the time of writing: 617 files walked, 3 with
 * `rootNode.hasError` (7 ERROR nodes), all counted as clean successes.
 * Source: an internal design note §1.1
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { computeFingerprint } from "../../src/repo-graph/fingerprint";
import { parseSource } from "../../src/critic/rubric/tier2/ast-loader";

let tmp: string;
let projectRoot: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-graph-degraded-"));
  projectRoot = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(rel: string, content: string): void {
  const abs = join(projectRoot, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("runIndexBuild — parse degradation is counted", () => {
  test("a file tree-sitter can only partially parse is counted as degraded", async () => {
    // Unbalanced brace: tree-sitter recovers with ERROR/MISSING nodes rather
    // than returning null, so this file walks "successfully" today.
    seed("src/broken.ts", `export function broken( { return 1; }`);

    const r = await runIndexBuild({ cwd: projectRoot, home });

    expect(r.counters.parse_degraded).toBe(1);
  });

  test("a cleanly parsing file is not counted as degraded", async () => {
    seed("src/clean.ts", `export function clean(): number { return 1; }`);

    const r = await runIndexBuild({ cwd: projectRoot, home });

    expect(r.counters.parse_degraded).toBe(0);
    expect(r.counters.files_walked).toBe(1);
  });

  test("degradation survives an incremental rebuild that hits the cache", async () => {
    // Real use is almost always incremental: unchanged files hit the
    // content-sha cache and are never re-parsed, so a counter derived only
    // from the parse path silently drops to 0 on the second build and the
    // metric reads healthy. The degradation belongs in the fingerprint.
    seed("src/broken.ts", `export function broken( { return 1; }`);

    const first = await runIndexBuild({ cwd: projectRoot, home });
    expect(first.counters.parse_degraded).toBe(1);
    expect(first.counters.files_cached).toBe(0);

    const second = await runIndexBuild({ cwd: projectRoot, home });

    expect(second.counters.files_cached).toBe(1);
    expect(second.counters.parse_degraded).toBe(1);
  });

  test("a clean file hitting the cache does not get counted as degraded", async () => {
    // Guards the cache-path condition itself, not just its presence. Without
    // this, widening `if (cached.degraded)` to an unconditional increment
    // survives the whole suite, because the other cache test uses a file that
    // is degraded on both builds — so "always count" and "count when degraded"
    // agree there.
    seed("src/clean.ts", `export function clean(): number { return 1; }`);

    await runIndexBuild({ cwd: projectRoot, home });
    const second = await runIndexBuild({ cwd: projectRoot, home });

    expect(second.counters.files_cached).toBe(1);
    expect(second.counters.parse_degraded).toBe(0);
  });

  test("a fingerprint predating the degraded field is re-parsed, not trusted as clean", async () => {
    // An index built before `degraded` existed has fingerprints with the field
    // absent. Reusing those verbatim would make every already-indexed repo
    // report 0 forever (the content sha still matches, so the file is never
    // re-parsed) — the same silent under-extraction this counter exists to
    // end, moved one layer down. Absence must force a re-parse.
    seed("src/broken.ts", `export function broken( { return 1; }`);

    const first = await runIndexBuild({ cwd: projectRoot, home });
    expect(first.counters.parse_degraded).toBe(1);

    // Simulate a pre-feature index: strip the field, keep the content sha.
    const fpPath = join(first.storage_dir, "fingerprints.json");
    const fp = JSON.parse(readFileSync(fpPath, "utf8"));
    for (const rel of Object.keys(fp.files)) delete fp.files[rel].degraded;
    writeFileSync(fpPath, JSON.stringify(fp));

    const second = await runIndexBuild({ cwd: projectRoot, home });

    expect(second.counters.files_walked).toBe(1);
    expect(second.counters.files_cached).toBe(0);
    expect(second.counters.parse_degraded).toBe(1);
  });

  test("a degraded file is still walked and still contributes what it could extract", async () => {
    // Degradation is not rejection: partial extraction is worth keeping. The
    // point of the counter is visibility, not dropping data.
    seed("src/broken.ts", `export function broken( { return 1; }`);

    const r = await runIndexBuild({ cwd: projectRoot, home });

    expect(r.counters.files_walked).toBe(1);
    expect(r.counters.skipped.tree_sitter_failed).toBe(0);
    expect(r.counters.nodes.file).toBe(1);
  });
});

describe("computeFingerprint — degraded travels with the fingerprint", () => {
  // The sibling constructor must not drift from readAndFingerprintFile: a
  // FileFingerprint built here without `degraded` would read as "unknown" and
  // permanently defeat the cache for those files if this helper were ever
  // wired into the builder.
  test("marks a partially-parsed tree as degraded", async () => {
    const tree = await parseSource(`export function broken( { return 1; }`, "ts");
    expect(tree).not.toBeNull();

    expect(computeFingerprint("x", tree!).degraded).toBe(true);
  });

  test("marks a cleanly-parsed tree as not degraded, never undefined", async () => {
    const tree = await parseSource(`export function clean(): number { return 1; }`, "ts");
    expect(tree).not.toBeNull();

    expect(computeFingerprint("x", tree!).degraded).toBe(false);
  });
});
