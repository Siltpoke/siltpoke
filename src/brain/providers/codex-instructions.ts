// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * How the review rubric reaches `codex exec` — argv, or a profile file on
 * Windows. The codex half of defect `[26]`.
 *
 * `codex exec` normally takes the rubric as `-c developer_instructions=<text>`,
 * i.e. several thousand characters of arbitrary text inside one argv entry. On
 * Windows that is the same shape that made every `claude` review fail: an npm
 * install resolves `codex` to `codex.cmd`, and the runtime refuses to hand a
 * `.bat`/`.cmd` any argument containing a cmd.exe special character
 * (CVE-2024-27980 hardening). A review rubric always contains one. A native
 * `codex.exe` install escapes that particular refusal, but not Windows' own
 * ~32,767-character command-line limit, which the same argv entry approaches.
 * Neither failure has been reproduced on the Windows box — what HAS been
 * measured there is the identical shape failing for `claude` (audit §36.3).
 *
 * THE WAY OUT, measured on this machine 2026-09-26 (`codex-cli 0.155.1`):
 * `codex exec --profile <name>` "layer[s] $CODEX_HOME/<name>.config.toml on top
 * of the base user config" (its own `--help`). So the rubric can travel as a
 * file and argv carries only a short, cmd-safe profile name.
 *
 * Evidence for that route, all at $0 because the codex quota was exhausted:
 *  - `developer_instructions` DOES become model-visible input:
 *    `codex debug prompt-input -c developer_instructions=<sentinel>` puts the
 *    sentinel at `[0].content[0].text`; the same command without the key does
 *    not (positive + negative control).
 *  - the profile FILE is read and validated: a deliberately bogus key in
 *    `$CODEX_HOME/<name>.config.toml` makes `codex exec --strict-config
 *    --profile <name>` fail naming OUR file's path and line, while
 *    `developer_instructions` in that same file passes validation and the run
 *    proceeds to the API.
 *  - NOT closed: `codex debug prompt-input` rejects `--profile`, so the final
 *    hop — the value loaded FROM the profile file reaching the model — is an
 *    inference from those two links (same config field, strict-validated), not
 *    a measurement. The live end-to-end check waits on quota.
 *
 * ONE MEASURED TRAP, which is why the file's existence is checked here: a
 * `--profile` naming a file that does NOT exist is **silently ignored** —
 * `codex exec --profile siltpoke-does-not-exist` ran on to the API without a
 * word. A failed write must therefore never leave us spawning codex with the
 * profile flag and no rubric: that would review the user's diff with no
 * instructions at all and report the result as a review.
 *
 * WHY WIN32-ONLY, the same asymmetric-risk call `system-prompt-file.ts`
 * documents: the argv form has worked in production on macOS/Linux for months,
 * and swapping it there spends a working path on a problem it does not have.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { nulSafe } from "../nul-safe";

export interface DeveloperInstructionsArgs {
  /** argv fragment to splice in where `-c developer_instructions=…` sat. */
  readonly args: readonly string[];
  /** Removes the profile file, if one was written. Safe to call repeatedly. */
  readonly cleanup: () => void;
  /**
   * The directory the profile file was written INTO, or undefined on the argv
   * path. The caller must put this on the child's `CODEX_HOME`, because
   * `--profile` is resolved against the CHILD's `$CODEX_HOME` and codex ignores
   * a profile file it cannot find WITHOUT SAYING SO. Writing to one directory
   * and letting the child read another is therefore not a "wrong path" bug that
   * shows up as an error — it is a review that runs with no rubric at all.
   */
  readonly codexHome?: string;
}

const NO_CLEANUP = (): void => {};

/**
 * Serialize a string as a TOML single-line basic string.
 *
 * Hand-rolled rather than pulled in as a dependency because only one direction
 * of one type is needed. The prompt is arbitrary text — it carries newlines,
 * quotes, backslashes and (from a diff) occasionally a stray control byte, so
 * every one of those has to survive, or the profile file is invalid TOML and
 * codex refuses the whole config.
 */
const TOML_SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

function tomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const short = TOML_SHORT_ESCAPES[ch];
    if (short !== undefined) {
      out += short;
      continue;
    }
    // TOML forbids raw control characters in a basic string, and the ones
    // without a short escape need `\uXXXX` — 4 hex digits, which every code
    // point in these ranges fits in.
    const code = ch.codePointAt(0)!;
    out +=
      code < 0x20 || code === 0x7f
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : ch;
  }
  return `${out}"`;
}

/**
 * `$CODEX_HOME`, else `~/.codex` — the directory `--profile` reads from.
 *
 * Resolved to an ABSOLUTE path, which is not cosmetic: a relative `CODEX_HOME`
 * would be resolved by US against the daemon's cwd and by the CHILD against the
 * reviewed repo's cwd (we pass `cwd` to spawn), so the two would name different
 * directories — and codex ignores a profile file it cannot find without saying
 * so. Absolute here, then pinned on the child's env, means there is only one
 * answer. Raised by a cross-check of this change.
 */
