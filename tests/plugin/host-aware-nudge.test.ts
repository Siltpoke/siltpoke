// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Regression guard for audit defect [8]: the only post-install guidance
// siltpoke gives is a once-ever stderr nudge. hooks/stop.sh's nudge told
// EVERY host to run `/siltpoke:siltpoke-setup`, but codex and agy have no such slash
// command — and hooks/codex-stop.sh / hooks/agy-stop.sh had NO nudge at all,
// so those hosts got total silence on a broken install.
//
// These hooks are POSIX sh, not TypeScript, so they're tested by EXECUTING
// them (Bun.spawnSync, plus Bun.spawn for the stdin-drain check), mirroring
// tests/plugin/hook-guard.test.ts's established harness rather than
// inventing a new one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();

// Prefer dash over the platform `sh` — see hook-guard.test.ts's identical
// rationale: macOS's /bin/sh (bash) is lenient about POSIX edge cases (e.g. a
// redirection failure on a special builtin) that dash treats as fatal.
const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "sh";

const CODEX_PAYLOAD = JSON.stringify({
  session_id: "codex-abc",
  transcript_path: "/tmp/codex-transcript.jsonl",
  cwd: "/tmp",
});
const CC_PAYLOAD = '{"session_id":"t"}';

type HookSpec = {
  label: string;
  script: string;
  payload: string;
  /** Substring the nudge text MUST contain. */
  mustContain: string;
  /** Substrings the nudge text MUST NOT contain (defect [8]'s core regression guard). */
  mustNotContain: string[];
  /** This host's own once-ever marker filename under ~/.siltpoke (per-host, not shared). */
  marker: string;
  /**
   * Where the nudge goes. stop.sh moved to stdout `systemMessage` JSON for
   * defect [33] — Claude Code never shows an exit-0 hook's stderr. codex and
   * agy were not re-measured in that fix, so they keep the channel they had.
   */
  channel: "stdout-system-message" | "stderr";
  extraEnv?: Record<string, string>;
};

const HOOKS: HookSpec[] = [
  {
    label: "stop.sh (CC-family: claude/qoder/codebuddy)",
    script: "stop.sh",
    marker: ".setup-nudged",
    channel: "stdout-system-message",
    payload: CC_PAYLOAD,
    mustContain: "/siltpoke:siltpoke-setup",
    mustNotContain: [],
    extraEnv: { CLAUDE_PLUGIN_ROOT: REPO },
  },
  {
    label: "codex-stop.sh",
    script: "codex-stop.sh",
    marker: ".codex-stop-nudged",
    channel: "stderr",
    payload: CODEX_PAYLOAD,
    mustContain: "/skills",
    mustNotContain: ["/siltpoke-"],
  },
  // agy-stop.sh is not here any more: agy shows nothing a Stop hook prints
  // (install audit §50), so its hint moved to the statusline. That behaviour,
  // its no-slash-command text and its stdin drain are pinned in
  // tests/hooks/agy-setup-hint.test.ts.
];

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-nudge-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runHook(spec: HookSpec) {
  return Bun.spawnSync([SHELL, join(REPO, "hooks", spec.script)], {
    env: { ...process.env, HOME: home, ...(spec.extraEnv ?? {}) },
    stdin: new TextEncoder().encode(spec.payload),
  });
}

type SpawnResult = ReturnType<typeof Bun.spawnSync>;

/**
 * The nudge text a hook emitted on ITS channel, "" when it said nothing there.
 * A stdout nudge must be exactly one line of `{"systemMessage": …}` JSON — a
 * bare string on stdout would reach no one, which is defect [33] again.
 */
function nudgeOf(spec: HookSpec, r: SpawnResult): string {
  const out = new TextDecoder().decode(r.stdout);
  const err = new TextDecoder().decode(r.stderr);
  if (spec.channel === "stderr") return err;
  if (out === "") return "";
  const parsed = JSON.parse(out) as { systemMessage?: unknown };
  expect(out.trim().split("\n")).toHaveLength(1);
  expect(typeof parsed.systemMessage).toBe("string");
  return parsed.systemMessage as string;
}

