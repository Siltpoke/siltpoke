// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The update check's whole risk is the opposite of a normal feature's: the
// damage is not a missed notice, it is a WRONG or noisy one printed into every
// session, or a SessionStart that waits on a network call. So most of what is
// asserted here is silence — that each broken input produces no sentence at all.
import { describe, expect, test } from "bun:test";
import {
  isStale,
  parseCache,
  readReleasePayload,
  updateNotice,
  type UpdateCache,
} from "../../src/update/check";
import { findInstalledVersion, isNewerVersion } from "../../src/installer/installed-version";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 24h, the cache window — a literal because the constant is internal to
 * check.ts and exporting it just for a test would widen the module's surface
 * for no production reason (`audit:dead` was right about that). */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CMD = "claude plugin update siltpoke";

describe("isNewerVersion", () => {
  test("ordinary ordering", () => {
    expect(isNewerVersion("1.3.0", "1.2.0")).toBe(true);
    expect(isNewerVersion("1.2.1", "1.2.0")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.2.0")).toBe(false);
    expect(isNewerVersion("1.1.0", "1.2.0")).toBe(false);
  });

  test("a pre-release is never newer than the release it precedes", () => {
    // `sort -V` disagrees — it ranks v1.3.0-rc1 ABOVE v1.3.0 — and that exact
    // inversion cost release.yml's Latest logic a first draft (2026-09-23).
    expect(isNewerVersion("1.3.0-rc1", "1.3.0")).toBe(false);
    expect(isNewerVersion("1.3.0", "1.3.0-rc1")).toBe(true);
    // Two pre-releases are never ranked against each other.
    expect(isNewerVersion("1.3.0-rc2", "1.3.0-rc1")).toBe(false);
  });

  test("a version it cannot parse never produces a notice", () => {
    for (const bad of ["", "latest", "v1.2", "1.2.3.4", "nightly-20260924", "１.２.３"]) {
      expect(isNewerVersion(bad, "1.0.0")).toBe(false);
      expect(isNewerVersion("9.9.9", bad)).toBe(false);
    }
  });

  test("a leading v on either side is tolerated", () => {
    expect(isNewerVersion("v1.3.0", "1.2.0")).toBe(true);
    expect(isNewerVersion("1.3.0", "v1.2.0")).toBe(true);
  });
});

describe("findInstalledVersion", () => {
  test("found by walking up, from any depth — not by counting ..", () => {
    const root = mkdtempSync(join(tmpdir(), "siltpoke-ver-"));
    try {
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      writeFileSync(join(root, ".claude-plugin", "plugin.json"), '{"version":"1.2.0"}');
      // The three real layouts this module is read from.
      for (const rel of ["src/update", "dist", ".antigravity-plugin/dist"]) {
        const deep = join(root, rel);
        mkdirSync(deep, { recursive: true });
        expect(findInstalledVersion(deep)).toBe("1.2.0");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("package.json is the fallback for a bare checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "siltpoke-ver2-"));
    try {
      writeFileSync(join(root, "package.json"), '{"version":"9.9.9"}');
      expect(findInstalledVersion(root)).toBe("9.9.9");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed or version-less manifests read as unknown, not as 0.0.0", () => {
    const root = mkdtempSync(join(tmpdir(), "siltpoke-ver3-"));
    try {
      writeFileSync(join(root, "package.json"), "{not json");
      expect(findInstalledVersion(root)).toBeNull();
      writeFileSync(join(root, "package.json"), '{"name":"x"}');
      expect(findInstalledVersion(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cache freshness", () => {
  const cache = (checkedAtMs: number): UpdateCache => ({
    checkedAtMs,
    latestVersion: "1.3.0",
    headline: null,
  });

  test("absent or expired is stale; inside the window is not", () => {
    const now = 1_000_000_000_000;
    expect(isStale(null, now)).toBe(true);
    expect(isStale(cache(now - 1000), now)).toBe(false);
    expect(isStale(cache(now - CHECK_INTERVAL_MS), now)).toBe(true);
    expect(isStale(cache(now - CHECK_INTERVAL_MS - 1), now)).toBe(true);
  });

  test("a clock that moved backwards does not freeze the cache as fresh", () => {
    const now = 1_000_000_000_000;
    expect(isStale(cache(now + 60_000), now)).toBe(true);
  });
});

describe("parseCache", () => {
  test("round-trips a real cache", () => {
    const raw = JSON.stringify({ checkedAtMs: 123, latestVersion: "1.3.0", headline: "hi" });
    expect(parseCache(raw)).toEqual({ checkedAtMs: 123, latestVersion: "1.3.0", headline: "hi" });
  });

  test("a corrupt cache reads as no cache, and never throws", () => {
    for (const bad of ["", "{", "null", "[]", '{"checkedAtMs":"yesterday"}', '{"checkedAtMs":null}']) {
      expect(parseCache(bad)).toBeNull();
    }
  });

  test("a cache with no known latest still parses — it records that we looked", () => {
    const raw = JSON.stringify({ checkedAtMs: 5 });
    expect(parseCache(raw)).toEqual({ checkedAtMs: 5, latestVersion: null, headline: null });
  });
});

describe("readReleasePayload", () => {
  test("takes the tag and drops the leading v", () => {
    expect(readReleasePayload({ tag_name: "v1.3.0", body: "- **Thing.** happened" })).toEqual({
      latestVersion: "1.3.0",
      headline: "Thing. happened",
    });
  });

  test("anything without a usable tag returns null", () => {
    for (const bad of [null, undefined, 42, "v1.3.0", {}, { tag_name: "" }, { tag_name: "v" }]) {
      expect(readReleasePayload(bad)).toBeNull();
    }
  });
});

describe("the release-note digest, seen through readReleasePayload", () => {
  // Reached through the public function rather than by exporting the helper:
  // `audit:dead` flagged that export as production-dead, and it was right —
  // nothing outside its own test called it. Testing the behaviour through the
  // surface that production actually uses is the better shape anyway.
  const headlineOf = (body: unknown) => readReleasePayload({ tag_name: "v1.3.0", body })?.headline;

  test("skips headings and rules, strips bullets and markup", () => {
    const body = "### Added\n\n- **Setup asks** whether `codex` should review\n- Second thing\n";
    expect(headlineOf(body)).toBe("Setup asks whether codex should review · Second thing");
  });

  test("truncates rather than printing a changelog into one chat line", () => {
    const body = Array.from({ length: 40 }, (_, i) => `- item number ${i}`).join("\n");
    const out = headlineOf(body);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(161);
    expect(out).toEndWith("…");
  });

  test("an empty, heading-only or non-string body yields no headline", () => {
    expect(headlineOf("")).toBeNull();
    expect(headlineOf("## Only a heading\n---")).toBeNull();
    expect(headlineOf(undefined)).toBeNull();
    expect(headlineOf(123)).toBeNull();
  });
});

describe("updateNotice — the sentence, and the silences", () => {
  const fresh = (latestVersion: string | null, headline: string | null = null): UpdateCache => ({
    checkedAtMs: 1,
    latestVersion,
    headline,
  });

  test("names both versions and the exact command", () => {
    const notice = updateNotice("1.2.0", fresh("1.3.0"), CMD);
    expect(notice).toContain("1.3.0");
    expect(notice).toContain("1.2.0");
    expect(notice).toContain(CMD);
    expect(notice).toContain("restart");
  });

  test("includes the headline when there is one", () => {
    expect(updateNotice("1.2.0", fresh("1.3.0", "Windows works"), CMD)).toContain("Windows works");
  });

  test("silent when there is nothing newer", () => {
    expect(updateNotice("1.3.0", fresh("1.3.0"), CMD)).toBeNull();
    expect(updateNotice("1.4.0", fresh("1.3.0"), CMD)).toBeNull();
  });

  test("silent when anything at all is unknown", () => {
    expect(updateNotice(null, fresh("1.3.0"), CMD)).toBeNull();
    expect(updateNotice("1.2.0", null, CMD)).toBeNull();
    expect(updateNotice("1.2.0", fresh(null), CMD)).toBeNull();
  });

  test("silent on an unparseable version rather than guessing", () => {
    expect(updateNotice("1.2.0", fresh("nightly"), CMD)).toBeNull();
    expect(updateNotice("dev", fresh("1.3.0"), CMD)).toBeNull();
  });

  test("a pre-release upstream never nags a user on the release", () => {
    expect(updateNotice("1.3.0", fresh("1.3.0-rc1"), CMD)).toBeNull();
  });
});
