/**
 * A change to what the extractor produces has to reach indexes that already
 * exist (defect [45]).
 *
 * An incremental build reuses a file's stored nodes whenever the file's bytes
 * are unchanged — so a fix to extraction (here: a symbol's `doc` is its first
 * sentence, not its first line) would only show up for files someone happens
 * to edit. The fingerprint records which extractor wrote the nodes; a
 * fingerprint from an older one is re-parsed once.
 *
 * Run: bun test tests/repo-graph/builder-extractor-version.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { EXTRACTOR_VERSION } from "../../src/repo-graph/fingerprint";
import type { Fingerprints, RepoGraph } from "../../src/repo-graph/types";

let tmp: string;
let projectRoot: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-graph-extractor-"));
  projectRoot = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(projectRoot, "src", "a.ts"),
    ["/**", " * Drop paths outside the repo — see", " * the options for why.", " */", "export function confine(): number { return 1; }", ""].join("\n"),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const readJson = <T>(dir: string, name: string): T => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;
const docOf = (g: RepoGraph): string | undefined => g.nodes.find((n) => n.name === "confine")?.doc;

describe("runIndexBuild — the fingerprint records the extractor version", () => {
  test("a fresh build stamps every file with the current version", async () => {
    const r = await runIndexBuild({ cwd: projectRoot, home });
    const fp = readJson<Fingerprints>(r.storage_dir, "fingerprints.json");
    expect(Object.values(fp.files).map((f) => f.extractor)).toEqual([EXTRACTOR_VERSION]);
  });

  test("control: an unchanged file stamped with the current version is reused, not re-parsed", async () => {
    await runIndexBuild({ cwd: projectRoot, home });
    const second = await runIndexBuild({ cwd: projectRoot, home });
    expect(second.counters.files_cached).toBe(1);
    expect(second.counters.files_walked).toBe(0);
  });

  test("a file indexed by an older extractor is re-parsed once, and its stale doc is replaced", async () => {
    const first = await runIndexBuild({ cwd: projectRoot, home });

    // Simulate an index written before this version: no `extractor` on the
    // fingerprint, and the node carries what the old extractor produced.
    const fp = readJson<Fingerprints>(first.storage_dir, "fingerprints.json");
    for (const f of Object.values(fp.files)) delete f.extractor;
    writeFileSync(join(first.storage_dir, "fingerprints.json"), JSON.stringify(fp));
    const g = readJson<RepoGraph>(first.storage_dir, "graph.json");
    const node = g.nodes.find((n) => n.name === "confine");
    if (!node) throw new Error("fixture: confine not indexed");
    node.doc = "Drop paths outside the repo — see";
    writeFileSync(join(first.storage_dir, "graph.json"), JSON.stringify(g));

    const second = await runIndexBuild({ cwd: projectRoot, home });
    expect(second.counters.files_walked).toBe(1);
    expect(second.counters.files_cached).toBe(0);
    expect(docOf(readJson<RepoGraph>(second.storage_dir, "graph.json"))).toBe(
      "Drop paths outside the repo — see the options for why.",
    );

    // ...and only once: the rebuild restamps it, so the third build reuses it.
    const third = await runIndexBuild({ cwd: projectRoot, home });
    expect(third.counters.files_cached).toBe(1);
  });

  test("a file stamped by a NEWER extractor is also re-parsed, not trusted", async () => {
    const first = await runIndexBuild({ cwd: projectRoot, home });
    const fp = readJson<Fingerprints>(first.storage_dir, "fingerprints.json");
    for (const f of Object.values(fp.files)) f.extractor = EXTRACTOR_VERSION + 1;
    writeFileSync(join(first.storage_dir, "fingerprints.json"), JSON.stringify(fp));

    const second = await runIndexBuild({ cwd: projectRoot, home });
    expect(second.counters.files_cached).toBe(0);
  });
});
