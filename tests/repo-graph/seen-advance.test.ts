// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Slice ③ Task 4 — watermark advance write-path + `origin:"human_ui"`
 * isolation (spec R5/R7/R13, plan cross-family review C1/C6/C7).
 *
 * Real temp `seen.json` on disk throughout — no in-memory mocking of the
 * store layer, so these exercise the actual atomic-write + backup wiring.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceSeenFile,
  markAllSeen,
  type SeenWriteOrigin,
  withHumanOrigin,
} from "../../src/repo-graph/seen-advance";
import { emptySeen, readSeen, writeSeen } from "../../src/repo-graph/store";
import type { Fingerprints } from "../../src/repo-graph/types";

const CUR: Fingerprints = {
  schemaVersion: 1,
  files: {
    "src/a.ts": { content_sha256: "new", ast_sig: "s2" },
    "src/b.ts": { content_sha256: "b", ast_sig: "sb" },
  },
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "seen-"));
}

describe("seen advance — basic write-path", () => {
  test("advance one file writes current fingerprint into seen (canonical key)", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: { "src/a.ts": { content_sha256: "old", ast_sig: "s1" } } });
    // note the ./ — must canonicalize to src/a.ts
    await withHumanOrigin((origin) => advanceSeenFile(dir, "./src/a.ts", CUR, origin));
    const s = await readSeen(dir);
    expect(s.files["src/a.ts"]?.content_sha256).toBe("new");
    expect(s.files["src/a.ts"]?.ast_sig).toBe("s2");
  });

  test("advancing a DELETED file removes its key (no null-ref)", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: { "src/gone.ts": { content_sha256: "x", ast_sig: "y" } } });
    // gone.ts not in CUR
    await withHumanOrigin((origin) => advanceSeenFile(dir, "src/gone.ts", CUR, origin));
    const s = await readSeen(dir);
    expect(s.files["src/gone.ts"]).toBeUndefined();
  });

  test("markAll writes .bak, clears unknown_baseline, stamps version", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: {}, unknown_baseline: true });
    await withHumanOrigin((origin) => markAllSeen(dir, dir, CUR, origin));
    const s = await readSeen(dir);
    expect(s.unknown_baseline).toBe(false);
    expect(Object.keys(s.files).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(existsSync(join(dir, "seen.json.bak"))).toBe(true);
  });

  test("markAll's .bak preserves the PRIOR seen.json content (recovery-usable)", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: { "src/old.ts": { content_sha256: "z", ast_sig: "zz" } } });
    await withHumanOrigin((origin) => markAllSeen(dir, dir, CUR, origin));
    const bak = JSON.parse(await readFile(join(dir, "seen.json.bak"), "utf8")) as { files: Record<string, unknown> };
    expect(Object.keys(bak.files)).toEqual(["src/old.ts"]);
  });

  test("markAllSeen RE-STAMPS baseline_sha via a fresh capture — a stale prior value is overwritten, not carried forward (fix round 1)", async () => {
    const dir = tempDir(); // a plain tmpdir — NOT a git repo
    await writeSeen(dir, { ...emptySeen(), files: {}, baseline_sha: "stale-sha-from-a-much-earlier-point" });
    await withHumanOrigin((origin) => markAllSeen(dir, dir, CUR, origin));
    const s = await readSeen(dir);
    // best-effort capture in a non-git dir returns null — and that null must
    // WIN over the stale prior value, proving this is a fresh re-stamp and
    // not a carry-forward of whatever baseline_sha used to be there.
    expect(s.baseline_sha).toBeNull();
  });

  test("a per-file advance does NOT clear unknown_baseline (only markAll does)", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: {}, unknown_baseline: true });
    await withHumanOrigin((origin) => advanceSeenFile(dir, "src/a.ts", CUR, origin));
    const s = await readSeen(dir);
    expect(s.unknown_baseline).toBe(true);
  });
});

