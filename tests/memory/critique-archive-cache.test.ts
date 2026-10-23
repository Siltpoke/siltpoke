// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The critique archive walk reuses a file's parse while the file is unchanged.
 *
 * Why: the Memory page walked every archived critique on every load — 7,767
 * files / 143 MB in siltpoke, measured 0.45 s warm and 1.2–4.9 s cold, to
 * keep 81 of them. Each test below runs the REAL loader against REAL files: a
 * stubbed reader would prove nothing about what is re-read from disk.
 *
 * The cache is keyed per file on (mtime, size). The first test proves the key
 * is honoured — content swapped behind an unchanged (mtime, size) is NOT seen —
 * so the later "change is seen" tests are not passing because nothing is cached.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAllCritiqueEntries } from "../../src/memory/consolidate";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeBase(): string {
  const d = mkdtempSync(join(tmpdir(), "siltpoke-crit-cache-"));
  dirs.push(d);
  return d;
}

function critiquePath(base: string, day: string, id: string): string {
  return join(base, "critiques", "archive", day, `${id}.md`);
}

function writeCritique(base: string, id: string, ts: string, body: string): string {
  const path = critiquePath(base, ts.slice(0, 10), id);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `---\ntimestamp: ${ts}\nstatus: pending\n---\n\n## Critique (for Claude)\n\n\`\`\`\n${body}\n\`\`\`\n`,
    "utf8",
  );
  return path;
}

/** Push a file's mtime forward so a rewrite is visible even within one clock tick. */
function bumpMtime(path: string): void {
  const s = statSync(path);
  const later = new Date(s.mtimeMs + 5_000);
  utimesSync(path, later, later);
}

const bodies = async (base: string) => (await loadAllCritiqueEntries(base)).map((e) => e.body);

describe("critique archive walk — per-file cache", () => {
  test("reuses the parse when (mtime, size) are unchanged", async () => {
    const base = makeBase();
    // A whole-second mtime, so restoring it below is exact (the filesystem keeps
    // nanoseconds; a Date round-trip of an arbitrary mtime would not).
    const pinned = new Date("2026-10-01T12:00:00.000Z");
    const path = writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "body AAAA");
    utimesSync(path, pinned, pinned);
    expect(await bodies(base)).toEqual(["body AAAA"]);

    // Same length, same mtime — only the content differs. A walk that re-read
    // the file would report "body BBBB"; the cache must not.
    writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "body BBBB");
    utimesSync(path, pinned, pinned);

    expect(await bodies(base)).toEqual(["body AAAA"]);
  });

  test("re-reads a file rewritten in place at the same size", async () => {
    // Same length on purpose: only the mtime changes, so a key that checked size
    // alone would serve the stale parse.
    const base = makeBase();
    const path = writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "body one");
    expect(await bodies(base)).toEqual(["body one"]);

    writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "body two");
    bumpMtime(path);

    expect(await bodies(base)).toEqual(["body two"]);
  });

  test("re-reads a file whose size changed under an unchanged mtime", async () => {
    const base = makeBase();
    const pinned = new Date("2026-10-01T12:00:00.000Z");
    const path = writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "short");
    utimesSync(path, pinned, pinned);
    expect(await bodies(base)).toEqual(["short"]);

    writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "a longer body");
    utimesSync(path, pinned, pinned);

    expect(await bodies(base)).toEqual(["a longer body"]);
  });

  test("picks up a file added to an already-walked day", async () => {
    const base = makeBase();
    writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "older");
    expect(await bodies(base)).toEqual(["older"]);

    writeCritique(base, "c-b", "2026-10-01T11:00:00.000Z", "newer");

    expect(await bodies(base)).toEqual(["newer", "older"]);
  });

  test("drops a file deleted since the last walk", async () => {
    const base = makeBase();
    writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "keep me");
    const gone = writeCritique(base, "c-b", "2026-10-02T10:00:00.000Z", "delete me");
    expect(await bodies(base)).toEqual(["delete me", "keep me"]);

    unlinkSync(gone);

    expect(await bodies(base)).toEqual(["keep me"]);
  });

  test("a file that stops parsing drops out; one that starts parsing comes in", async () => {
    const base = makeBase();
    const path = writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "parses");
    expect(await bodies(base)).toEqual(["parses"]);

    writeFileSync(path, "no frontmatter at all\n", "utf8");
    bumpMtime(path);
    expect(await bodies(base)).toEqual([]);

    writeCritique(base, "c-a", "2026-10-01T10:00:00.000Z", "parses again");
    bumpMtime(path);
    expect(await bodies(base)).toEqual(["parses again"]);
  });

  test("two bases never share entries", async () => {
    const a = makeBase();
    const b = makeBase();
    writeCritique(a, "c-same", "2026-10-01T10:00:00.000Z", "from base A");
    writeCritique(b, "c-same", "2026-10-01T10:00:00.000Z", "from base B");

    expect(await bodies(a)).toEqual(["from base A"]);
    expect(await bodies(b)).toEqual(["from base B"]);
  });

  test("entries sharing a timestamp keep directory order, as before the parallel read", async () => {
    // Reads finish in any order; the walk must still emit a day's files in
    // readdir order so the stable newest-first sort leaves ties where the old
    // sequential walk left them.
    const base = makeBase();
    const ts = "2026-10-01T10:00:00.000Z";
    for (let i = 0; i < 200; i++) {
      // Larger files for even i, so reads of neighbours finish out of order.
      writeCritique(base, `c-${i}`, ts, `body ${i} ${i % 2 === 0 ? "x".repeat(50_000) : ""}`);
    }
    const dayDir = join(base, "critiques", "archive", "2026-10-01");
    const expected = readdirSync(dayDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));

    expect((await loadAllCritiqueEntries(base)).map((e) => e.id)).toEqual(expected);
  });

  test("a large day read in parallel loses no file and keeps every id", async () => {
    // Reads finish out of order; this pins that none is dropped or doubled.
    // It does NOT exercise the read bound — removing the bound keeps this green
    // (measured, even under `ulimit -n 128`).
    const base = makeBase();
    const n = 600;
    for (let i = 0; i < n; i++) {
      const ss = String(i % 60).padStart(2, "0");
      const mm = String(Math.floor(i / 60)).padStart(2, "0");
      writeCritique(base, `c-${i}`, `2026-10-01T10:${mm}:${ss}.000Z`, `body ${i}`);
    }

    const entries = await loadAllCritiqueEntries(base);
    expect(entries.length).toBe(n);
    expect(new Set(entries.map((e) => e.id)).size).toBe(n);
  });
});
