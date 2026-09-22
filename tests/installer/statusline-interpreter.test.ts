// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_BASH_CANDIDATES,
  buildStatuslineCommand,
  localAppDataGitBash,
  splitInterpreter,
} from "../../src/installer/statusline-interpreter";

/** A `which` that finds nothing, for the "no bash anywhere" branch. */
const noWhich = () => null;
/** An `exists` that finds nothing. */
const noExists = () => false;

describe("buildStatuslineCommand — POSIX hosts", () => {
  test("darwin keeps the bare `sh` prefix the shim has always used", () => {
    const r = buildStatuslineCommand("/Users/x/.siltpoke/bin/statusline.sh", {
      platform: "darwin",
      which: (b) => (b === "sh" ? "/bin/sh" : null),
      exists: noExists,
    });
    expect(r.command).toBe("sh /Users/x/.siltpoke/bin/statusline.sh");
    expect(r.interpreter).toBe("sh");
    expect(r.resolved).toBe(true);
    expect(r.reason).toBeNull();
  });

  test("linux is the same path as darwin — no Windows special-casing leaks out", () => {
    const r = buildStatuslineCommand("/home/x/.siltpoke/bin/statusline.sh", {
      platform: "linux",
      which: (b) => (b === "sh" ? "/usr/bin/sh" : null),
      exists: noExists,
    });
    expect(r.command).toBe("sh /home/x/.siltpoke/bin/statusline.sh");
    expect(r.resolved).toBe(true);
  });

  test("a POSIX host with no `sh` on PATH still emits `sh`, but says it could not confirm it", () => {
    // Emitting nothing, or emitting some guess, would be worse than emitting the
    // thing that works on every real POSIX box. The miss is surfaced, not fixed.
    const r = buildStatuslineCommand("/home/x/.siltpoke/bin/statusline.sh", {
      platform: "linux",
      which: noWhich,
      exists: noExists,
    });
    expect(r.command).toBe("sh /home/x/.siltpoke/bin/statusline.sh");
    expect(r.resolved).toBe(false);
    expect(r.reason).toContain("sh");
  });
});

describe("buildStatuslineCommand — win32", () => {
  const shim = "C:\\Users\\x\\.siltpoke\\bin\\statusline.sh";

  test("bare `sh` is never emitted on win32 — that is defect [10]", () => {
    const r = buildStatuslineCommand(shim, {
      platform: "win32",
      which: noWhich,
      exists: noExists,
    });
    expect(r.command.startsWith("sh ")).toBe(false);
  });

  test("a Git Bash on PATH wins, and the shim path is handed over with forward slashes", () => {
    const r = buildStatuslineCommand(shim, {
      platform: "win32",
      which: (b) => (b === "bash" ? "C:\\Program Files\\Git\\bin\\bash.exe" : null),
      exists: noExists,
    });
    expect(r.command).toBe(
      '"C:/Program Files/Git/bin/bash.exe" C:/Users/x/.siltpoke/bin/statusline.sh',
    );
    expect(r.resolved).toBe(true);
    expect(r.reason).toBeNull();
  });

  test("WSL's System32 bash.exe is rejected — it cannot read a Windows path the shim needs", () => {
    // `where bash` on a stock Windows 10/11 finds C:\Windows\System32\bash.exe,
    // the WSL launcher. It runs a Linux shell whose filesystem root is NOT C:\,
    // so handing it C:/Users/... silently resolves to nothing.
    const r = buildStatuslineCommand(shim, {
      platform: "win32",
      which: (b) => (b === "bash" ? "C:\\Windows\\System32\\bash.exe" : null),
      exists: (p) => p === "C:\\Program Files\\Git\\bin\\bash.exe",
    });
    expect(r.command).toContain("Git/bin/bash.exe");
    expect(r.command).not.toContain("System32");
    expect(r.resolved).toBe(true);
  });

  test("no bash on PATH falls back to the first Git Bash that exists on disk", () => {
    const secondCandidate = GIT_BASH_CANDIDATES[1];
    expect(secondCandidate).toBeDefined();
    const r = buildStatuslineCommand(shim, {
      platform: "win32",
      which: noWhich,
      exists: (p) => p === secondCandidate,
    });
    expect(r.command).toContain(secondCandidate!.replace(/\\/g, "/"));
    expect(r.resolved).toBe(true);
  });

  test("no bash anywhere: emit the most likely Git Bash and say plainly it was not found", () => {
    const r = buildStatuslineCommand(shim, {
      platform: "win32",
      which: noWhich,
      exists: noExists,
    });
    expect(r.resolved).toBe(false);
    expect(r.reason).toContain("Git Bash");
    // Still a runnable-shaped command, so the user can see and fix the one path
    // rather than a statusline that fails with no clue what it wanted.
    expect(r.command).toContain("bash.exe");
  });

  test("an interpreter path without spaces is not quoted", () => {
    const r = buildStatuslineCommand(shim, {
      platform: "win32",
      which: (b) => (b === "bash" ? "C:\\tools\\git\\bin\\bash.exe" : null),
      exists: noExists,
    });
    expect(r.command).toBe(
      "C:/tools/git/bin/bash.exe C:/Users/x/.siltpoke/bin/statusline.sh",
    );
  });
});

