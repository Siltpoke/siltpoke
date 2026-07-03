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

test("returns friendly 'not found' on unknown id", async () => {
  const out = await getCritique({ basePath: tmp, idOrLatest: "c-zzzz" });
  expect(out).toContain("not found");
});

test("returns 'not found' when critiques directory missing entirely", async () => {
  const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
  expect(out).toContain("not found");
});
