// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// These guard the two manifests that `/plugin install` VALIDATES — a check the
// `--plugin-dir` local load and the runtime dry-run both skip, so two malformed
// manifests (marketplace.json missing plugins[]/owner; plugin.json's `commands`
// as an object) shipped undetected until a real marketplace install rejected
// them. `claude plugin validate` is the full check but needs the claude CLI;
// these assert the specific shapes that broke, in plain CI-runnable bun test.

const ROOT = process.cwd();
const marketplace = JSON.parse(
  readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"),
) as Record<string, unknown>;
const plugin = JSON.parse(
  readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"),
) as Record<string, unknown>;

describe("marketplace.json is a valid marketplace catalog", () => {
  test("has name + owner.name + a non-empty plugins[]", () => {
    expect(typeof marketplace.name).toBe("string");
    expect(typeof (marketplace.owner as { name?: unknown })?.name).toBe("string");
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect((marketplace.plugins as unknown[]).length).toBeGreaterThan(0);
  });

  test("every plugin entry has a name and a ./-relative source", () => {
    for (const p of marketplace.plugins as Array<{ name?: unknown; source?: unknown }>) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.source).toBe("string");
      expect(p.source as string).toMatch(/^\.\//);
    }
  });

  test("does NOT carry the old plugin-manifest-flavored `plugin` key", () => {
    // The pre-fix file had `"plugin": "./plugin.json"`, which is not the
    // marketplace schema and left plugins[] absent.
    expect(marketplace).not.toHaveProperty("plugin");
  });
});

describe("plugin.json is a valid plugin manifest", () => {
  test("has the only required field, name", () => {
    expect(typeof plugin.name).toBe("string");
  });

  test("`commands` is an array of ./-relative paths (never the {directory} object)", () => {
    expect(Array.isArray(plugin.commands)).toBe(true);
    for (const c of plugin.commands as unknown[]) {
      expect(typeof c).toBe("string");
      expect(c as string).toMatch(/^\.\//);
    }
  });

  test("the commands path resolves to real .md command files", () => {
    for (const rel of plugin.commands as string[]) {
      const dir = join(ROOT, rel);
      expect(existsSync(dir)).toBe(true);
      const mds = readdirSync(dir).filter((f) => f.endsWith(".md"));
      expect(mds.length).toBeGreaterThan(0);
    }
  });

  test("carries no `requires` field (not in the schema — validator warns on it)", () => {
    expect(plugin).not.toHaveProperty("requires");
  });
});

test("agy plugin manifest exists and declares hooks", () => {
  const p = join(import.meta.dir, "../../.antigravity-plugin/plugin.json");
  expect(existsSync(p)).toBe(true);
  const m = JSON.parse(readFileSync(p, "utf8"));
  expect(m.name).toBe("siltpoke");
  expect(m.hooks).toBe("./hooks.json"); // or assert a root .antigravity-plugin/hooks.json exists
});

// Every file that ships a version a user can read. `.codex-plugin/plugin.json`
// was left a release behind at the v1.0.0 bump because the release workflow and
// the publish checklist both named only the two `.claude-plugin` files, so
// nothing anywhere looked at it — and `codex plugin marketplace add` reads it on
// install. The workflow now checks all of these too, but that check runs AFTER
// the tag is pushed; this one runs in the local gate, before.
type ManifestJson = { version?: unknown; plugins?: Array<{ version?: unknown }> };
const VERSIONED_MANIFESTS: Array<{ rel: string; read: (j: ManifestJson) => unknown }> = [
  { rel: ".claude-plugin/plugin.json", read: (j) => j.version },
  { rel: ".claude-plugin/marketplace.json", read: (j) => j.plugins?.[0]?.version },
  { rel: ".antigravity-plugin/plugin.json", read: (j) => j.version },
  { rel: ".codex-plugin/plugin.json", read: (j) => j.version },
  { rel: "package.json", read: (j) => j.version },
];

describe("every shipped manifest carries the same version", () => {
  test("each one exists and has a semver-shaped version", () => {
    // Asserted per file rather than by iterating whatever happens to be on
    // disk: a glob that matched nothing would pass the equality test below
    // while checking nothing at all.
    expect(VERSIONED_MANIFESTS.length).toBe(5);
    for (const { rel, read } of VERSIONED_MANIFESTS) {
      const path = join(ROOT, rel);
      expect(existsSync(path)).toBe(true);
      const version = read(JSON.parse(readFileSync(path, "utf8")) as ManifestJson);
      expect(typeof version).toBe("string");
      expect(version as string).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  // Residual, stated rather than implied: this asserts they agree with EACH
  // OTHER, never that they agree with the version actually being released. All
  // five bumped to the same wrong number stays green here; only `release.yml`'s
  // validate step, which compares against the pushed tag, catches that.
  test("they all agree — a bump that misses one reds here, not after the tag is pushed", () => {
    const seen = VERSIONED_MANIFESTS.map(({ rel, read }) => ({
      rel,
      version: read(JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as ManifestJson) as string,
    }));
    const distinct = [...new Set(seen.map((s) => s.version))];
    // The message names the odd files out, since "expected 1, got 2" alone
    // does not say which manifest was forgotten.
    expect(distinct.length, `versions differ: ${seen.map((s) => `${s.rel}=${s.version}`).join(", ")}`).toBe(1);
  });
});
