// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The sandbox half of the codex argv. Measured 2026-10-20: `-s read-only` let
 * codex read `../outside.txt` (2/2) and beat a permission profile when both
 * were set; a profile alone, with `sandbox_mode` as a config key, blocked the
 * read and kept writes blocked. AGENTS.md was obeyed 6/8 until
 * `project_doc_max_bytes=0` (0/8).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexReadRoots, codexSandboxArgs } from "../../../src/brain/providers/codex-sandbox";

// No git, no developer dir, a home with no git config.
const noGit = { runner: () => null, home: "/nonexistent-home" };

describe("codexSandboxArgs", () => {
  test("macOS: read-only as a config key, a profile that reads only the folder, no AGENTS.md", () => {
    expect(codexSandboxArgs("/Users/me/repo", "darwin", noGit)).toEqual([
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'default_permissions="siltpoke-read-only"',
      "-c",
      'permissions.siltpoke-read-only.filesystem={":minimal"="read","/Users/me/repo"="read"}',
      "-c",
      "permissions.siltpoke-read-only.network.enabled=false",
      "-c",
      "project_doc_max_bytes=0",
    ]);
  });

  test("macOS never passes -s: the override flag beats the profile and reopens the whole disk", () => {
    const args = codexSandboxArgs("/Users/me/repo", "darwin", noGit);
    expect(args).not.toContain("-s");
    expect(args).not.toContain("--sandbox");
  });

  test("the folder is quoted, so a path with a quote or backslash stays one TOML key", () => {
    const fs = codexSandboxArgs('/tmp/a "b"\\c', "darwin", noGit).find((a) => a.includes(".filesystem="));
    expect(fs).toContain('"/tmp/a \\"b\\"\\\\c"="read"');
  });

  test("inside a repo, the repo root, git's common dir and the developer dir are readable too", () => {
    const runner = (argv: string[]) =>
      argv[0] === "git" ? "/Users/me/repo\n/Users/me/repo/.git\n" : argv[0] === "xcode-select" ? "/Library/Developer/CommandLineTools\n" : null;
    const fs = codexSandboxArgs("/Users/me/repo/pkg", "darwin", { runner, home: "/nonexistent-home" }).find((a) =>
      a.includes(".filesystem="),
    );
    expect(fs).toBe(
      'permissions.siltpoke-read-only.filesystem={":minimal"="read","/Users/me/repo/pkg"="read","/Users/me/repo"="read","/Users/me/repo/.git"="read","/Library/Developer/CommandLineTools"="read"}',
    );
  });

  test("the git question is asked about the folder under review", () => {
    const seen: string[][] = [];
    codexSandboxArgs("/Users/me/repo/pkg", "darwin", { runner: (argv) => (seen.push(argv), null), home: "/nonexistent-home" });
    expect(seen).toContainEqual(["git", "-C", "/Users/me/repo/pkg", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
    expect(seen).toContainEqual(["xcode-select", "-p"]);
  });

  test("the user's global git config is readable when it exists (git exits without it); absent ones are not listed", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-home-")));
    try {
      writeFileSync(join(home, ".gitconfig"), "[user]\n");
      mkdirSync(join(home, ".config", "git"), { recursive: true });
      writeFileSync(join(home, ".config", "git", "ignore"), "*.log\n");
      writeFileSync(join(home, ".config", "git", "credentials"), "https://u:secret@example.com\n");
      const fs = codexSandboxArgs("/Users/me/repo", "darwin", { runner: () => null, home }).find((a) => a.includes(".filesystem="));
      expect(fs).toContain(`${JSON.stringify(join(home, ".gitconfig"))}="read"`);
      expect(fs).toContain(`${JSON.stringify(join(home, ".config", "git", "ignore"))}="read"`);
      // git's credential store lives here in plaintext: never the folder, never that file.
      expect(fs).not.toContain(`${JSON.stringify(join(home, ".config", "git"))}="read"`);
      expect(fs).not.toContain("credentials");
      expect(fs).not.toContain(join(home, ".config", "git", "config"));
      expect(fs).not.toContain(`${JSON.stringify(home)}="read"`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.each(["linux", "win32"] as const)("%s: plain -s read-only (the profile is unmeasured there), still no AGENTS.md", (platform) => {
    const args = codexSandboxArgs("/repo", platform);
    expect(args).toEqual(["-s", "read-only", "-c", "project_doc_max_bytes=0"]);
    expect(args.join(" ")).not.toContain("default_permissions");
  });
});

describe("codexReadRoots against real git", () => {
  function sh(cwd: string, ...args: string[]) {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  }

  test("a worktree reads its own folder and the main checkout's .git — not the main checkout's files", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "codex-roots-")));
    try {
      const main = join(base, "main");
      mkdirSync(main);
      sh(main, "init", "-q");
      writeFileSync(join(main, "a.txt"), "a");
      sh(main, "add", ".");
      sh(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
      const wt = join(base, "wt");
      sh(main, "worktree", "add", "-q", wt);
      const roots = codexReadRoots(join(wt));
      expect(roots).toContain(wt);
      expect(roots).toContain(join(main, ".git"));
      expect(roots).not.toContain(main);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a symlinked folder is listed as given and as its real path; outside a repo, nothing else", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "codex-roots-")));
    try {
      const target = join(base, "target");
      mkdirSync(target);
      const link = join(base, "link");
      symlinkSync(target, link);
      // Beyond these two, only the developer dir (macOS) — nothing else under `base`.
      expect(codexReadRoots(link).filter((r) => r.startsWith(base))).toEqual([link, target]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
