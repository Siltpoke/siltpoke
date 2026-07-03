import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markForwarded,
  FORWARD_XP_REWARD,
} from "../../src/cli/mark-forwarded";
import { readProgression } from "../../src/state/progression";

let tmp: string;
// Per-test preference-log path so handler writes never touch the user's real
// ~/.siltpoke/preference-log.jsonl.
let prefLog: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-mark-"));
  prefLog = join(tmp, "preference-log.jsonl");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const sample = `---
schemaVersion: 1
critique_id: c-a7b3
status: pending
---
body
`;

test("flips status pending -> forwarded for archive id", async () => {
  const dir = join(tmp, "critiques", "archive", "2026-05-14");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "c-a7b3.md");
  writeFileSync(p, sample);

  const out = await markForwarded({
    basePath: tmp,
    idOrLatest: "c-a7b3",
    preferenceLogPath: prefLog,
  });
  expect(out).toContain("marked forwarded");
  expect(readFileSync(p, "utf8")).toContain("status: forwarded");
});

test("returns 'not found' for unknown id without crashing", async () => {
  const out = await markForwarded({
    basePath: tmp,
    idOrLatest: "c-zzzz",
    preferenceLogPath: prefLog,
  });
  expect(out).toContain("not found");
});

test("idempotent: marking already-forwarded stays forwarded", async () => {
  const dir = join(tmp, "critiques", "archive", "2026-05-14");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "c-aaaa.md");
  writeFileSync(p, sample);

  await markForwarded({
    basePath: tmp,
    idOrLatest: "c-aaaa",
    preferenceLogPath: prefLog,
  });
  const second = await markForwarded({
    basePath: tmp,
    idOrLatest: "c-aaaa",
    preferenceLogPath: prefLog,
  });
  expect(second).toContain("marked forwarded");
  expect(readFileSync(p, "utf8")).toContain("status: forwarded");
});

test("first forward grants +20 XP", async () => {
  const dir = join(tmp, "critiques", "archive", "2026-05-14");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "c-xp01.md"), sample.replace("c-a7b3", "c-xp01"));

  // basePath = per-project critique base, homeBase = where progression lives.
  // In a unit test we point both at the same temp dir.
  const out = await markForwarded({
    basePath: tmp,
    homeBase: tmp,
    idOrLatest: "c-xp01",
    preferenceLogPath: prefLog,
  });
  expect(out).toContain(`+${FORWARD_XP_REWARD} XP`);
  const prog = await readProgression(tmp);
  expect(prog.xp).toBe(FORWARD_XP_REWARD);
});

test("second forward on same critique grants 0 XP", async () => {
  const dir = join(tmp, "critiques", "archive", "2026-05-14");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "c-xp02.md"), sample.replace("c-a7b3", "c-xp02"));

  await markForwarded({
    basePath: tmp,
    homeBase: tmp,
    idOrLatest: "c-xp02",
    preferenceLogPath: prefLog,
  });
  await markForwarded({
    basePath: tmp,
    homeBase: tmp,
    idOrLatest: "c-xp02",
    preferenceLogPath: prefLog,
  });
  const prog = await readProgression(tmp);
  expect(prog.xp).toBe(FORWARD_XP_REWARD);
});
