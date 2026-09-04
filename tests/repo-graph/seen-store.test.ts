// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AST_SIG_VERSION } from "../../src/repo-graph/ast-signature";
import { emptySeen, readSeen, writeSeen } from "../../src/repo-graph/store";

describe("seen store", () => {
  test("missing file → emptySeen defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seen-"));
    const s = await readSeen(dir);
    expect(s.files).toEqual({});
    expect(s.unknown_baseline).toBe(false);
    expect(s.ast_sig_version).toBe(AST_SIG_VERSION);
  });

  test("write then read round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seen-"));
    const w = { ...emptySeen(), files: { "src/a.ts": { content_sha256: "x", ast_sig: "y" } }, unknown_baseline: true };
    await writeSeen(dir, w);
    expect(await readSeen(dir)).toEqual(w);
  });

  // C14: emptySeen must actually resolve AST_SIG_VERSION at runtime (not undefined
  // from an import-cycle) — assert it's a real number and matches the leaf export.
  test("emptySeen().ast_sig_version is a real number equal to AST_SIG_VERSION", () => {
    const s = emptySeen();
    expect(typeof s.ast_sig_version).toBe("number");
    expect(s.ast_sig_version).toBe(AST_SIG_VERSION);
    expect(s.baseline_sha).toBeNull();
    expect(s.unknown_baseline).toBe(false);
  });

  // C11: a PRESENT-but-broken seen.json must NOT silently read as a clean
  // empty seed — that would falsely mark the whole repo "seen". It must come
  // back with unknown_baseline:true so callers know the baseline is unknown.
  test("corrupt (invalid JSON) seen.json → unknown_baseline true, not a fresh empty seed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seen-"));
    await writeFile(join(dir, "seen.json"), "{ not valid json ][", "utf8");
    const s = await readSeen(dir);
    expect(s.unknown_baseline).toBe(true);
    expect(s.files).toEqual({});
    expect(s.ast_sig_version).toBe(AST_SIG_VERSION);
  });

  test("wrong-shape (valid JSON, wrong schema) seen.json → unknown_baseline true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seen-"));
    await writeFile(join(dir, "seen.json"), JSON.stringify({ totally: "not a seen watermark" }), "utf8");
    const s = await readSeen(dir);
    expect(s.unknown_baseline).toBe(true);
    expect(s.files).toEqual({});
  });

  test("genuinely absent file still returns unknown_baseline false (not just present-but-broken)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seen-"));
    const s = await readSeen(dir);
    expect(s.unknown_baseline).toBe(false);
  });
});