describe("seen advance — C6 re-canonicalization", () => {
  test("markAllSeen re-canonicalizes non-canonical current.files keys", async () => {
    const dir = tempDir();
    await writeSeen(dir, emptySeen());
    const nonCanonical: Fingerprints = {
      schemaVersion: 1,
      files: { "./src/weird.ts": { content_sha256: "w", ast_sig: "sw" } },
    };
    await withHumanOrigin((origin) => markAllSeen(dir, dir, nonCanonical, origin));
    const s = await readSeen(dir);
    expect(Object.keys(s.files)).toEqual(["src/weird.ts"]);
    expect(s.files["./src/weird.ts"]).toBeUndefined();
  });

  test("advanceSeenFile matches a canonical path against a non-canonical current key", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: { "src/weird.ts": { content_sha256: "old", ast_sig: "old" } } });
    const nonCanonical: Fingerprints = {
      schemaVersion: 1,
      files: { "./src/weird.ts": { content_sha256: "w", ast_sig: "sw" } },
    };
    await withHumanOrigin((origin) => advanceSeenFile(dir, "src/weird.ts", nonCanonical, origin));
    const s = await readSeen(dir);
    expect(s.files["src/weird.ts"]?.content_sha256).toBe("w");
  });

  test("advanceSeenFile canonicalizes a NON-CANONICAL key already sitting in seen.files (fast-follow, no duplicate raw+canonical entry)", async () => {
    const dir = tempDir();
    // Seed seen.json directly (bypassing the write core) with a raw,
    // non-canonical key -- readSeen only validates the top-level shape, not
    // that each files[] key is already canonical, so this is a realistic
    // on-disk state (hand-edited or written before canonicalization existed).
    await writeSeen(dir, { ...emptySeen(), files: { "./src/a.ts": { content_sha256: "old", ast_sig: "s1" } } });
    await withHumanOrigin((origin) => advanceSeenFile(dir, "src/a.ts", CUR, origin));
    const s = await readSeen(dir);
    // Exactly ONE canonical entry -- no lingering "./src/a.ts" duplicate.
    expect(Object.keys(s.files)).toEqual(["src/a.ts"]);
    expect(s.files["src/a.ts"]?.content_sha256).toBe("new");
    expect(s.files["./src/a.ts"]).toBeUndefined();
  });

  test("advanceSeenFile with a root-escaping path rejects the mutation, does not crash", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: { "src/a.ts": { content_sha256: "old", ast_sig: "s1" } } });
    await withHumanOrigin((origin) => advanceSeenFile(dir, "../../etc/passwd", CUR, origin));
    const s = await readSeen(dir);
    // untouched — the bad path was rejected, not applied
    expect(s.files["src/a.ts"]?.content_sha256).toBe("old");
  });
});

describe("seen advance — C7 null/empty current + malformed entries", () => {
  test("advanceSeenFile with an empty (not-indexed) current ABSTAINS — does not remove an existing seen entry (fix round 2)", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: { "src/a.ts": { content_sha256: "old", ast_sig: "s1" } } });
    const empty: Fingerprints = { schemaVersion: 1, files: {} };
    await withHumanOrigin((origin) => advanceSeenFile(dir, "src/a.ts", empty, origin));
    const s = await readSeen(dir);
    // NOT removed — an empty/not-indexed current must never make a real
    // deletion look like it happened (the same self-defeating-watermark
    // hazard markAllSeen was patched for; advanceSeenFile must be equally
    // safe on its own, not lean on a caller only firing on real deltas).
    expect(s.files["src/a.ts"]?.content_sha256).toBe("old");
  });

  test("markAllSeen with an empty (not-indexed) current ABSTAINS — does not wipe an existing seen.json to {} (fix round 1)", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: { "src/a.ts": { content_sha256: "old", ast_sig: "s1" } } });
    const empty: Fingerprints = { schemaVersion: 1, files: {} };
    await withHumanOrigin((origin) => markAllSeen(dir, dir, empty, origin));
    const s = await readSeen(dir);
    // NOT wiped to {} — an empty/not-indexed current must never make markAll
    // look like "nothing is seen" (the self-defeating-watermark hazard).
    expect(s.files["src/a.ts"]?.content_sha256).toBe("old");
  });

  test("markAllSeen on an empty current does NOT overwrite an existing unknown_baseline:true watermark, and writes no .bak (true no-op)", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: {}, unknown_baseline: true });
    const empty: Fingerprints = { schemaVersion: 1, files: {} };
    await withHumanOrigin((origin) => markAllSeen(dir, dir, empty, origin));
    const s = await readSeen(dir);
    expect(s.unknown_baseline).toBe(true); // untouched
    expect(existsSync(join(dir, "seen.json.bak"))).toBe(false); // no mutation attempted, so no backup either
  });

  test("a malformed current.files[key] entry is skipped, not thrown (task-1/2 carry-forward)", async () => {
    const dir = tempDir();
    await writeSeen(dir, emptySeen());
    const malformed = {
      schemaVersion: 1,
      files: {
        "src/good.ts": { content_sha256: "g", ast_sig: "sg" },
        "src/bad.ts": "not-an-object",
        "src/missing-fields.ts": { content_sha256: "only-one-field" },
      },
    } as unknown as Fingerprints;
    await withHumanOrigin((origin) => markAllSeen(dir, dir, malformed, origin));
    const s = await readSeen(dir);
    expect(Object.keys(s.files)).toEqual(["src/good.ts"]);
  });
});