describe("a home directory with a space in it", () => {
  // Review finding, 2026-09-20: the first cut of this fix quoted the interpreter
  // and not the script. Windows setup suggests the account's full name, so
  // `C:\\Users\\Dana Scott` is ordinary — and an unquoted script path is split
  // into two arguments, so bash is handed `C:/Users/Dana`, finds nothing, and
  // renders nothing. That is defect [10]'s exact symptom, reintroduced by its
  // own fix. These are the tests that were missing.
  test("win32 quotes the script half, not just the interpreter", () => {
    const r = buildStatuslineCommand(
      "C:\\Users\\Dana Scott\\.siltpoke\\bin\\statusline.sh",
      {
        platform: "win32",
        which: (b) => (b === "bash" ? "C:\\Program Files\\Git\\bin\\bash.exe" : null),
        exists: noExists,
        env: {},
      },
    );
    expect(r.command).toBe(
      '"C:/Program Files/Git/bin/bash.exe" "C:/Users/Dana Scott/.siltpoke/bin/statusline.sh"',
    );
  });

  test("POSIX quotes it too — the same split happens under sh", () => {
    const r = buildStatuslineCommand("/Users/Dana Scott/.siltpoke/bin/statusline.sh", {
      platform: "darwin",
      which: () => "/bin/sh",
      exists: noExists,
    });
    expect(r.command).toBe('sh "/Users/Dana Scott/.siltpoke/bin/statusline.sh"');
  });

  test("a space-free path is still unquoted — no churn for existing installs", () => {
    const r = buildStatuslineCommand("/Users/x/.siltpoke/bin/statusline.sh", {
      platform: "darwin",
      which: () => "/bin/sh",
      exists: noExists,
    });
    expect(r.command).toBe("sh /Users/x/.siltpoke/bin/statusline.sh");
  });
});

describe("per-user Git installs (%LOCALAPPDATA%)", () => {
  // The non-elevated Git-for-Windows installer does not land in Program Files.
  // The candidate list claimed to cover this population in a comment and did
  // not cover it in code (review finding, 2026-09-20).
  const shim = "C:\\Users\\x\\.siltpoke\\bin\\statusline.sh";
  const LOCALAPPDATA = "C:\\Users\\x\\AppData\\Local";
  const perUserBash = "C:\\Users\\x\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";

  test("localAppDataGitBash builds the per-user path, and tolerates a trailing slash", () => {
    expect(localAppDataGitBash({ LOCALAPPDATA })).toBe(perUserBash);
    expect(localAppDataGitBash({ LOCALAPPDATA: `${LOCALAPPDATA}\\` })).toBe(perUserBash);
  });

  test("no LOCALAPPDATA in the environment is not an error", () => {
    expect(localAppDataGitBash({})).toBeNull();
    expect(localAppDataGitBash({ LOCALAPPDATA: "   " })).toBeNull();
  });

  test("a per-user Git is found when nothing is on PATH and Program Files is empty", () => {
    const r = buildStatuslineCommand(shim, {
      platform: "win32",
      which: noWhich,
      exists: (p) => p === perUserBash,
      env: { LOCALAPPDATA },
    });
    expect(r.resolved).toBe(true);
    expect(r.command).toContain("C:/Users/x/AppData/Local/Programs/Git/bin/bash.exe");
  });

  test("a system-wide Git still wins over the per-user one", () => {
    const r = buildStatuslineCommand(shim, {
      platform: "win32",
      which: noWhich,
      exists: () => true, // both exist
      env: { LOCALAPPDATA },
    });
    expect(r.command).toContain("C:/Program Files/Git/bin/bash.exe");
  });
});

