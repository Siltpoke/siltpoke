import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCritique } from "../../src/cli/get-critique";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-getc-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sample = `---
status: pending
---

# [SILTPOKE CRITIQUE]
body content
`;

test("returns latest.md content for 'latest'", async () => {
  mkdirSync(join(tmp, "critiques"), { recursive: true });
  writeFileSync(join(tmp, "critiques", "latest.md"), sample);
  const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
  expect(out).toContain("body content");
});

test("returns archive file by id", async () => {
  const dir = join(tmp, "critiques", "archive", "2026-05-14");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "c-a7b3.md"), sample);
  const out = await getCritique({ basePath: tmp, idOrLatest: "c-a7b3" });
  expect(out).toContain("body content");
});

// An unknown id in an EMPTY store now reports the empty store, because that
// is the fact that explains the silence (audit defect `[5c]`, see
// tests/cli/critique-empty-state.test.ts for the full split).
test("an unknown id on a fresh install reports the empty store", async () => {
  const out = await getCritique({ basePath: tmp, idOrLatest: "c-zzzz" });
  expect(out).toMatch(/no reviews yet/i);
});

test("a missing critiques directory reads as 'no reviews yet', not as an error", async () => {
  const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
  expect(out).toMatch(/no reviews yet/i);
});
