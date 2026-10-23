// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The Windows hook launcher, and the manifest entries that start it.
//
// WHAT CANNOT BE TESTED HERE, stated first so nothing below is mistaken for
// more than it is: this suite runs on macOS and never executes a line of
// PowerShell. It cannot tell you the launcher works. Its whole job is to hold
// the launcher to the ONE property that makes it safe to ship untested — that
// it contains no product logic — plus the manifest wiring, where a typo
// produces exactly the same silence as no entry at all.
//
// The launcher's real test is a run on the maintainer's Windows machine (spec §8).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const LAUNCHER = "hooks/siltpoke-hook.ps1";

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

/** The launcher with its comments removed — prose must not satisfy a guard. */
function launcherCode(): string {
  return read(LAUNCHER)
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
}

describe("the launcher holds no product logic", () => {
  // Every decision the guard makes, named by the thing it would have to
  // mention to make that decision here. If any of these appears in the
  // launcher, logic has leaked out of the one place it is tested.
  const GUARD_ONLY = [
    "config.json", // "has setup run?"
    "nudged", // the once-ever nudge marker (any name ending in it)
    "SILTPOKE_HOST", // host-family detection
    "CLAUDE_PLUGIN_ROOT", // plugin-root resolution
    "QODER_PLUGIN_ROOT",
    "CODEBUDDY_PLUGIN_ROOT",
    "markers", // the Stop dedupe marker
    "plugin-root", // the pointer file session-start writes
  ];

  for (const needle of GUARD_ONLY) {
    test(`does not mention ${needle}`, () => {
      expect(launcherCode()).not.toContain(needle);
    });
  }

  test("is short enough to read in one screen", () => {
    // Not a style rule. This file ships to Windows with no automated test of
    // its behaviour, so "a person can read all of it" is the only review it
    // will ever get. If it outgrows that, the logic belongs in the guard.
    //
    // Raised from 60 to 75 on 2026-09-24, deliberately and once: review found
    // three defects whose fixes are all failure HANDLING rather than product
    // logic — draining both output pipes asynchronously before writing stdin
    // (the deadlock), a bounded wait for the probe, and the two reason lines
    // the launcher must answer for a guard it cannot reach. Squeezing those
    // back under 60 by collapsing them onto single lines would defeat the one
    // thing this cap protects. It moves for that kind of reason or not at all.
    const lines = launcherCode().split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThan(75);
  });

  test("exits 0 unconditionally, via finally", () => {
    // The contract it inherits from hooks/stop.sh: nothing may reach the
    // user's session, and no path may exit non-zero.
    expect(launcherCode()).toContain("finally");
    expect(launcherCode()).toContain("exit 0");
  });

  test("reads stdin as bytes, never through a PowerShell string", () => {
    // Windows PowerShell 5.1 does not default to UTF-8 on its pipes. A string
    // round-trip mangles CJK and emoji, the guard then fails to parse the
    // JSON, and its never-print contract swallows the failure — which looks
    // exactly like "no review was needed". Asserted because this is the one
    // way this file can be subtly, silently wrong.
    expect(launcherCode()).toContain("OpenStandardInput");
    expect(launcherCode()).not.toMatch(/\$input\s*\|/);
    expect(launcherCode()).not.toContain("Out-String");
  });

  test("resolves bun through all three rungs, in the same order as Unix", () => {
    const code = launcherCode();
    const onPath = code.indexOf("Get-Command bun");
    const pointer = code.indexOf("bun-path");
    const fallback = code.indexOf(".bun\\bin\\bun.exe");
    for (const i of [onPath, pointer, fallback]) expect(i).toBeGreaterThan(-1);
    // Order matters: PATH is the only rung that keeps working if the user
    // moves bun, so it must be tried first (hooks/lib/resolve-bun.sh).
    expect(onPath).toBeLessThan(pointer);
    expect(pointer).toBeLessThan(fallback);
  });

  test("param() is the first executable statement, as PowerShell requires", () => {
    // A `param()` block preceded by any statement is a parse error, and the
    // failure mode of a launcher that cannot parse is silence — the same
    // silence as not being registered at all.
    const firstCode = launcherCode()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)[0];
    expect(firstCode).toBe("param(");
  });
});

