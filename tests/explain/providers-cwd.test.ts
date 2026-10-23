// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[83]` (audit §100.1): Code Map's explain wrote about a same-named
 * file in ANOTHER folder. The `claude -p` child was started with no working
 * directory, so it ran wherever the dashboard daemon had been launched, and
 * with no tool limit, so it could open files there and cite their lines.
 *
 * The provider half spawns a REAL subprocess (a stub `claude` first on PATH)
 * that records its own working directory and argv: what is under test is what
 * this module hands the runtime, not a stubbed spawn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPLAIN_TOOLS, isPreSpawnError, makeArchBrainProvider, makeDefaultBrainProvider } from "../../src/explain/providers";

const ORIG_PATH = process.env.PATH;
const tmps: string[] = [];

afterEach(() => {
  process.env.PATH = ORIG_PATH;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return realpathSync(d);
}

/** A stub `claude` that records `pwd -P` and its argv, then answers. */
function stubClaude(): { cwdLog: string; argvLog: string } {
  const dir = tmp("stub-claude-cwd-");
  const cwdLog = join(dir, "cwd.txt");
  const argvLog = join(dir, "argv.txt");
  writeFileSync(
    join(dir, "claude"),
    [
      "#!/bin/sh",
      `pwd -P > "${cwdLog}"`,
      `: > "${argvLog}"`,
      `for a in "$@"; do printf '%s\\n' "$a" >> "${argvLog}"; done`,
      "cat > /dev/null",
      `printf '%s' '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(join(dir, "claude"), 0o755);
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  return { cwdLog, argvLog };
}

const argvOf = (log: string): string[] => readFileSync(log, "utf8").split("\n").slice(0, -1);

describe("[83] explain's claude runs in the selected project, read-only", () => {
  for (const [name, make] of [
    ["symbol explain", makeDefaultBrainProvider],
    ["architecture generate", makeArchBrainProvider],
  ] as const) {
    test(`${name}: the child's working directory is the project it was given`, async () => {
      const { cwdLog } = stubClaude();
      const project = tmp("project-b-");
      await make()({ systemPrompt: "s", contextBundle: "c", cwd: project, platform: "darwin" });
      expect(readFileSync(cwdLog, "utf8").trim()).toBe(project);
      expect(readFileSync(cwdLog, "utf8").trim()).not.toBe(realpathSync(process.cwd()));
    });

    test(`${name}: the same holds on the result-file (daemon) path`, async () => {
      const { cwdLog } = stubClaude();
      const project = tmp("project-b-");
      const out = join(tmp("task-"), "t.out");
      await make()({ systemPrompt: "s", contextBundle: "c", cwd: project, resultFilePath: out, platform: "darwin" });
      expect(readFileSync(cwdLog, "utf8").trim()).toBe(project);
    });

    test(`${name}: the tools are limited to reading`, async () => {
      const { argvLog } = stubClaude();
      await make()({ systemPrompt: "s", contextBundle: "c", cwd: tmp("project-b-"), platform: "darwin" });
      const argv = argvOf(argvLog);
      const i = argv.indexOf("--tools");
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe(EXPLAIN_TOOLS);
    });

    test(`${name}: MCP servers from the user's config are not loaded`, async () => {
      const { argvLog } = stubClaude();
      await make()({ systemPrompt: "s", contextBundle: "c", cwd: tmp("project-c-"), platform: "darwin" });
      expect(argvOf(argvLog)).toContain("--strict-mcp-config");
    });

    // The child runs in the project's folder (above). Without this, claude -p
    // loaded that project's CLAUDE.md and ran its .claude/settings.json hooks
    // with no trust prompt — measured 2026-10-18.
    // win32 stages the system prompt in a file; the flag must survive that path too.
    for (const platform of ["darwin", "win32"] as const) {
      test(`${name} (${platform}): only the user's own settings load, never the project's`, async () => {
        const { argvLog } = stubClaude();
        await make()({ systemPrompt: "s", contextBundle: "c", cwd: tmp("project-d-"), platform });
        const argv = argvOf(argvLog);
        const i = argv.indexOf("--setting-sources");
        expect(i).toBeGreaterThan(-1);
        expect(argv[i + 1]).toBe("user");
        expect(argv.filter((a) => a === "--setting-sources")).toHaveLength(1);
      });
    }
  }

  test("a project folder that no longer exists is named, and nothing is spawned", async () => {
    const { cwdLog } = stubClaude();
    const gone = join(tmp("project-gone-"), "deleted");
    const err = await makeDefaultBrainProvider()({ systemPrompt: "s", contextBundle: "c", cwd: gone, platform: "darwin" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPreSpawnError(err)).toBe(true);
    expect(String(err)).toContain(`the project folder is gone: ${gone}`);
    expect(existsSync(cwdLog)).toBe(false);
  });

  test("the tool list has no tool that runs commands, writes or fetches", () => {
    const tools = EXPLAIN_TOOLS.split(",");
    expect(tools.sort()).toEqual(["Glob", "Grep", "Read"]);
  });
});
