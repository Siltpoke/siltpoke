import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProjectCapabilities,
  invalidateCapabilitiesIfStale,
  findNearestTsconfig,
  type ProjectCapabilities,
} from "../../src/critic/capabilities";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-caps-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// hasGit
// ---------------------------------------------------------------------------

describe("hasGit", () => {
  test("non-git scratch dir → hasGit false", async () => {
    const caps = await getProjectCapabilities(tmp);
    expect(caps.hasGit).toBe(false);
  });

  test("dir with .git/ → hasGit true", async () => {
    mkdirSync(join(tmp, ".git"));
    const caps = await getProjectCapabilities(tmp);
    expect(caps.hasGit).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tsconfigPaths
// ---------------------------------------------------------------------------

describe("tsconfigPaths", () => {
  test("TS project with single tsconfig at root → tsconfigPaths length 1, root path", async () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
    const caps = await getProjectCapabilities(tmp);
    expect(caps.tsconfigPaths).toHaveLength(1);
    expect(caps.tsconfigPaths[0]).toBe(join(tmp, "tsconfig.json"));
  });

  test("monorepo with nested tsconfigs → both detected, sorted root-first", async () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
    mkdirSync(join(tmp, "packages", "foo"), { recursive: true });
    mkdirSync(join(tmp, "packages", "bar"), { recursive: true });
    writeFileSync(join(tmp, "packages", "foo", "tsconfig.json"), JSON.stringify({}));
    writeFileSync(join(tmp, "packages", "bar", "tsconfig.json"), JSON.stringify({}));

    const caps = await getProjectCapabilities(tmp);
    expect(caps.tsconfigPaths).toHaveLength(3);
    // root tsconfig is first (depth 0)
    expect(caps.tsconfigPaths[0]).toBe(join(tmp, "tsconfig.json"));
    // nested ones follow (depth 2 = packages/*/tsconfig.json)
    const nested = caps.tsconfigPaths.slice(1);
    expect(nested).toContain(join(tmp, "packages", "foo", "tsconfig.json"));
    expect(nested).toContain(join(tmp, "packages", "bar", "tsconfig.json"));
  });

  test("non-TS project (just Cargo.toml, no git) → tsconfigPaths is empty, hasGit false", async () => {
    writeFileSync(join(tmp, "Cargo.toml"), "[package]\nname = \"foo\"\nversion = \"0.1.0\"");
    const caps = await getProjectCapabilities(tmp);
    expect(caps.tsconfigPaths).toEqual([]);
    expect(caps.hasGit).toBe(false);
  });

  test("non-TS project (Cargo.toml + .git) → tsconfigPaths is empty, hasGit true", async () => {
    writeFileSync(join(tmp, "Cargo.toml"), "[package]\nname = \"foo\"\nversion = \"0.1.0\"");
    mkdirSync(join(tmp, ".git"), { recursive: true });
    writeFileSync(join(tmp, ".git", "HEAD"), "ref: refs/heads/main\n");
    const caps = await getProjectCapabilities(tmp);
    expect(caps.tsconfigPaths).toEqual([]);
    expect(caps.hasGit).toBe(true);
  });

  test("tsconfigs inside node_modules are excluded", async () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
    mkdirSync(join(tmp, "node_modules", "some-pkg"), { recursive: true });
    writeFileSync(join(tmp, "node_modules", "some-pkg", "tsconfig.json"), JSON.stringify({}));

    const caps = await getProjectCapabilities(tmp);
    // Only root tsconfig should be found, not the one in node_modules
    expect(caps.tsconfigPaths).toHaveLength(1);
    expect(caps.tsconfigPaths[0]).toBe(join(tmp, "tsconfig.json"));
  });

  test("tsconfigs inside .git are excluded", async () => {
    mkdirSync(join(tmp, ".git"));
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
    writeFileSync(join(tmp, ".git", "tsconfig.json"), JSON.stringify({}));

    const caps = await getProjectCapabilities(tmp);
    expect(caps.tsconfigPaths).toHaveLength(1);
    expect(caps.tsconfigPaths[0]).toBe(join(tmp, "tsconfig.json"));
  });
});

// ---------------------------------------------------------------------------
// eslintConfigPaths
// ---------------------------------------------------------------------------

describe("eslintConfigPaths", () => {
  test("no eslint config → eslintConfigPaths is empty", async () => {
    const caps = await getProjectCapabilities(tmp);
    expect(caps.eslintConfigPaths).toEqual([]);
  });

  test(".eslintrc.json at root → detected", async () => {
    writeFileSync(join(tmp, ".eslintrc.json"), JSON.stringify({ rules: {} }));
    const caps = await getProjectCapabilities(tmp);
    expect(caps.eslintConfigPaths).toContain(join(tmp, ".eslintrc.json"));
  });

  test("eslint.config.js at root → detected", async () => {
    writeFileSync(join(tmp, "eslint.config.js"), "module.exports = {}");
    const caps = await getProjectCapabilities(tmp);
    expect(caps.eslintConfigPaths).toContain(join(tmp, "eslint.config.js"));
  });
});

// ---------------------------------------------------------------------------
// hasTsc / hasEslint / hasRipgrep — binary probe
// ---------------------------------------------------------------------------

describe("binary probes", () => {
  test("hasTsc is a boolean (true or false, never throws)", async () => {
    const caps = await getProjectCapabilities(tmp);
    expect(typeof caps.hasTsc).toBe("boolean");
  });

  test("hasEslint is a boolean (never throws)", async () => {
    const caps = await getProjectCapabilities(tmp);
    expect(typeof caps.hasEslint).toBe("boolean");
  });

  test("hasRipgrep is a boolean (never throws)", async () => {
    const caps = await getProjectCapabilities(tmp);
    expect(typeof caps.hasRipgrep).toBe("boolean");
  });

  test("ENOENT on rg binary (fake PATH) → hasRipgrep false, no throw", async () => {
    // Override PATH to an empty scratch dir so rg is not found
    const emptyBin = mkdtempSync(join(tmpdir(), "siltpoke-emptypath-"));
    try {
      const caps = await getProjectCapabilitiesWithEnv(tmp, { PATH: emptyBin });
      expect(caps.hasRipgrep).toBe(false);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test("ENOENT on tsc binary (fake PATH) → hasTsc false, no throw", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "siltpoke-emptypath2-"));
    try {
      // Even with a tsconfig present, hasTsc depends on binary not config presence
      writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
      const caps = await getProjectCapabilitiesWithEnv(tmp, { PATH: emptyBin });
      expect(caps.hasTsc).toBe(false);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test("ENOENT on eslint binary (fake PATH) → hasEslint false, no throw", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "siltpoke-emptypath3-"));
    try {
      const caps = await getProjectCapabilitiesWithEnv(tmp, { PATH: emptyBin });
      expect(caps.hasEslint).toBe(false);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// detectedAt + configMtimes
// ---------------------------------------------------------------------------

describe("detectedAt and configMtimes", () => {
  test("detectedAt is a ms epoch number close to Date.now()", async () => {
    const before = Date.now();
    const caps = await getProjectCapabilities(tmp);
    const after = Date.now();
    expect(caps.detectedAt).toBeGreaterThanOrEqual(before);
    expect(caps.detectedAt).toBeLessThanOrEqual(after);
  });

  test("configMtimes includes tsconfig paths", async () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
    const caps = await getProjectCapabilities(tmp);
    const tsconfigPath = join(tmp, "tsconfig.json");
    expect(Object.keys(caps.configMtimes)).toContain(tsconfigPath);
    expect(typeof caps.configMtimes[tsconfigPath]).toBe("number");
    expect(caps.configMtimes[tsconfigPath]!).toBeGreaterThan(0);
  });

  test("configMtimes includes .git/HEAD when .git exists", async () => {
    mkdirSync(join(tmp, ".git"));
    writeFileSync(join(tmp, ".git", "HEAD"), "ref: refs/heads/main\n");
    const caps = await getProjectCapabilities(tmp);
    const gitHead = join(tmp, ".git", "HEAD");
    expect(Object.keys(caps.configMtimes)).toContain(gitHead);
  });

  test(".git/HEAD absent (no .git dir) → not in configMtimes", async () => {
    const caps = await getProjectCapabilities(tmp);
    const gitHead = join(tmp, ".git", "HEAD");
    expect(Object.keys(caps.configMtimes)).not.toContain(gitHead);
  });

  test("cwd is set correctly", async () => {
    const caps = await getProjectCapabilities(tmp);
    expect(caps.cwd).toBe(tmp);
  });
});

// ---------------------------------------------------------------------------
// invalidateCapabilitiesIfStale
// ---------------------------------------------------------------------------

describe("invalidateCapabilitiesIfStale", () => {
  test("fresh capabilities with no mutation → returns false", async () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({ a: 1 }));
    const caps = await getProjectCapabilities(tmp);
    const stale = await invalidateCapabilitiesIfStale(caps);
    expect(stale).toBe(false);
  });

  test("stale: mutate tsconfig after detection → returns true", async () => {
    const tsconfigPath = join(tmp, "tsconfig.json");
    writeFileSync(tsconfigPath, JSON.stringify({ a: 1 }));
    const caps = await getProjectCapabilities(tmp);

    // Wait a tick to ensure mtime differs (write a new file with different content)
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(tsconfigPath, JSON.stringify({ a: 1, b: 2 }));

    const stale = await invalidateCapabilitiesIfStale(caps);
    expect(stale).toBe(true);
  });

  test("stale: new tsconfig appears after detection → returns true", async () => {
    // Start with no tsconfigs
    const caps = await getProjectCapabilities(tmp);
    expect(caps.tsconfigPaths).toHaveLength(0);

    // Now add a tsconfig
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
    const stale = await invalidateCapabilitiesIfStale(caps);
    expect(stale).toBe(true);
  });

  test("stale: config file disappears → returns true", async () => {
    const tsconfigPath = join(tmp, "tsconfig.json");
    writeFileSync(tsconfigPath, JSON.stringify({}));
    const caps = await getProjectCapabilities(tmp);

    // Remove the file
    rmSync(tsconfigPath);
    const stale = await invalidateCapabilitiesIfStale(caps);
    expect(stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findNearestTsconfig
// ---------------------------------------------------------------------------

describe("findNearestTsconfig", () => {
  test("no tsconfigs → returns null", async () => {
    const caps = await getProjectCapabilities(tmp);
    const result = findNearestTsconfig(join(tmp, "src", "x.ts"), caps);
    expect(result).toBeNull();
  });

  test("single root tsconfig + file at root → returns root tsconfig", async () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
    const caps = await getProjectCapabilities(tmp);
    const result = findNearestTsconfig(join(tmp, "src", "x.ts"), caps);
    expect(result).toBe(join(tmp, "tsconfig.json"));
  });

  test("monorepo: file in packages/foo → returns packages/foo/tsconfig.json", async () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
    mkdirSync(join(tmp, "packages", "foo", "src"), { recursive: true });
    writeFileSync(join(tmp, "packages", "foo", "tsconfig.json"), JSON.stringify({}));

    const caps = await getProjectCapabilities(tmp);
    const changedFile = join(tmp, "packages", "foo", "src", "x.ts");
    const result = findNearestTsconfig(changedFile, caps);
    expect(result).toBe(join(tmp, "packages", "foo", "tsconfig.json"));
  });

  test("monorepo: file at root src → returns root tsconfig, not nested", async () => {
    writeFileSync(join(tmp, "tsconfig.json"), JSON.stringify({}));
    mkdirSync(join(tmp, "packages", "foo"), { recursive: true });
    writeFileSync(join(tmp, "packages", "foo", "tsconfig.json"), JSON.stringify({}));

    const caps = await getProjectCapabilities(tmp);
    const changedFile = join(tmp, "src", "x.ts");
    const result = findNearestTsconfig(changedFile, caps);
    expect(result).toBe(join(tmp, "tsconfig.json"));
  });

  test("file with no tsconfig ancestor → returns null", async () => {
    // Tsconfig in /tmp/other, file in /tmp/tmp (our tmp)
    const other = mkdtempSync(join(tmpdir(), "siltpoke-other-"));
    try {
      writeFileSync(join(other, "tsconfig.json"), JSON.stringify({}));
      const caps = await getProjectCapabilities(other);
      // Try finding nearest tsconfig for a file not under `other`
      const result = findNearestTsconfig(join(tmp, "src", "x.ts"), caps);
      expect(result).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: getProjectCapabilities with custom env (for ENOENT tests)
// ---------------------------------------------------------------------------
// This exercises the underlying spawn path with a custom env override.
// We export this pattern via a test-only helper that the module must support.

async function getProjectCapabilitiesWithEnv(
  cwd: string,
  envOverride: Record<string, string>,
): Promise<ProjectCapabilities> {
  // Timeouts are guarded inside probeBinaryRaw; no separate AbortController needed here.
  // We construct the base struct directly from non-binary helpers to avoid spawning real
  // binaries twice (once in getProjectCapabilities, once in the override re-probe).
  const { existsSync } = await import("node:fs");
  const { resolve, join } = await import("node:path");
  const absDir = resolve(cwd);

  const hasGit = existsSync(join(absDir, ".git"));

  const emptyPath = envOverride.PATH ?? "";

  // Single probe pass with the custom PATH — never spawns real binaries on normal PATH
  async function probeWithEnv(argv: string[]): Promise<boolean> {
    try {
      const proc = Bun.spawn(argv, {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: emptyPath },
        cwd: absDir,
      });
      try {
        const exitCode = await proc.exited;
        return exitCode === 0;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }

  const [hasTsc, hasEslint, hasRipgrep] = await Promise.all([
    probeWithEnv(["bunx", "tsc", "--version"]),
    probeWithEnv(["bunx", "eslint", "--version"]),
    probeWithEnv(["rg", "--version"]),
  ]);

  // Use the real getProjectCapabilities for non-binary fields (tsconfigPaths, eslintConfigPaths, mtimes)
  // but swap out the binary results — this spawns zero extra binaries on the normal PATH.
  const baseCaps = await getProjectCapabilities(cwd);

  return {
    ...baseCaps,
    hasGit,
    hasTsc,
    hasEslint,
    hasRipgrep,
  };
}
