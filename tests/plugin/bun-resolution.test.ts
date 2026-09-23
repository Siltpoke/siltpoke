// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [20] / [21]: the Stop hook resolved bun with a bare `command -v bun`,
// so a user whose bun PATH lives only in ~/.bash_profile got a hook that exits
// 0 in silence on every turn — review never fires, while config.json and the
// pet both exist and the install looks healthy. Claude Code runs hooks in a
// NON-LOGIN shell, which never reads ~/.bash_profile.
//
// Measured 2026-09-22 (the field report's own control) and reproduced here:
// with config.json present, the ONLY difference between "review runs" and
// "review never runs" is whether bun is on PATH.
//
// So PATH cannot be the only answer. The hook must also accept the absolute
// path setup recorded (~/.siltpoke/bun-path, the same pointer-file pattern as
// ~/.siltpoke/plugin-root) and the installer's default location.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = process.cwd();
const REAL_BUN = process.execPath;

// dash, not macOS's lenient bash-as-sh — see tests/plugin/hook-guard.test.ts.
const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "sh";

// A PATH with the usual system bins and deliberately NO bun: this is the shape
// of the shell Claude Code hands its hooks on the reporter's machine.
const PATH_WITHOUT_BUN = "/usr/bin:/bin:/usr/sbin:/sbin";

let home: string;

function runStopHook(env: Record<string, string> = {}) {
  return Bun.spawnSync([SHELL, join(REPO, "hooks", "stop.sh")], {
    env: {
      HOME: home,
      PATH: PATH_WITHOUT_BUN,
      CLAUDE_PLUGIN_ROOT: REPO,
      ...env,
    },
    stdin: new TextEncoder().encode(
      JSON.stringify({ session_id: "bun-resolution", transcript_path: "/dev/null", cwd: REPO }),
    ),
  });
}

/**
 * Did the bundle actually run? `exit 0` proves nothing — the guard exits 0 on
 * every path by design, so the exit code is identical whether review fired or
 * was skipped in silence. The honest signal is the bundle's own side effect on
 * disk: nothing but the guard's early-exit paths leaves ~/.siltpoke untouched.
 */
function bundleRan(): boolean {
  return existsSync(join(home, ".siltpoke", "usage.json"));
}

function stderrOf(r: { stderr: Uint8Array }): string {
  return new TextDecoder().decode(r.stderr);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-bun-"));
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  // The install is COMPLETE: setup ran, the pet exists. That is the whole point
  // of [20] — every visible sign says "installed", and review still never runs.
  writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("stop.sh bun resolution", () => {
  // Positive control FIRST: proves bundleRan() can fire at all, so a red in the
  // three tests below is about bun resolution and not about a probe that never
  // returns true for anything.
  test("control — bun on PATH → the bundle runs", () => {
    const r = runStopHook({ PATH: `${dirname(REAL_BUN)}:${PATH_WITHOUT_BUN}` });
    expect(r.exitCode).toBe(0);
    expect(bundleRan()).toBe(true);
  });

  test("bun absent from PATH but recorded in ~/.siltpoke/bun-path → the bundle runs", () => {
    writeFileSync(join(home, ".siltpoke", "bun-path"), `${REAL_BUN}\n`);
    const r = runStopHook();
    expect(r.exitCode).toBe(0);
    expect(bundleRan()).toBe(true);
  });

  test("no pointer either, but bun sits in its default ~/.bun/bin → the bundle runs", () => {
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    symlinkSync(REAL_BUN, join(home, ".bun", "bin", "bun"));
    const r = runStopHook();
    expect(r.exitCode).toBe(0);
    expect(bundleRan()).toBe(true);
  });

  // Raised in review: `.` (dot/source) is a POSIX SPECIAL BUILTIN, so under
  // dash a failure to OPEN the sourced file kills the whole script — with an
  // error line, in the user's session. Existence (`-f`) is not readability.
  //
  // Measured with the guard reverted to `-f`: exit 2 and
  // `.: cannot open hooks/lib/resolve-bun.sh: Permission denied` on stderr.
  // Runs against a COPY in a temp plugin root — never chmod the repo's own file.
  test("the resolve lib exists but cannot be read → falls through in silence, no crash", () => {
    const root = mkdtempSync(join(tmpdir(), "siltpoke-unreadable-"));
    try {
      mkdirSync(join(root, "hooks", "lib"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "siltpoke-stop.js"), "process.stdout.write('RAN');");
      copyFileSync(join(REPO, "hooks", "stop.sh"), join(root, "hooks", "stop.sh"));
      const lib = join(root, "hooks", "lib", "resolve-bun.sh");
      copyFileSync(join(REPO, "hooks", "lib", "resolve-bun.sh"), lib);
      chmodSync(lib, 0o000);

      const r = Bun.spawnSync([SHELL, join(root, "hooks", "stop.sh")], {
        // bun IS on PATH here: the point is that an unreadable lib must not stop
        // the guard from getting to the PATH fallback and running the bundle.
        env: { HOME: home, PATH: `${dirname(REAL_BUN)}:${PATH_WITHOUT_BUN}`, CLAUDE_PLUGIN_ROOT: root },
        stdin: new TextEncoder().encode('{"session_id":"unreadable"}'),
      });
      expect(r.exitCode).toBe(0);
      expect(stderrOf(r)).toBe("");
      expect(new TextDecoder().decode(r.stdout)).toBe("RAN");
    } finally {
      chmodSync(join(root, "hooks", "lib", "resolve-bun.sh"), 0o644);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bun genuinely unreachable → still silent, and does NOT advise running setup", () => {
    const r = runStopHook();
    expect(r.exitCode).toBe(0);
    expect(bundleRan()).toBe(false);
    // The session stays clean — that rule is not being traded away here; the
    // noisy surfaces are /siltpoke-doctor and the statusline.
    //
    // But the advice that DID print was wrong: config.json exists, so setup has
    // already run, and re-running it cannot put bun on a non-login shell's PATH.
    expect(stderrOf(r)).not.toContain("/siltpoke-setup");
  });
});
