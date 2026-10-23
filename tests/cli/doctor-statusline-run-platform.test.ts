// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[29]`, the other half — audit §36.5.
 *
 * `doctor-statusline-run-check.ts` hardcoded `/bin/sh` and a Unix-only
 * `SYSTEM_PATH`. On Windows there is no `/bin/sh`, so `Bun.spawnSync` threw
 * `ENOENT … uv_spawn '/bin/sh'` — a row that could never be right there, and
 * (before `runAllChecks` was guarded) a throw that killed the whole checklist.
 *
 * What is asserted here, and what is not: these drive the real check with
 * `platform` injected, so they measure the interpreter and PATH it BUILDS.
 * They claim nothing about a real Windows machine — nothing on macOS can.
 *
 * One of these tests was wrong on its first writing, and the way it was wrong
 * is worth keeping: injecting `platform: "win32"` alone does NOT simulate
 * Windows, because the resolver still asks the REAL `Bun.which("bash")`, which
 * on macOS answers `/bin/bash`. The spawn then succeeded and the test asserted
 * a failure that could not happen. `which`/`exists` have to be injected too.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkStatuslineRenders,
  statuslineRunInterpreter,
} from "../../src/cli/doctor-statusline-run-check";
import { statuslineShimPath } from "../../src/installer/shim";

/** A HOME with a statusline shim on disk, so the check gets past its guards. */
function homeWithShim(): { home: string; shim: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "doctor-home-"));
  const shim = statuslineShimPath(home);
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, "#!/bin/sh\nprintf 'pet'\n", "utf8");
  chmodSync(shim, 0o755);
  return { home, shim, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Records what the check would have spawned, without spawning anything. */
function recorder(out: string) {
  const calls: { shim: string; path: string; home: string }[] = [];
  return {
    calls,
    runShim: (shim: string, path: string, home: string) => {
      calls.push({ shim, path, home });
      return out;
    },
  };
}

/** A Windows with no bash anywhere — PATH lookup and disk both say no. */
const WINDOWS_WITHOUT_GIT_BASH = {
  platform: "win32" as const,
  env: { SystemRoot: "C:\\Windows" },
  which: () => null,
  exists: () => false,
};

describe("defect [29] — the interpreter is resolved, never hardcoded", () => {
  test("win32 picks a Windows shell, and it is never /bin/sh", () => {
    const got = statuslineRunInterpreter("C:/Users/x/.siltpoke/bin/statusline.sh", {
      ...WINDOWS_WITHOUT_GIT_BASH,
    });
    expect(got).not.toBe("/bin/sh");
    expect(got.toLowerCase()).toContain("bash.exe");
  });

  test("win32 prefers a bash that IS on PATH over the fallback location", () => {
    const got = statuslineRunInterpreter("C:/Users/x/.siltpoke/bin/statusline.sh", {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      which: () => "C:\\tools\\git\\bin\\bash.exe",
      exists: () => false,
    });
    expect(got).toBe("C:/tools/git/bin/bash.exe");
  });

  test("non-Windows still uses sh — the platform that was never broken", () => {
    expect(statuslineRunInterpreter("/home/x/.siltpoke/bin/statusline.sh", {
      platform: "linux",
      env: {},
    })).toBe("sh");
  });
});

describe("defect [29] — the sanitized-PATH arm is platform-aware", () => {
  // §110 W3 (Windows Run 4): Windows has no login/non-login split, so the
  // system-PATH arm stood in for nothing and warned while reviews fired.
  test("win32: one run, with the caller's own PATH — no system-PATH arm", () => {
    const h = homeWithShim();
    const rec = recorder("pet");
    try {
      checkStatuslineRenders(
        { home: h.home, claudeHome: h.home },
        {
          runShim: rec.runShim,
          platform: "win32",
          env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\system32" },
        },
      );
    } finally {
      h.cleanup();
    }
    expect(rec.calls.map((c) => c.path)).toEqual(["C:\\Windows\\system32"]);
  });

  test("non-Windows keeps the Unix system PATH exactly as before", () => {
    const h = homeWithShim();
    const rec = recorder("pet");
    try {
      checkStatuslineRenders(
        { home: h.home, claudeHome: h.home },
        { runShim: rec.runShim, platform: "darwin", env: { PATH: "/opt/homebrew/bin" } },
      );
    } finally {
      h.cleanup();
    }
    expect(rec.calls[1]?.path).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    // The first arm is the caller's own PATH — that is why there are two arms.
    expect(rec.calls[0]?.path).toBe("/opt/homebrew/bin");
  });
});

describe("defect [29] — a spawn that cannot start is a row, not a throw", () => {
  test("an interpreter that does not exist yields a failed row", () => {
    const h = homeWithShim();
    try {
      // No `runShim` stub: the REAL spawn runs, at an interpreter path that
      // does not exist on this machine. Before the fix this threw ENOENT out
      // of the check and, through `runAllChecks`, out of `/siltpoke:siltpoke-doctor`.
      const r = checkStatuslineRenders(
        { home: h.home, claudeHome: h.home },
        WINDOWS_WITHOUT_GIT_BASH,
      );
      expect(r.name).toBe("statusline renders (real run)");
      expect(r.pass).toBe(false);
      // Name the interpreter, so "no Git Bash" is distinguishable from
      // "bun missing" — two reds with completely different fixes.
      expect(r.detail).toContain("statusline.sh");
    } finally {
      h.cleanup();
    }
  });

  test("the shim still really runs on this platform (positive control)", () => {
    const h = homeWithShim();
    try {
      const r = checkStatuslineRenders({ home: h.home, claudeHome: h.home }, {});
      expect(r.pass).toBe(true);
      expect(r.status).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});