/** Silence means BOTH streams — a nudge that moved channels must not hide on the other one. */
function expectSilent(r: SpawnResult): void {
  expect(new TextDecoder().decode(r.stdout)).toBe("");
  expect(new TextDecoder().decode(r.stderr)).toBe("");
}

describe("host-aware install nudge (defect [8])", () => {
  for (const spec of HOOKS) {
    describe(spec.label, () => {
      test("no config.json: nudges ONCE with host-correct text, exit 0 both times", () => {
        // First run: the POSITIVE CONTROL for every "output is empty" assertion
        // below in this file — it proves runHook()/this harness actually
        // captures non-empty stderr when the mechanism fires, so a harness
        // that silently captured nothing could never read as green here.
        const first = runHook(spec);
        expect(first.exitCode).toBe(0);
        const firstNudge = nudgeOf(spec, first);
        expect(firstNudge.length).toBeGreaterThan(0);
        expect(firstNudge).toContain(spec.mustContain);
        for (const forbidden of spec.mustNotContain) {
          expect(firstNudge).not.toContain(forbidden);
        }
        expect(existsSync(join(home, ".siltpoke", spec.marker))).toBe(true);

        // Second run, same HOME: once-ever — must go silent.
        const second = runHook(spec);
        expect(second.exitCode).toBe(0);
        expectSilent(second);
      });

      test("~/.siltpoke permanently unwritable: silent on EVERY run, never a per-turn nag", () => {
        const siltpokeDir = join(home, ".siltpoke");
        mkdirSync(siltpokeDir, { recursive: true });
        chmodSync(siltpokeDir, 0o555);
        try {
          const first = runHook(spec);
          expect(first.exitCode).toBe(0);
          expectSilent(first);
          expect(existsSync(join(siltpokeDir, spec.marker))).toBe(false);

          const second = runHook(spec);
          expect(second.exitCode).toBe(0);
          expectSilent(second);
        } finally {
          chmodSync(siltpokeDir, 0o755);
        }
      });

      test("stdin is drained on the no-config fast-exit path (large write raises no EPIPE)", async () => {
        // Mechanism check, not a source-text proxy. No existing hook test
        // proves stdin-draining behaviorally (checked tests/hooks/*.test.ts
        // and tests/plugin/hook-guard.test.ts — none feed an oversized
        // payload), so this is new coverage, not a reused technique.
        //
        // First attempt was a Bun.spawnSync + timeout race on a big payload,
        // reasoning that an undrained pipe would make the parent's write
        // block forever. Driving it RED (deleting the `cat` line) proved that
        // reasoning wrong: these scripts exit near-instantly on every path
        // regardless of whether they read stdin, so the child's stdin fd
        // closes fast either way and the parent's write never blocks long
        // enough to trip a timeout — the timeout-based version stayed GREEN
        // on the broken script (a false negative).
        //
        // The real, confirmed discriminator: with an ASYNC piped write
        // (Bun.spawn, not spawnSync), writing a payload past the OS pipe
        // buffer to a process that closes its stdin fd WITHOUT reading it
        // raises "EPIPE: broken pipe" on the write call. Writing to a process
        // that DOES `cat` its stdin first raises nothing. Verified against
        // both arms on this exact hook before adopting it (mutation-tested
        // live during implementation, not just asserted here).
        const proc = Bun.spawn([SHELL, join(REPO, "hooks", spec.script)], {
          env: { ...process.env, HOME: home, ...(spec.extraEnv ?? {}) },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const bigPayload = new Uint8Array(4 * 1024 * 1024).fill(120); // 4MB of 'x', past any pipe buffer
        let writeErr: unknown = null;
        try {
          proc.stdin.write(bigPayload);
          await proc.stdin.end();
        } catch (e) {
          writeErr = e;
        }
        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
        expect(writeErr).toBeNull();
      });
    });
  }

  test("a nudge already seen on one host does NOT silence the others (per-host markers)", () => {
    // The shared-marker version of this feature reintroduced defect [9]'s
    // symptom: $HOME/.siltpoke is shared across every host on the machine, so
    // install in Claude Code -> see the nudge -> skip setup -> install in
    // codex/agy left those hosts SILENT on a broken install. Each hook owns
    // its own marker, so plant EVERY other host's marker up front and assert
    // this hook still speaks.
    for (const spec of HOOKS) {
      const scratchHome = mkdtempSync(join(tmpdir(), "siltpoke-nudge-crosshost-"));
      try {
        const siltpokeDir = join(scratchHome, ".siltpoke");
        mkdirSync(siltpokeDir, { recursive: true });
        // Every marker EXCEPT this hook's own.
        for (const other of HOOKS) {
          if (other.marker !== spec.marker) {
            writeFileSync(join(siltpokeDir, other.marker), "");
          }
        }
        const r = Bun.spawnSync([SHELL, join(REPO, "hooks", spec.script)], {
          env: { ...process.env, HOME: scratchHome, ...(spec.extraEnv ?? {}) },
          stdin: new TextEncoder().encode(spec.payload),
        });
        expect(r.exitCode).toBe(0);
        expect(nudgeOf(spec, r)).toContain(spec.mustContain);
        expect(existsSync(join(siltpokeDir, spec.marker))).toBe(true);
      } finally {
        rmSync(scratchHome, { recursive: true, force: true });
      }
    }
  });

  test("codex nudge text is free of the /siltpoke- slash-command family (the defect's exact regression; agy's is in agy-setup-hint.test.ts)", () => {
    // Isolated from the per-hook describe blocks above so this file has ONE
    // assertion whose sole job is exactly what the defect was: telling a
    // non-CC host to run a command it doesn't have. Each spec still gets its
    // OWN fresh HOME so this assertion cannot be made vacuous by ANY shared
    // state — markers are per-host now (see the cross-host test below, which
    // is what actually proves that), and a scratch HOME keeps this one
    // independent of that fact rather than relying on it.
    for (const spec of HOOKS.filter((h) => h.script !== "stop.sh")) {
      const scratchHome = mkdtempSync(join(tmpdir(), "siltpoke-nudge-invariant-"));
      try {
        const r = Bun.spawnSync([SHELL, join(REPO, "hooks", spec.script)], {
          env: { ...process.env, HOME: scratchHome, ...(spec.extraEnv ?? {}) },
          stdin: new TextEncoder().encode(spec.payload),
        });
        const stderr = new TextDecoder().decode(r.stderr);
        expect(stderr.length).toBeGreaterThan(0); // positive control, same test
        expect(stderr).not.toContain("/siltpoke-");
      } finally {
        rmSync(scratchHome, { recursive: true, force: true });
      }
    }
  });

  describe("codex-stop.sh's nudge survives the pre-existing SessionStart nudge (defect [8] follow-up, CRITICAL)", () => {
    // The Stop-hook nudge above ("codex-stop.sh") used to write the SAME
    // marker (`.codex-nudged`) as a DIFFERENT, pre-existing nudge —
    // `codexFirstRunNudge` in src/hooks/handle-session-start.ts, which fires
    // on SessionStart. SessionStart always runs before Stop in a real
    // session (hooks/hooks.json wires both), so the SessionStart nudge
    // consumed the marker first and codex-stop.sh's nudge never fired —
    // reinstating defect [8]'s exact "total silence" symptom for codex. Fix:
    // codex-stop.sh now owns its own marker, `.codex-stop-nudged`.
    //
    // This exercises the REAL SessionStart hook end-to-end (not a unit call
    // into codexFirstRunNudge), so it needs the real bundle — same
    // precondition tests/hooks/session-start-recursion-guard.test.ts and
    // tests/plugin/agy-skills-shipped.test.ts rely on already existing.
    const distEntry = join(REPO, "dist", "handle-session-start.js");
    if (!existsSync(distEntry)) {
      throw new Error(
        "dist/handle-session-start.js is missing — run `bun run build:dist` before this test file " +
          "(it exercises the real compiled SessionStart hook, not a source stub).",
      );
    }
    const codexSpec = HOOKS.find((h) => h.script === "codex-stop.sh");
    if (!codexSpec) throw new Error("codex-stop.sh spec missing from HOOKS");
    // Captured as a plain string (not left as `codexSpec.payload`) so
    // closures defined below don't re-trigger the possibly-undefined check —
    // TS narrowing on `codexSpec` from the throw-guard above doesn't persist
    // into a nested function body.
    const codexPayload = codexSpec.payload;
    const codexMustContain = codexSpec.mustContain;

    /** A throwaway git repo, so SessionStart's `git rev-parse HEAD` resolves
     * a real sha instead of degrading — mirrors session-start-recursion-guard
     * .test.ts's own `repo()` helper. Using a scratch repo (never this
     * actual siltpoke checkout) as cwd keeps SessionStart's
     * `{cwd}/.siltpoke/baseline.json` write out of the real working tree. */
    function scratchGitRepo(): string {
      const dir = mkdtempSync(join(tmpdir(), "siltpoke-nudge-cross-repo-"));
      spawnSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "a");
      spawnSync("git", ["add", "."], { cwd: dir });
      spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "init"], {
        cwd: dir,
      });
      return dir;
    }

    function runSessionStart(scratchHome: string, cwd: string, sessionId: string) {
      return Bun.spawnSync([SHELL, join(REPO, "hooks", "codex-session-start.sh")], {
        cwd,
        env: { ...process.env, HOME: scratchHome },
        stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd })),
      });
    }

    function runCodexStop(scratchHome: string) {
      return Bun.spawnSync([SHELL, join(REPO, "hooks", "codex-stop.sh")], {
        env: { ...process.env, HOME: scratchHome },
        stdin: new TextEncoder().encode(codexPayload),
      });
    }

    test("SessionStart first, then Stop: Stop still nudges (the real session order)", () => {
      const scratchHome = mkdtempSync(join(tmpdir(), "siltpoke-nudge-cross-a-"));
      const repoDir = scratchGitRepo();
      try {
        const sessionStart = runSessionStart(scratchHome, repoDir, "cross-a");
        expect(sessionStart.exitCode).toBe(0);
        expect(existsSync(join(scratchHome, ".siltpoke", ".codex-nudged"))).toBe(true);

        const stop = runCodexStop(scratchHome);
        expect(stop.exitCode).toBe(0);
        const stopErr = new TextDecoder().decode(stop.stderr);
        expect(stopErr).toContain(codexMustContain);
        expect(existsSync(join(scratchHome, ".siltpoke", ".codex-stop-nudged"))).toBe(true);
      } finally {
        rmSync(scratchHome, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });

    test("Stop first, then SessionStart: both still fire (independence isn't an ordering artifact)", () => {
      const scratchHome = mkdtempSync(join(tmpdir(), "siltpoke-nudge-cross-b-"));
      const repoDir = scratchGitRepo();
      try {
        const stop = runCodexStop(scratchHome);
        expect(stop.exitCode).toBe(0);
        const stopErr = new TextDecoder().decode(stop.stderr);
        expect(stopErr).toContain(codexMustContain);
        expect(existsSync(join(scratchHome, ".siltpoke", ".codex-stop-nudged"))).toBe(true);

        const sessionStart = runSessionStart(scratchHome, repoDir, "cross-b");
        expect(sessionStart.exitCode).toBe(0);
        expect(existsSync(join(scratchHome, ".siltpoke", ".codex-nudged"))).toBe(true);
      } finally {
        rmSync(scratchHome, { recursive: true, force: true });
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
