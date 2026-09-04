// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { resolveHostCwd } from "../../src/hooks/resolve-host-cwd";

// Fake `exists` that reports a `.git` marker only at the given repo roots.
function gitAt(...roots: string[]): (p: string) => boolean {
  const markers = new Set(roots.map((r) => `${r}/.git`));
  return (p) => markers.has(p);
}

describe("resolveHostCwd", () => {
  test("agy -p: payload cwd (agy config dir) doesn't contain the edit → re-anchors to the git root", () => {
    const cwd = resolveHostCwd(
      {
        host: "antigravity",
        payloadCwd: "/Users/v/.gemini/config",
        changedFiles: ["/Users/v/repo/src/token.ts"],
      },
      gitAt("/Users/v/repo"),
    );
    expect(cwd).toBe("/Users/v/repo");
  });

  test("agy: no git root found → falls back to the edited file's dirname", () => {
    const cwd = resolveHostCwd(
      {
        host: "antigravity",
        payloadCwd: "/Users/v/.gemini/config",
        changedFiles: ["/Users/v/loose/token.ts"],
      },
      gitAt(), // no .git anywhere
    );
    expect(cwd).toBe("/Users/v/loose");
  });

  test("agy interactive: payload cwd already contains the edit → left untouched (no re-anchor)", () => {
    const cwd = resolveHostCwd(
      {
        host: "antigravity",
        payloadCwd: "/Users/v/repo",
        changedFiles: ["/Users/v/repo/src/token.ts"],
      },
      gitAt("/Users/v/repo"),
    );
    expect(cwd).toBe("/Users/v/repo");
  });

  test("agy: payload cwd undefined + absolute edit → re-anchors to git root", () => {
    const cwd = resolveHostCwd(
      { host: "antigravity", payloadCwd: undefined, changedFiles: ["/Users/v/repo/a.ts"] },
      gitAt("/Users/v/repo"),
    );
    expect(cwd).toBe("/Users/v/repo");
  });

  test("agy: no ABSOLUTE changed files (only relative) → payload cwd untouched", () => {
    const cwd = resolveHostCwd(
      { host: "antigravity", payloadCwd: "/Users/v/.gemini/config", changedFiles: ["src/token.ts"] },
      gitAt("/Users/v/repo"),
    );
    expect(cwd).toBe("/Users/v/.gemini/config");
  });

  test("non-agy host (codex/codebuddy/claude): always returns the payload cwd unchanged", () => {
    for (const host of ["codex", "codebuddy", "qodercli", undefined]) {
      const cwd = resolveHostCwd(
        { host, payloadCwd: "/whatever", changedFiles: ["/somewhere/else/x.ts"] },
        gitAt("/somewhere/else"),
      );
      expect(cwd).toBe("/whatever");
    }
  });

  test("cwd-contains guard is prefix-safe (a sibling dir sharing a name prefix is NOT 'contained')", () => {
    // /Users/v/repo-2/x.ts must NOT count as contained by /Users/v/repo.
    const cwd = resolveHostCwd(
      {
        host: "antigravity",
        payloadCwd: "/Users/v/repo",
        changedFiles: ["/Users/v/repo-2/x.ts"],
      },
      gitAt("/Users/v/repo-2"),
    );
    expect(cwd).toBe("/Users/v/repo-2");
  });
});
