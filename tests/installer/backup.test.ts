import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupSettings,
  restoreFromBackup,
  findLatestBackup,
} from "../../src/installer/backup";

let tmp: string;
let claudeHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-bk-"));
  claudeHome = join(tmp, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify({ before: true }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("backupSettings creates timestamped file + updates symlink", async () => {
  const now = new Date("2026-05-14T12:00:00Z");
  const res = await backupSettings(claudeHome, now);
  expect(existsSync(res.path)).toBe(true);
  expect(readFileSync(res.path, "utf8")).toContain('"before":true');
  expect(existsSync(res.symlink)).toBe(true);
  const linked = readlinkSync(res.symlink);
  expect(linked).toContain("settings.json.pre-siltpoke-");
});

test("backupSettings throws when settings.json missing", async () => {
  rmSync(join(claudeHome, "settings.json"));
  await expect(backupSettings(claudeHome)).rejects.toThrow();
});

test("restoreFromBackup overwrites current settings.json", async () => {
  const res = await backupSettings(claudeHome);
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify({ after: true }),
  );
  await restoreFromBackup(claudeHome, res.path);
  expect(
    JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8")).before,
  ).toBe(true);
});

test("findLatestBackup returns symlink when present", async () => {
  const res = await backupSettings(claudeHome);
  const found = await findLatestBackup(claudeHome);
  expect(found).toBe(res.symlink);
});

test("findLatestBackup returns null when no backups exist", async () => {
  const found = await findLatestBackup(claudeHome);
  expect(found).toBeNull();
});