// The fixes for the three Criticals the first review round found. Every one of
// them is failure HANDLING rather than product logic, which is why they live in
// the launcher at all — and why not one of them can be verified by running it.
describe("the launcher's failure handling", () => {
  test("the probe flag is a PowerShell switch, and the bundle's flag is forwarded", () => {
    const code = launcherCode();
    // `--self-test` as a bare argument can never bind: PowerShell 5.1 reads any
    // `-`-prefixed token on a `-File` command line as a parameter NAME, and a
    // name that matches nothing is a TERMINATING error — the script body never
    // runs, on a healthy machine. So doctor's probe reported "PowerShell could
    // not run the review hook" for every working Windows install.
    expect(code).toContain("[switch]$SelfTest");
    // The two flags are different on purpose and must stay that way: PowerShell
    // switch on the way in, Node-style argv on the way out to the guard.
    expect(code).toContain("--self-test");
    const paramBlock = code.slice(0, code.indexOf(")"));
    expect(paramBlock).not.toContain("--self-test");
  });

  test("the launcher answers for the guard when it cannot start the guard", () => {
    // `no-bun` and the guard's own reason vocabulary belong to the guard — but
    // the guard cannot be started WITHOUT bun. A silent exit on that path
    // reaches doctor as empty stdout and is read as "PowerShell refused to run
    // the launcher", sending a user with no bun to go fix an ExecutionPolicy.
    // That conflation is exactly what a real-machine test (S7) exists to catch.
    const code = launcherCode();
    expect(code).toContain("siltpoke-guard no-bun");
    expect(code).toContain("siltpoke-guard no-guard");
  });

  test("the guard's stdout leaves the launcher on the real hook path, its stderr never does", () => {
    // Defect [33], measured on the real Windows machine 2026-09-29 (install
    // audit §46.5): with no config.json the guard wrote `.nudged` and its nudge,
    // and the user saw nothing — the launcher forwarded stdout only under
    // -SelfTest and discarded stderr always. The nudge now travels on stdout as
    // `systemMessage` JSON, so the pass-through must NOT be gated on -SelfTest.
    // Source-text check because no PowerShell runs on the CI or dev machines;
    // the behaviour itself is owed to the next Windows run.
    const code = launcherCode();
    const passLine = code.split("\n").find((l) => l.includes("[Console]::Out.Write($out)"));
    expect(passLine).toBeDefined();
    expect(passLine!).not.toContain("SelfTest");
    // Positive control for the negative just above: the gated form exists
    // elsewhere in the file, so the matcher would have seen it had it been here.
    expect(code).toContain('if ($SelfTest) { [Console]::Out.Write("siltpoke-guard no-bun');
    // stderr is still read and dropped, never written anywhere.
    expect(code).toMatch(/\$stderrTask\.GetAwaiter\(\)\.GetResult\(\) \| Out-Null/);
  });

  test("both output pipes are drained asynchronously BEFORE stdin is written", () => {
    // The .NET process-I/O deadlock, and the reason it is asserted rather than
    // read: the first draft wrote the whole payload and only then called
    // ReadToEnd(). A child that writes more than a pipe buffer — a bun that
    // crashes on startup and prints a stack trace, a case this file's own
    // comments predicted — blocks on its write while the parent is still
    // blocked on its own. What hangs is the HOST'S Stop hook, inside the `try`,
    // so `finally { exit 0 }` is never reached either.
    const code = launcherCode();
    const stdoutRead = code.indexOf("StandardOutput.ReadToEndAsync");
    const stderrRead = code.indexOf("StandardError.ReadToEndAsync");
    const write = code.indexOf("StandardInput.BaseStream.Write");
    for (const i of [stdoutRead, stderrRead, write]) expect(i).toBeGreaterThan(-1);
    expect(stdoutRead).toBeLessThan(write);
    expect(stderrRead).toBeLessThan(write);
    // The synchronous form is the bug itself; it may not reappear anywhere.
    expect(code).not.toMatch(/ReadToEnd\(\)/);
  });

  test("the probe cannot hang forever; the real hook path is allowed to wait", () => {
    const code = launcherCode();
    // Bounded, and able to kill what it gave up on.
    expect(code).toMatch(/WaitForExit\(\d+\)/);
    expect(code).toContain("Kill()");
    // Unbounded on the hook path, matching hooks/stop.sh:104 — that call is
    // waiting on an actual review, and a timeout there would cut reviews short.
    expect(code).toContain("$proc.WaitForExit()");
  });
});

