// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[26]`, codex half — does the review rubric travel in a profile file on
 * Windows, and in argv everywhere else?
 *
 * Separate file rather than an addition to codex.test.ts, which is pinned at 479
 * lines by the length ratchet (pins only move down).
 *
 * The escaper's fidelity is NOT asserted by re-deriving its own output here.
 * That was measured out-of-band with two independent parsers (2026-09-26):
 * python `tomllib` round-trips a prompt carrying quotes, backslashes, a tab, a
 * CR, a form feed, a backspace, `\u0001`, DEL and multi-byte UTF-8 EXACTLY
 * (with a mutated-expectation control proving the oracle can fail), and codex's
 * own Rust parser accepts the file under `--strict-config` while rejecting a
 * deliberately unterminated one. Bun's TOML parser is deliberately NOT used as
 * an oracle: it decoded a `\t` escape as a form feed. What the tests below
 * assert is the STRUCTURAL property that makes the file parseable at all — no
 * raw newline, no unescaped quote — plus the exact wire format, so a future
 * edit to the escaper has to be deliberate.
 */

import { test, expect } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CallBrainOptions } from "../../../src/brain/brain";
import { developerInstructionsArgs } from "../../../src/brain/providers/codex-instructions";
import { makeCodexProvider } from "../../../src/brain/providers/codex";

const RUBRIC = 'REVIEW RUBRIC with "quotes" and\na newline';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "codex-instr-"));
}

// ── the argv fragment ────────────────────────────────────────────────────

test("win32: the rubric goes to a profile file, and its text is nowhere in argv", () => {
  const home = tempHome();
  const { args, cleanup } = developerInstructionsArgs(RUBRIC, {
    platform: "win32",
    codexHome: home,
  });

  expect(args[0]).toBe("--profile");
  expect(args).toHaveLength(2);
  expect(args.join(" ")).not.toContain("REVIEW RUBRIC");
  expect(args.join(" ")).not.toContain("developer_instructions");

  // The profile NAME still rides argv, so it has to be free of the very
  // characters this whole path exists to keep out of argv.
  expect(args[1]).toMatch(/^siltpoke-review-[0-9]+-[0-9a-f-]+$/);

  // And the file carries the rubric — a `--profile` pointing at a file codex
  // cannot find is silently ignored (measured), which would review with no
  // instructions while every assertion above still passed.
  const file = join(home, `${args[1]}.config.toml`);
  const written = readFileSync(file, "utf8");
  // The exact TOML wire format is asserted in codex-profile-toml.test.ts,
  // against the same written file. Here it only has to carry the rubric.
  expect(written.startsWith("developer_instructions = ")).toBe(true);
  expect(written).toContain("REVIEW RUBRIC");

  cleanup();
  expect(existsSync(file)).toBe(false);
});

test("off win32: argv form unchanged — the path that already works", () => {
  const home = tempHome();
  const { args } = developerInstructionsArgs(RUBRIC, {
    platform: "darwin",
    codexHome: home,
  });

  expect(args).toEqual(["-c", `developer_instructions=${RUBRIC}`]);
  // Nothing staged on disk: a file written and then ignored would be a leak
  // with no assertion anywhere.
  expect(readdirSync(home)).toEqual([]);
});

test("win32 with an unusable CODEX_HOME: falls back to argv and says so", () => {
  const warnings: string[] = [];
  const realError = console.error;
  console.error = (...parts: unknown[]) => {
    warnings.push(parts.join(" "));
  };
  try {
    // A path under a regular FILE can never become a directory.
    const { args } = developerInstructionsArgs(RUBRIC, {
      platform: "win32",
      codexHome: join(import.meta.path, "not-a-dir"),
    });
    expect(args).toEqual(["-c", `developer_instructions=${RUBRIC}`]);
  } finally {
    console.error = realError;
  }
  // Silence here is the failure mode that matters: the operator would see
  // exactly defect [26]'s own error and conclude the fix never shipped.
  expect(warnings.join("\n")).toContain("defect [26]");
});

// ── through the provider ─────────────────────────────────────────────────

const HAPPY_JSONL = [
  JSON.stringify({ type: "thread.started", thread_id: "t" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1",
      type: "agent_message",
      text: JSON.stringify({
        mood: "happy",
        pose: "base",
        bubble_short: "looks good",
        bubble_long: "",
        critique_for_claude: "",
        severity: "info",
        confidence: "high",
        xp_earned_events: [],
      }),
    },
  }),
  JSON.stringify({ type: "turn.completed", usage: {} }),
].join("\n");

interface Seen {
  argv?: string[];
  fileAtSpawn?: string;
  childCodexHome?: string;
  home: string;
}

/** Records argv, and reads the profile file WHILE the process is notionally
 * running — it is deleted as soon as the call returns, which is the point. */
