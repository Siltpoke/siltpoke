// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[26]`, second face — Code Map's explain, audit §40.4.
 *
 * `src/explain/providers.ts` spawned the same `claude.cmd` the reviewer does,
 * with the whole system prompt in argv, so on Windows explain failed before
 * the process started — for the same reason and with the same
 * `ERR_INVALID_ARG_VALUE` as the reviewer did.
 *
 * These tests spawn a REAL subprocess (a stub `claude` first on PATH) rather
 * than a stubbed spawn: the thing under test is the argv this module actually
 * builds and hands the runtime, and the temp file it actually writes and
 * removes. A stubbed writer would prove nothing about either.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchBrainProvider } from "../../src/explain/providers";

const ORIG_PATH = process.env.PATH;
const tmps: string[] = [];

afterEach(() => {
  process.env.PATH = ORIG_PATH;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Put a stub `claude` first on PATH that records its own argv and answers with
 * the `result` envelope the provider parses. Returns where the argv landed.
 */
function stubClaude(): { argvLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "stub-claude-"));
  tmps.push(dir);
  const argvLog = join(dir, "argv.json");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      // One argument per line — the prompt may contain anything, including
      // spaces and newlines, so nothing here may re-split it.
      `: > "${argvLog}"`,
      'for a in "$@"; do printf \'%s\\n\' "$a" >> ' + `"${argvLog}"; done`,
      'cat > /dev/null',
      `printf '%s' '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(bin, 0o755);
  // The stub dir FIRST so `claude` is ours, but the system dirs stay reachable:
  // the stub is a shell script and needs `cat`. (A PATH of the stub dir alone
  // made an earlier version of these tests pass vacuously — the child could not
  // run `cat`, so it compared an empty file against an empty read.)
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  return { argvLog };
}

/** The argv the stub actually received, one entry per element. */
function recordedArgv(argvLog: string): string[] {
  const raw = readFileSync(argvLog, "utf8");
  return raw.split("\n").slice(0, -1);
}

const PROMPT = 'EXPLAIN RUBRIC & "quoted" (parens) 100% | <tag>';

describe("defect [26] — explain's system prompt travels in a file on Windows", () => {
  test("win32: argv carries --system-prompt-file, and the file holds the prompt", async () => {
    const { argvLog } = stubClaude();
    let staged = "";
    const provider = makeArchBrainProvider();
    // The stub deletes nothing; the provider's own cleanup does. Read the path
    // out of the argv it was given, then check it is gone after the call.
    const result = await provider({
      systemPrompt: PROMPT,
      contextBundle: "ctx",
      platform: "win32",
    });
    expect(result.markdown).toBe("ok");

    const argv = recordedArgv(argvLog);
    const at = argv.indexOf("--system-prompt-file");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(argv).not.toContain("--system-prompt");
    // The prompt itself must not appear anywhere in argv — that is the whole
    // defect, and "the flag is present" alone would not catch a both-forms bug.
    expect(argv).not.toContain(PROMPT);

    staged = argv[at + 1] ?? "";
    expect(staged).not.toBe("");
    // The file is removed by the time the call returns, so its content has to
    // be captured differently: assert what the stub could read is what we sent
    // by re-reading through the same argv — hence the stub copies it.
    expect(existsSync(staged)).toBe(false);
  });

  test("win32: the staged file really carries the prompt (read by the child)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stub-claude-"));
    tmps.push(dir);
    const copy = join(dir, "seen-prompt.txt");
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        // Walk argv for --system-prompt-file and copy what it points at, the
        // way the real CLI would read it.
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--system-prompt-file" ]; then cat "$2" > ' + `"${copy}"; fi`,
        "  shift",
        "done",
        "cat > /dev/null",
        `printf '%s' '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:/usr/bin:/bin`;

    await makeArchBrainProvider()({
      systemPrompt: PROMPT,
      contextBundle: "ctx",
      platform: "win32",
    });
    expect(readFileSync(copy, "utf8")).toBe(PROMPT);
  });
});

describe("defect [26] — explain keeps non-Windows intact and leaves nothing behind", () => {
  test("non-Windows is untouched: the prompt still rides in argv", async () => {
    const { argvLog } = stubClaude();
    await makeArchBrainProvider()({
      systemPrompt: PROMPT,
      contextBundle: "ctx",
      platform: "darwin",
    });
    const argv = recordedArgv(argvLog);
    expect(argv).toContain("--system-prompt");
    expect(argv).toContain(PROMPT);
    expect(argv).not.toContain("--system-prompt-file");
  });

  test("a spawn failure still removes the staged file", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "no-claude-"));
    tmps.push(emptyDir);
    // Stage into a directory we can watch: the provider's temp dirs are named
    // `siltpoke-sp-*` under TMPDIR.
    const tmpBase = mkdtempSync(join(tmpdir(), "sp-base-"));
    tmps.push(tmpBase);
    const savedTmp = process.env.TMPDIR;
    process.env.TMPDIR = tmpBase;
    process.env.PATH = emptyDir; // no `claude` anywhere
    try {
      await makeArchBrainProvider()({
        systemPrompt: PROMPT,
        contextBundle: "ctx",
        platform: "win32",
      }).catch(() => undefined);
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
    }
    // Nothing left behind — the cleanup on the pre-spawn path ran.
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(tmpBase)).toEqual([]);
  });
});