describe("hooks.json registers both commands, and only one of them can run", () => {
  // RE-REGISTERED 2026-09-26, after being withdrawn on 2026-09-25 (`[31]`).
  //
  // The withdrawal had three reasons. Two are gone:
  //
  //   1. "It delivers nothing" — `[26]` is now fixed for `claude` and
  //      `codebuddy`, so a Windows review can actually complete.
  //   2. "It is actively harmful" — `[27]`/`[28]` are fixed, so a failed
  //      review no longer consumes that commit's diff, and a deterministic
  //      failure now locks the breaker instead of retrying every five minutes.
  //
  // The third reason was the real one, and it is what the `; exit 0` suffix
  // answers: Claude Code runs a shell-form command through `sh -c` on macOS
  // and Linux, so `powershell …` exits 127 and the transcript shows
  // `Stop hook error: … /bin/sh: powershell: command not found` on EVERY
  // turn. Measured on the maintainer's own machine 2026-09-25.
  //
  // `; exit 0` makes the whole command exit 0 on a machine with no
  // `powershell`, and the docs say a hook exiting 0 sends its stderr to the
  // debug log only, never the transcript. Measured here that the exit code is
  // 0 (`sh -c 'powershell …; exit 0'` → `exit=0`, stderr carries the
  // command-not-found line). NOT measured: that the host then stays quiet —
  // that happens only inside a live session, where no test can look. It is
  // the one claim this change rests on that a test cannot make.
  //
  // Why not the POSIX guard the withdrawal considered: `command -v powershell
  // && …` is not valid PowerShell 5.1, and on Windows WITHOUT Git Bash the
  // shell IS PowerShell — it moves the noise instead of removing it. `; exit
  // 0` is valid in both dialects, which is the whole reason it is the suffix
  // and not a conditional. Docs: code.claude.com/docs/en/hooks.md.
  const manifest = JSON.parse(read("hooks/hooks.json")) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  };
  const allCommands = Object.values(manifest.hooks)
    .flatMap((g) => g[0]?.hooks ?? [])
    .map((h) => h.command);

  test("the scan sees the manifest at all — otherwise every check below is vacuous", () => {
    expect(allCommands.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.hooks).sort()).toEqual(["SessionStart", "Stop"]);
  });

  for (const [event, script, mode] of [
    ["Stop", "stop.sh", "stop"],
    ["SessionStart", "session-start.sh", "session-start"],
  ] as const) {
    const commands = manifest.hooks[event]?.[0]?.hooks.map((h) => h.command) ?? [];

    test(`${event} carries the Unix command and the Windows one, in that order`, () => {
      expect(commands).toHaveLength(2);
      expect(commands[0]).toBe(`sh "\${CLAUDE_PLUGIN_ROOT}/hooks/${script}"`);
      expect(commands[1]).toContain("siltpoke-hook.ps1");
      expect(commands[1]).toContain(` ${mode};`);
    });

    test(`${event}'s Windows command ends in "; exit 0" — the whole reason it may ship`, () => {
      // Without this suffix the command exits 127 wherever `powershell` is
      // absent, and every macOS and Linux user sees a hook error on every
      // turn. That is exactly why the entry was withdrawn once already.
      expect(commands[1]?.trimEnd()).toEndWith("; exit 0");
    });

    test(`${event}'s Windows command passes -NoProfile and -ExecutionPolicy Bypass`, () => {
      // A user profile that prints anything would reach the session through a
      // hook contracted to be silent; a restrictive ExecutionPolicy is the
      // default on Windows and would stop the script before its first line.
      expect(commands[1]).toContain("-NoProfile");
      expect(commands[1]).toContain("-ExecutionPolicy Bypass");
    });
  }

  test("no event registers more than the two commands", () => {
    // A third entry under any event, or a second matcher group, would fire an
    // extra review per turn. This reads the whole manifest rather than the two
    // events named above.
    for (const groups of Object.values(manifest.hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0]?.hooks.length).toBe(2);
    }
    expect(allCommands.filter((c) => c.includes("siltpoke-hook.ps1"))).toHaveLength(2);
  });

  test("the guard the launcher invokes is a declared build output", () => {
    // The launcher runs dist/siltpoke-hook-guard.js. If that is not in
    // BUNDLES, the file simply is not there in a plugin install and the hook
    // exits silently — the failure this whole track is about.
    expect(read("scripts/build-dist.ts")).toContain("dist/siltpoke-hook-guard.js");
  });
});