function capturingSpawn(seen: Seen): typeof Bun.spawn {
  return ((cmd: string[], options: { env?: Record<string, string> }) => {
    seen.argv = cmd;
    seen.childCodexHome = options.env?.CODEX_HOME;
    const i = cmd.indexOf("--profile");
    if (i > -1) {
      seen.fileAtSpawn = readFileSync(
        join(seen.home, `${cmd[i + 1]}.config.toml`),
        "utf8",
      );
    }
    return {
      stdin: { write: (_s: string) => {}, end: () => {} },
      stdout: new Response(HAPPY_JSONL).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

const baseOpts = (over: Partial<CallBrainOptions> = {}): CallBrainOptions => ({
  systemPrompt: RUBRIC,
  contextBundle: "diff under review",
  cwd: "/repo/under/review",
  ...over,
});

test("codex on win32: argv carries a profile name, and the file is cleaned up after the call", async () => {
  // configHome is the HOME seam; the provider derives <home>/.codex from it,
  // which is what CODEX_HOME points at in production.
  const configHome = tempHome();
  const seen = { home: join(configHome, ".codex") } as Seen;

  await makeCodexProvider({ configHome }).call(
    baseOpts({ platform: "win32", spawnFn: capturingSpawn(seen) }),
  );

  expect(seen.argv).toContain("--profile");
  // No rubric rides a `-c` on Windows (the short, cmd-safe sandbox `-c`s may).
  expect(seen.argv!.some((a) => a.startsWith("developer_instructions="))).toBe(false);
  expect(seen.argv!.join(" ")).not.toContain("REVIEW RUBRIC");
  // ...and the Windows sandbox is plain read-only: the macOS profile is unmeasured there.
  expect(seen.argv!.slice(seen.argv!.indexOf("--skip-git-repo-check") + 1, seen.argv!.indexOf("-C"))).toEqual([
    "-s",
    "read-only",
    "-c",
    "project_doc_max_bytes=0",
  ]);
  // The rubric really was in the file at spawn time — this is the control that
  // makes "gone" below mean cleaned-up rather than never-written.
  expect(seen.fileAtSpawn).toContain("REVIEW RUBRIC");

  const i = seen.argv!.indexOf("--profile");
  expect(existsSync(join(seen.home, `${seen.argv![i + 1]}.config.toml`))).toBe(
    false,
  );
  // Nothing of ours is left behind in CODEX_HOME at all.
  expect(readdirSync(seen.home)).toEqual([]);
});

test("codex on win32: the child is told to read the directory we wrote to", async () => {
  // Without this, argv can name a profile that the child looks for somewhere
  // else — and codex ignores a profile file it cannot find WITHOUT SAYING SO,
  // so the review would run with no rubric and still report a result. Raised by
  // a cross-family review of this change; the mock's own `seen.home` had hidden
  // it, because the test read the file from where the TEST knew it was.
  const configHome = tempHome();
  const seen = { home: join(configHome, ".codex") } as Seen;

  await makeCodexProvider({ configHome }).call(
    baseOpts({ platform: "win32", spawnFn: capturingSpawn(seen) }),
  );

  expect(seen.childCodexHome).toBe(seen.home);
  // And the file really was in that directory at spawn time, so this is a
  // match between two real things rather than two undefineds.
  expect(seen.fileAtSpawn).toContain("REVIEW RUBRIC");
});

test("codex off win32: CODEX_HOME is left alone — nothing was staged", async () => {
  const configHome = tempHome();
  const seen = { home: join(configHome, ".codex") } as Seen;

  await makeCodexProvider({ configHome }).call(
    baseOpts({ platform: "darwin", spawnFn: capturingSpawn(seen) }),
  );

  // Pinning CODEX_HOME on a path that wrote no profile file would relocate the
  // child's whole config (auth included) for no reason.
  expect(seen.childCodexHome).toBeUndefined();
});

test("codex off win32: still passes the rubric as -c developer_instructions", async () => {
  const configHome = tempHome();
  const seen = { home: join(configHome, ".codex") } as Seen;

  await makeCodexProvider({ configHome }).call(
    baseOpts({ platform: "darwin", spawnFn: capturingSpawn(seen) }),
  );

  expect(seen.argv).toContain("-c");
  expect(seen.argv).toContain(`developer_instructions=${RUBRIC}`);
  expect(seen.argv).not.toContain("--profile");
});

test("codex on win32: a spawn that throws still removes the profile file", async () => {
  const configHome = tempHome();
  const home = join(configHome, ".codex");
  const throwingSpawn = (() => {
    throw new Error("spawn blew up");
  }) as unknown as typeof Bun.spawn;

  await expect(
    makeCodexProvider({ configHome }).call(
      baseOpts({ platform: "win32", spawnFn: throwingSpawn }),
    ),
  ).rejects.toThrow(/spawn failed/);

  // The throw leaves before any caller `finally` is armed — without the
  // cleanup on that path the rubric would linger in CODEX_HOME once per review.
  expect(existsSync(home) ? readdirSync(home) : []).toEqual([]);
});

test("codex on win32: a throwing stdin.write still removes the profile file", async () => {
  // This is the hunk the try/finally restructuring was written FOR, and it had
  // no assertion: every spawn mock in the suite has a non-throwing stdin, so
  // moving the two write lines back above the `try` kept all 597 brain tests
  // green. Raised by a cross-check of this change.
  const configHome = tempHome();
  const home = join(configHome, ".codex");
  let fileWhileRunning: string | undefined;

  const throwingStdinSpawn = ((cmd: string[], _options: unknown) => {
    const i = cmd.indexOf("--profile");
    if (i > -1) {
      fileWhileRunning = join(home, `${cmd[i + 1]}.config.toml`);
    }
    return {
      stdin: {
        write: (_s: string) => {
          throw new Error("EPIPE: the child exited before we wrote");
        },
        end: () => {},
      },
      stdout: new Response(HAPPY_JSONL).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;

  await expect(
    makeCodexProvider({ configHome }).call(
      baseOpts({ platform: "win32", spawnFn: throwingStdinSpawn }),
    ),
  ).rejects.toThrow(/EPIPE/);

  // The control: a file really was staged, so "gone" below means deleted rather
  // than never written.
  expect(fileWhileRunning).toBeDefined();
  expect(existsSync(fileWhileRunning!)).toBe(false);
  expect(readdirSync(home)).toEqual([]);
});

test("the profile file is swept if an earlier run was killed before it could clean up", () => {
  // `cleanup` covers every in-process exit, but not the process being killed
  // between the write and the `finally`. Unlike the sibling path, which stages
  // under a temp dir the OS eventually sweeps, `$CODEX_HOME` is a durable config
  // directory — one killed daemon would otherwise leave one review rubric there
  // permanently. Raised by a cross-check of this change.
  const home = tempHome();
  const orphan = join(home, "siltpoke-review-999-deadbeef.config.toml");
  const fresh = join(home, "siltpoke-review-998-cafebabe.config.toml");
  const foreign = join(home, "config.toml");
  // Shares our prefix but is not a profile file. Without the extension half of
  // the filter this is deleted too, and dropping that half left the test green
  // (measured) until this file existed.
  const prefixedNonProfile = join(home, "siltpoke-review-notes.txt");
  writeFileSync(orphan, "developer_instructions = \"old rubric\"\n");
  writeFileSync(fresh, "developer_instructions = \"a live review's rubric\"\n");
  writeFileSync(foreign, "model = \"gpt-5\"\n");
  writeFileSync(prefixedNonProfile, "not a profile file\n");
  // Seven hours old — past the sweep's cutoff. `fresh` keeps its real mtime.
  //
  // `foreign` is aged TOO, deliberately: with a fresh mtime the age check alone
  // protected it, so the test could not tell the name filter from the age
  // filter — removing the name filter entirely left this test green (measured).
  // Aged, it can only survive because of its name.
  const old = Date.now() - 7 * 60 * 60 * 1000;
  utimesSync(orphan, old / 1000, old / 1000);
  utimesSync(foreign, old / 1000, old / 1000);
  utimesSync(prefixedNonProfile, old / 1000, old / 1000);

  const { cleanup } = developerInstructionsArgs(RUBRIC, {
    platform: "win32",
    codexHome: home,
  });
  cleanup();

  expect(existsSync(orphan)).toBe(false);
  // Only old files of ours: a concurrent review's file must survive, and a file
  // that is not ours must never be touched — this is the user's config dir.
  expect(existsSync(fresh)).toBe(true);
  expect(existsSync(foreign)).toBe(true);
  expect(existsSync(prefixedNonProfile)).toBe(true);
});

test("a relative CODEX_HOME is resolved before use — parent and child must agree", () => {
  // We resolve a relative CODEX_HOME against the daemon's cwd; the child would
  // resolve it against the reviewed repo's cwd, which we pass to spawn. Two
  // different directories, and codex ignores a profile file it cannot find
  // without saying so. Raised by a cross-check of this change.
  const { args, codexHome, cleanup } = developerInstructionsArgs(RUBRIC, {
    platform: "win32",
    codexHome: "./relative-codex-home",
  });
  try {
    expect(codexHome).toBeDefined();
    expect(isAbsolute(codexHome!)).toBe(true);
    // And it is the directory the file is actually in.
    expect(existsSync(join(codexHome!, `${args[1]}.config.toml`))).toBe(true);
  } finally {
    cleanup();
    rmSync("./relative-codex-home", { recursive: true, force: true });
  }
});
