import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authoredUncommittedText,
  headCommit,
  isFarBehind,
  isValidSha,
  lastCommitForFile,
  relationTo,
  safeRelation,
  stampText,
} from "../../src/repo-graph/git-stamp";

let dir: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
const commit = (name: string) => { writeFileSync(join(dir, name), name); git("add", "."); git("commit", "-qm", name); return git("rev-parse", "HEAD"); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "git-stamp-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("relationTo", () => {
  it("same", () => { const c = commit("a"); expect(relationTo(dir, c)).toEqual({ relation: "same", count: 0 }); });
  it("ahead counts commits since the map", () => {
    const c = commit("a"); commit("b"); commit("c");
    expect(relationTo(dir, c)).toEqual({ relation: "ahead", count: 2 });
  });
  it("behind when HEAD is older than the map", () => {
    const old = commit("a"); const map = commit("b"); commit("c"); git("checkout", "-q", old);
    expect(relationTo(dir, map)).toEqual({ relation: "behind", count: 1 });
  });
  it("diverged on another branch", () => {
    commit("a"); git("checkout", "-qb", "x"); const map = commit("x1"); git("checkout", "-q", "main"); commit("m1");
    expect(relationTo(dir, map).relation).toBe("diverged");
  });
  it("history-unavailable when the object is missing", () => {
    commit("a");
    expect(relationTo(dir, "0123456789abcdef0123456789abcdef01234567").relation).toBe("history-unavailable");
  });
  it("not-recorded when commit is null", () => { commit("a"); expect(relationTo(dir, null)).toEqual({ relation: "not-recorded", count: null }); });
  it("no-git outside a repo", () => {
    const plain = mkdtempSync(join(tmpdir(), "nogit-"));
    expect(relationTo(plain, "abc").relation).toBe("no-git");
    expect(headCommit(plain)).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });
});

describe("lastCommitForFile", () => {
  it("follows a rename", () => {
    mkdirSync(join(dir, "d"));
    writeFileSync(join(dir, "d/old.json"), "{}"); git("add", "."); git("commit", "-qm", "add");
    const added = git("rev-parse", "HEAD");
    renameSync(join(dir, "d/old.json"), join(dir, "d/arch-c4.json")); git("add", "-A"); git("commit", "-qm", "mv");
    const r = lastCommitForFile(dir, "d/arch-c4.json");
    expect(r?.commit).not.toBe(added); // the rename commit touched it last
    expect(r?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("null for an uncommitted file", () => { commit("a"); writeFileSync(join(dir, "u.json"), "{}"); expect(lastCommitForFile(dir, "u.json")).toBeNull(); });
});

describe("stampText + isFarBehind", () => {
  const d = "2026-09-20T10:00:00.000Z";
  it("pins every wording", () => {
    expect(stampText(d, "a1b2c3d4e5", { relation: "ahead", count: 12 })).toBe("Map from 2026-09-20 · commit a1b2c3d · 12 commits behind HEAD");
    expect(stampText(d, "a1b2c3d4e5", { relation: "same", count: 0 })).toBe("Map from 2026-09-20 · commit a1b2c3d · up to date");
    expect(stampText(d, "a1b2c3d4e5", { relation: "behind", count: 5 })).toBe("Map from 2026-09-20 · commit a1b2c3d · 5 commits newer than this checkout");
    expect(stampText(d, "a1b2c3d4e5", { relation: "diverged", count: null })).toBe("Map from 2026-09-20 · commit a1b2c3d · built on a different branch");
    expect(stampText(d, "a1b2c3d4e5", { relation: "history-unavailable", count: null })).toBe("Map from 2026-09-20 · commit a1b2c3d · history not available here");
    expect(stampText(d, null, { relation: "not-recorded", count: null })).toBe("Map from 2026-09-20 · commit not recorded — regenerate to record it");
    expect(stampText(d, null, { relation: "no-git", count: null })).toBe("Map from 2026-09-20 · not a git repository");
  });
  it("far behind at 101 not 100, on diverged, never on behind", () => {
    expect(isFarBehind({ relation: "ahead", count: 100 })).toBe(false);
    expect(isFarBehind({ relation: "ahead", count: 101 })).toBe(true);
    expect(isFarBehind({ relation: "diverged", count: null })).toBe(true);
    expect(isFarBehind({ relation: "behind", count: 500 })).toBe(false);
    expect(isFarBehind({ relation: "not-recorded", count: null })).toBe(false);
  });
});

describe("isValidSha", () => {
  it("accepts a 40-hex SHA, rejects everything else", () => {
    expect(isValidSha("a".repeat(40))).toBe(true);
    expect(isValidSha("A".repeat(40))).toBe(false); // uppercase not git's lowercase hex
    expect(isValidSha("abc123")).toBe(false);
    expect(isValidSha(undefined)).toBe(false);
    expect(isValidSha(null)).toBe(false);
    expect(isValidSha("")).toBe(false);
  });
});

describe("safeRelation", () => {
  it("downgrades ahead/behind with a null count to history-unavailable", () => {
    expect(safeRelation({ relation: "ahead", count: null })).toEqual({ relation: "history-unavailable", count: null });
    expect(safeRelation({ relation: "behind", count: null })).toEqual({ relation: "history-unavailable", count: null });
  });
  it("passes every other relation through unchanged", () => {
    expect(safeRelation({ relation: "ahead", count: 3 })).toEqual({ relation: "ahead", count: 3 });
    expect(safeRelation({ relation: "same", count: 0 })).toEqual({ relation: "same", count: 0 });
    expect(safeRelation({ relation: "diverged", count: null })).toEqual({ relation: "diverged", count: null });
    expect(safeRelation({ relation: "not-recorded", count: null })).toEqual({ relation: "not-recorded", count: null });
    expect(safeRelation({ relation: "no-git", count: null })).toEqual({ relation: "no-git", count: null });
    expect(safeRelation({ relation: "history-unavailable", count: null })).toEqual({ relation: "history-unavailable", count: null });
  });
});

describe("authoredUncommittedText", () => {
  it("pins the exact wording (never the generic not-recorded string)", () => {
    expect(authoredUncommittedText("2026-09-20T10:00:00.000Z")).toBe(
      "Map from 2026-09-20 · file not committed — commit it to record its version",
    );
  });
});