describe("the launcher stands down when the Unix entry already ran", () => {
  // Both commands are registered for both events, and on Windows WITH Git
  // Bash the host runs shell-form commands through Git Bash — so `sh
  // ".../stop.sh"` starts AND this launcher starts. One turn, two reviews,
  // racing on the same anchor. That race is defect `[27]`'s shape (an anchor
  // advanced by one path while another is still working), so the stand-down
  // is a correctness guard rather than tidiness.
  const ps1 = read("hooks/siltpoke-hook.ps1");

  test("it checks for `sh` on PATH", () => {
    // NOT asserted: that this matches the host's own Git-Bash detection. The
    // docs never say how that works, and the evidence is one machine where
    // `where.exe sh` found nothing and the `sh` entry had not run — a
    // correlation, not a mechanism. The `.ps1` comment says so, and this test
    // pins only the predicate that is actually in the file.
    expect(ps1).toContain("Get-Command sh -ErrorAction SilentlyContinue");
  });

  test("the comment does not claim the predicate is the host's own condition", () => {
    // The first draft wrote "the exact condition the host itself uses". It is
    // an inference from a single negative data point, and a future reader
    // acting on it as fact would narrow the wrong thing.
    expect(ps1).not.toContain("the exact condition the host");
    expect(ps1).toContain("INFERENCE, not a verified match");
  });

  test("the stand-down happens AFTER the stdin drain, never before", () => {
    // Leaving the payload unread can make the host block on its pipe write.
    // That contract has no exceptions, including for an early exit.
    const drain = ps1.indexOf("$payload = $buffer.ToArray()");
    const standDown = ps1.indexOf("Get-Command sh -ErrorAction SilentlyContinue");
    expect(drain).toBeGreaterThan(0);
    expect(standDown).toBeGreaterThan(drain);
  });

  test("-SelfTest is exempt, so doctor still gets a real answer", () => {
    // On a Git Bash machine the honest answer to "can the review hook start"
    // is still yes. Standing down under the probe would turn it into a silent
    // pass — the `[23]` failure this file's own doctor row exists to remove.
    const line = ps1
      .split("\n")
      .find((l) => l.includes("Get-Command sh -ErrorAction SilentlyContinue"));
    expect(line).toContain("-not $SelfTest");
  });

  test("the launcher and its guard are still shipped", () => {
    expect(ps1).toContain("siltpoke-guard");
  });
});