describe("paths a shell would otherwise interpret", () => {
  // Second review finding, 2026-09-20: the first cut of the quoting tested for
  // a space and nothing else. A `$` or a backtick in the path reached the shell
  // unquoted and got expanded — a wrong path, nothing rendered, no error. That
  // is the same failure class this whole module exists to fix, with a narrower
  // trigger. There was no test for any of it.
  const posix = (shim: string) =>
    buildStatuslineCommand(shim, {
      platform: "darwin",
      which: () => "/bin/sh",
      exists: noExists,
    }).command;

  test("a dollar sign is quoted AND escaped, so the shell cannot expand it", () => {
    expect(posix("/Users/$HOME/bin/statusline.sh")).toBe(
      'sh "/Users/\\$HOME/bin/statusline.sh"',
    );
  });

  test("a backtick cannot open a command substitution", () => {
    expect(posix("/Users/a`whoami`/bin/statusline.sh")).toBe(
      'sh "/Users/a\\`whoami\\`/bin/statusline.sh"',
    );
  });

  test("an embedded double quote is escaped, not left to close the wrapper early", () => {
    // The old code wrapped without escaping, so this produced a prematurely
    // closed quote and the shell died on an unexpected EOF.
    expect(posix('/Users/Jo"hn Doe/bin/statusline.sh')).toBe(
      'sh "/Users/Jo\\"hn Doe/bin/statusline.sh"',
    );
  });

  test("a backslash survives as a backslash", () => {
    expect(posix("/Users/back\\slash/bin/statusline.sh")).toBe(
      'sh "/Users/back\\\\slash/bin/statusline.sh"',
    );
  });

  test("an ordinary path is still handed over bare — no settings.json churn", () => {
    expect(posix("/Users/x/.siltpoke/bin/statusline.sh")).toBe(
      "sh /Users/x/.siltpoke/bin/statusline.sh",
    );
  });
});

describe("the emitted command actually runs (round trip through a real sh)", () => {
  // The assertions above are about a string. This one is about the thing the
  // string is for. Measured: against the previous quoting, 2 of these 6 ran;
  // against the current one, 6 of 6. A test that only compared strings would
  // have been written to match whatever the code produced.
  const NAMES = [
    "plain",
    "with space",
    "with$dollar",
    "with`backtick`",
    'with"quote and space',
    "with\\backslash",
  ];

  test("every path shape executes the shim", () => {
    const base = mkdtempSync(join(tmpdir(), "siltpoke-quote-"));
    try {
      for (const name of NAMES) {
        const dir = join(base, name);
        mkdirSync(dir, { recursive: true });
        const shim = join(dir, "statusline.sh");
        writeFileSync(shim, "#!/bin/sh\necho RAN_OK\n");
        chmodSync(shim, 0o755);

        const { command } = buildStatuslineCommand(shim, {
          platform: "darwin",
          which: () => "/bin/sh",
          exists: noExists,
        });
        const out = execSync(command, { encoding: "utf8", shell: "/bin/sh" }).trim();
        expect({ name, out }).toEqual({ name, out: "RAN_OK" });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("splitInterpreter — reading a statusLine command back", () => {
  test("a bare interpreter", () => {
    expect(splitInterpreter("sh /Users/x/.siltpoke/bin/statusline.sh")).toBe("sh");
  });

  test("a quoted interpreter keeps its spaces", () => {
    expect(
      splitInterpreter('"C:/Program Files/Git/bin/bash.exe" C:/x/statusline.sh'),
    ).toBe("C:/Program Files/Git/bin/bash.exe");
  });

  test("a single-quoted interpreter", () => {
    expect(splitInterpreter("'/opt/my shell/sh' /x/statusline.sh")).toBe(
      "/opt/my shell/sh",
    );
  });

  test("an empty command has no interpreter", () => {
    expect(splitInterpreter("   ")).toBeNull();
  });

  test("an unterminated quote is not an interpreter", () => {
    expect(splitInterpreter('"C:/Program Files/Git/bin/bash.exe')).toBeNull();
  });
});
