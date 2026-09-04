import { describe, test, expect } from "bun:test";
import {
  resolveBunBinary,
  resolveDaemonScript,
  resolveDashboardCli,
  resolveRestartField,
} from "../../src/face/wrapper";

describe("resolveRestartField", () => {
  test("returns bun + script when bun resolves", () => {
    const f = resolveRestartField(() => "/Users/x/.bun/bin/bun", "/abs/cli/daemon.ts");
    expect(f).toEqual({ bun: "/Users/x/.bun/bin/bun", script: "/abs/cli/daemon.ts" });
  });

  test("undefined when bun can't be resolved (row omitted)", () => {
    expect(resolveRestartField(() => null, "/abs/cli/daemon.ts")).toBeUndefined();
  });
});

describe("resolveDaemonScript", () => {
  // Mirrors src/memory/distil-launcher.ts's basename(...) === "dist" precedent
  // (also used by resolveOnStopTarget in src/hooks/agy-stop.ts, commit
  // e24192b8): wrapper.ts ships two ways — bundled to dist/siltpoke-card.js
  // (scripts/build-dist.ts) alongside dist/siltpoke-daemon.js (the bundled
  // daemon), or run straight from src/face/wrapper.ts in a source install
  // where src/cli/daemon.ts is its sibling-directory target.
  test("BUNDLE install: dist/-located hereDir targets the bundled daemon", () => {
    expect(resolveDaemonScript("/Users/x/.siltpoke-plugin/dist")).toBe(
      "/Users/x/.siltpoke-plugin/dist/siltpoke-daemon.js",
    );
  });

  test("SOURCE install: src/face-located hereDir targets src/cli/daemon.ts", () => {
    expect(resolveDaemonScript("/repo/src/face")).toBe("/repo/src/cli/daemon.ts");
  });
});

describe("resolveDashboardCli", () => {
  test("BUNDLE install: dist/-located hereDir targets the bundled command CLI", () => {
    expect(resolveDashboardCli("/Users/x/.siltpoke-plugin/dist")).toBe(
      "/Users/x/.siltpoke-plugin/dist/siltpoke-cli.js",
    );
  });

  test("SOURCE install: src/face-located hereDir targets src/cli/plugin-cli.ts", () => {
    expect(resolveDashboardCli("/repo/src/face")).toBe("/repo/src/cli/plugin-cli.ts");
  });
});

describe("resolveBunBinary", () => {
  test("prefers process.execPath when non-empty, ignoring which", () => {
    const which = () => {
      throw new Error("which should not be called when execPath is present");
    };
    expect(resolveBunBinary("/opt/homebrew/Cellar/bun/1.2.0/bin/bun", which)).toBe(
      "/opt/homebrew/Cellar/bun/1.2.0/bin/bun",
    );
  });

  test("falls back to which(\"bun\") when execPath is undefined", () => {
    expect(resolveBunBinary(undefined, () => "/Users/x/.bun/bin/bun")).toBe(
      "/Users/x/.bun/bin/bun",
    );
  });

  test("falls back to which(\"bun\") when execPath is empty string", () => {
    expect(resolveBunBinary("", () => "/Users/x/.bun/bin/bun")).toBe("/Users/x/.bun/bin/bun");
  });

  test("returns null when both execPath and which are empty", () => {
    expect(resolveBunBinary(undefined, () => null)).toBeNull();
  });
});