describe("seen advance — C1 unforgeable origin capability", () => {
  test("a forged plain-string origin is rejected at runtime by advanceSeenFile", async () => {
    const dir = tempDir();
    await writeSeen(dir, emptySeen());
    const forged = "human_ui" as unknown as SeenWriteOrigin;
    await expect(advanceSeenFile(dir, "src/a.ts", CUR, forged)).rejects.toThrow(/invalid origin capability/);
  });

  test("a forged object origin is rejected at runtime by markAllSeen", async () => {
    const dir = tempDir();
    await writeSeen(dir, emptySeen());
    const forged = {} as unknown as SeenWriteOrigin;
    await expect(markAllSeen(dir, dir, CUR, forged)).rejects.toThrow(/invalid origin capability/);
  });

  test("an absent (undefined) origin is rejected at runtime by advanceSeenFile", async () => {
    const dir = tempDir();
    await writeSeen(dir, emptySeen());
    const forged = undefined as unknown as SeenWriteOrigin;
    await expect(advanceSeenFile(dir, "src/a.ts", CUR, forged)).rejects.toThrow(/invalid origin capability/);
  });

  test("a structural clone of a captured token (spread) is still rejected — reference identity, not shape", async () => {
    const dir = tempDir();
    await writeSeen(dir, emptySeen());
    const captured = withHumanOrigin((origin) => origin);
    // Spread copies the enumerable symbol-keyed brand property too — a
    // shape/duck-typed check would accept this. Reference-identity must not.
    const clone = { ...captured } as unknown as SeenWriteOrigin;
    await expect(advanceSeenFile(dir, "src/a.ts", CUR, clone)).rejects.toThrow(/invalid origin capability/);
  });

  test("a rejected mutation call leaves seen.json untouched (forged origin never mutates)", async () => {
    const dir = tempDir();
    await writeSeen(dir, { ...emptySeen(), files: { "src/a.ts": { content_sha256: "old", ast_sig: "s1" } } });
    const forged = "human_ui" as unknown as SeenWriteOrigin;
    await expect(advanceSeenFile(dir, "src/a.ts", CUR, forged)).rejects.toThrow();
    const s = await readSeen(dir);
    expect(s.files["src/a.ts"]?.content_sha256).toBe("old"); // still old — never advanced
  });

  test("the capability token is not exported for a producer module to import (C1)", async () => {
    const mod = await import("../../src/repo-graph/seen-advance");
    const modRecord = mod as unknown as Record<string, unknown>;
    expect(modRecord.HUMAN_UI_CAPABILITY).toBeUndefined();
    expect(Object.keys(mod)).not.toContain("HUMAN_UI_CAPABILITY");
    // the only exported way to obtain a real token is withHumanOrigin.
    expect(typeof mod.withHumanOrigin).toBe("function");
  });

  test("withHumanOrigin yields a token that mutators accept (positive control)", async () => {
    const dir = tempDir();
    await writeSeen(dir, emptySeen());
    await expect(withHumanOrigin((origin) => advanceSeenFile(dir, "src/a.ts", CUR, origin))).resolves.toBeUndefined();
  });
});
