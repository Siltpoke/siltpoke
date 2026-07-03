import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readStatus,
  setStatus,
  findCritiqueByIdOrLatest,
} from "../../src/state/critique-status";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-cs-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sampleCritique = `---
schemaVersion: 1
timestamp: 2026-05-14T10:00:00Z
critique_id: c-a7b3
session_id: s1
status: pending
---

# [SILTPOKE CRITIQUE]

body here
`;

test("readStatus returns 'pending' for fresh critique", async () => {
  const p = join(tmp, "c.md");
  writeFileSync(p, sampleCritique);
  expect(await readStatus(p)).toBe("pending");
});

test("readStatus returns null for missing file", async () => {
  expect(await readStatus(join(tmp, "missing.md"))).toBeNull();
});

test("readStatus returns null when status line absent", async () => {
  const p = join(tmp, "no-status.md");
  writeFileSync(p, "---\nfoo: bar\n---\nbody");
  expect(await readStatus(p)).toBeNull();
});

test("setStatus updates pending -> forwarded in place", async () => {
  const p = join(tmp, "c.md");
  writeFileSync(p, sampleCritique);
  const ok = await setStatus(p, "forwarded");
  expect(ok).toBe(true);
  expect(await readStatus(p)).toBe("forwarded");
  const raw = readFileSync(p, "utf8");
  expect(raw).toContain("schemaVersion: 1");
  expect(raw).toContain("body here");
});

test("setStatus on missing file returns false without throwing", async () => {
  expect(await setStatus(join(tmp, "missing.md"), "forwarded")).toBe(false);
});

test("findCritiqueByIdOrLatest('latest') returns latest.md path", async () => {
  mkdirSync(join(tmp, "critiques"), { recursive: true });
  const latest = join(tmp, "critiques", "latest.md");
  writeFileSync(latest, sampleCritique);
  expect(await findCritiqueByIdOrLatest(tmp, "latest")).toBe(latest);
});

test("findCritiqueByIdOrLatest finds archive file by id", async () => {
  const archiveDir = join(tmp, "critiques", "archive", "2026-05-14");
  mkdirSync(archiveDir, { recursive: true });
  const archive = join(archiveDir, "c-a7b3.md");
  writeFileSync(archive, sampleCritique);
  expect(await findCritiqueByIdOrLatest(tmp, "c-a7b3")).toBe(archive);
});

test("findCritiqueByIdOrLatest returns null for unknown id", async () => {
  const archiveDir = join(tmp, "critiques", "archive", "2026-05-14");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, "c-a7b3.md"), sampleCritique);
  expect(await findCritiqueByIdOrLatest(tmp, "c-zzzz")).toBeNull();
});

test("findCritiqueByIdOrLatest returns null when archive missing", async () => {
  expect(await findCritiqueByIdOrLatest(tmp, "c-a7b3")).toBeNull();
});
