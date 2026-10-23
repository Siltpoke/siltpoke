import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { resolveDaemonPath } from "../../src/installer/daemon-path";

describe("resolveDaemonPath", () => {
  const home = "/Users/tester";
  const fallbacks = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    "/usr/bin",
    "/bin",
  ];

  test("resolved bun + claude dirs come FIRST, before the fallbacks", () => {
    const which = (bin: string): string | null => {
      if (bin === "bun") return "/Users/tester/.bun/bin/bun";
      if (bin === "claude") return "/Users/tester/.local/bin/claude";
      return null;
    };
    const { path, warnings } = resolveDaemonPath({ which, home });
    const dirs = path.split(":");
    // Resolved dirs (deduped against fallbacks) lead.
    expect(dirs[0]).toBe("/Users/tester/.bun/bin");
    expect(dirs[1]).toBe("/Users/tester/.local/bin");
    // Every fallback dir is present somewhere.
    for (const f of fallbacks) {
      expect(dirs).toContain(f);
    }
    expect(warnings).toEqual([]);
  });

  // Defect [49]: dashboard chat can launch any of the five agents, so the daemon
  // has to be able to find the other four as well.
  test("the other four agents' folders are on the PATH too, after bun and claude", () => {
    const where: Record<string, string> = {
      bun: "/Users/tester/.bun/bin/bun",
      claude: "/Users/tester/.local/bin/claude",
      codex: "/opt/codex/bin/codex",
      agy: "/opt/agy/agy",
      qodercli: "/Users/tester/.qoder/bin/qodercli",
      codebuddy: "/Users/tester/.nvm/versions/node/v22/bin/codebuddy",
    };
    const { path, warnings } = resolveDaemonPath({ which: (bin) => where[bin] ?? null, home });
    const dirs = path.split(":");
    expect(dirs.slice(0, 6)).toEqual([
      "/Users/tester/.bun/bin",
      "/Users/tester/.local/bin",
      "/opt/codex/bin",
      "/opt/agy",
      "/Users/tester/.qoder/bin",
      "/Users/tester/.nvm/versions/node/v22/bin",
    ]);
    expect(warnings).toEqual([]);
  });

  test("a missing agent other than claude is not a warning — most users have one or two", () => {
    const which = (bin: string): string | null =>
      bin === "bun" ? "/b/bun" : bin === "claude" ? "/c/claude" : bin === "codebuddy" ? "/cb/codebuddy" : null;
    const { path, warnings } = resolveDaemonPath({ which, home });
    expect(path.split(":").slice(0, 3)).toEqual(["/b", "/c", "/cb"]);
    expect(warnings).toEqual([]);
  });

  test("de-dupes: a dir never appears twice, order preserved", () => {
    // bun resolves to a fallback dir already in the list.
    const which = (bin: string): string | null => {
      if (bin === "bun") return "/usr/local/bin/bun";
      if (bin === "claude") return "/opt/homebrew/bin/claude";
      return null;
    };
    const { path } = resolveDaemonPath({ which, home });
    const dirs = path.split(":");
    const unique = new Set(dirs);
    expect(unique.size).toBe(dirs.length); // no duplicates
    // Resolved dirs still lead even though they overlap fallbacks.
    expect(dirs[0]).toBe("/usr/local/bin");
    expect(dirs[1]).toBe("/opt/homebrew/bin");
  });

  test("expands ~ / ${HOME} fallbacks to the real home", () => {
    const which = (): string | null => null; // nothing resolves
    const { path } = resolveDaemonPath({ which, home });
    expect(path).toContain(join(home, ".local", "bin"));
    expect(path).toContain(join(home, ".bun", "bin"));
    // No literal ~ or ${HOME} leaks into the PATH.
    expect(path).not.toContain("~");
    expect(path).not.toContain("${HOME}");
  });

  test("contingency: claude resolution fails → fallback PATH + warning, no throw", () => {
    const which = (bin: string): string | null => {
      if (bin === "bun") return "/Users/tester/.bun/bin/bun";
      return null; // claude not found
    };
    const { path, warnings } = resolveDaemonPath({ which, home });
    expect(path).toContain("/Users/tester/.bun/bin"); // bun still leads
    for (const f of fallbacks) {
      expect(path.split(":")).toContain(f);
    }
    expect(warnings.some((w) => w.includes("claude"))).toBe(true);
  });

  test("contingency: both bun + claude fail → pure fallback PATH, two warnings, no throw", () => {
    const which = (): string | null => null;
    const { path, warnings } = resolveDaemonPath({ which, home });
    expect(path.split(":")).toEqual(fallbacks);
    expect(warnings).toHaveLength(2);
  });
});