function codexHomeDir(override?: string): string {
  if (override !== undefined && override !== "") return resolve(override);
  const fromEnv = process.env.CODEX_HOME;
  if (fromEnv !== undefined && fromEnv !== "") return resolve(fromEnv);
  return join(homedir(), ".codex");
}

/** Profile files older than this are somebody's orphan, not a live review. */
const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000;
const PROFILE_PREFIX = "siltpoke-review-";

/**
 * Best-effort sweep of profile files an earlier run never got to delete.
 *
 * `cleanup` covers every in-process exit, but not the process being killed
 * between the write and the `finally` — and unlike the sibling path, which
 * stages under `mkdtempSync(tmpdir())` where the OS eventually sweeps,
 * `$CODEX_HOME` is a durable per-user config directory that nothing sweeps. One
 * killed daemon would otherwise leave one review rubric there permanently, and
 * the rubric can quote the user's own source.
 *
 * Only files this module names, only when they are old enough that no live
 * review could still be holding them, and every step swallowed — a failure to
 * tidy up must never fail a review.
 */
function sweepOrphanProfiles(home: string): void {
  try {
    const cutoff = Date.now() - ORPHAN_AGE_MS;
    for (const name of readdirSync(home)) {
      if (!name.startsWith(PROFILE_PREFIX) || !name.endsWith(".config.toml")) {
        continue;
      }
      const path = join(home, name);
      try {
        if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      } catch {
        // gone already, or not ours to read — either way, move on
      }
    }
  } catch {
    // no such directory yet, or unreadable — nothing to sweep
  }
}

/**
 * Build the argv fragment carrying the rubric, plus the file lifetime that may
 * come with it. The caller MUST run `cleanup` in a `finally`.
 *
 * The profile name is deliberately restricted to `siltpoke-review-<pid>-<uuid>`
 * — alphanumerics and dashes only. It is the one part of this that still rides
 * argv, so it must itself be free of the cmd.exe special characters this whole
 * function exists to keep out of argv. Per-call unique so two concurrent
 * reviews cannot read each other's rubric or delete it mid-call.
 */
export function developerInstructionsArgs(
  systemPrompt: string,
  opts: {
    /** Injected in tests; defaults to the real platform. */
    platform?: NodeJS.Platform;
    /** Injected in tests; defaults to $CODEX_HOME, else ~/.codex. */
    codexHome?: string;
  } = {},
): DeveloperInstructionsArgs {
  const platform = opts.platform ?? process.platform;
  // A NUL anywhere in the rubric makes the spawn itself impossible (nul-safe.ts).
  const prompt = nulSafe(systemPrompt);
  const inline = ["-c", `developer_instructions=${prompt}`] as const;
  if (platform !== "win32") return { args: inline, cleanup: NO_CLEANUP };

  const profile = `${PROFILE_PREFIX}${process.pid}-${randomUUID()}`;
  const home = codexHomeDir(opts.codexHome);
  const file = join(home, `${profile}.config.toml`);
  try {
    mkdirSync(home, { recursive: true });
    sweepOrphanProfiles(home);
    writeFileSync(
      file,
      `developer_instructions = ${tomlBasicString(prompt)}\n`,
      // `mode` buys nothing on the platform this branch actually runs on —
      // Windows honours at most the read-only bit and has no umask — so it is
      // here for the non-Windows callers a future change might add, not as the
      // protection. What keeps the rubric private today is that `$CODEX_HOME` is
      // already a per-user directory and the file is deleted when the call
      // returns. (The sibling path can do better: it owns a private mkdtemp
      // directory. `--profile` forces this directory, so that is not available.)
      { encoding: "utf8", mode: 0o600 },
    );
    // codex ignores a `--profile` whose file is absent, without a word. Check
    // here so a write that silently produced nothing can never become a review
    // run with no rubric.
    if (!existsSync(file)) throw new Error(`profile file not written: ${file}`);
    return {
      args: ["--profile", profile],
      codexHome: home,
      cleanup: () => {
        try {
          rmSync(file, { force: true });
        } catch {
          // A leftover profile file must never fail a review.
        }
      },
    };
  } catch (err) {
    try {
      rmSync(file, { force: true });
    } catch {
      // best-effort
    }
    // Falling back means falling back to the known-failing Windows path, and
    // the operator would see byte-for-byte the error defect `[26]` produces —
    // so the conclusion available to them would be "the fix did not ship"
    // rather than "the profile file could not be written". Say which.
    // (Same choice, same reason, as system-prompt-file.ts's last-resort path.)
    console.error(
      `[siltpoke] could not stage the review rubric in a codex profile file (${err}).` +
        " Falling back to passing it as an argument, which Windows may refuse" +
        " (defect [26]).",
    );
    return { args: inline, cleanup: NO_CLEANUP };
  }
}
