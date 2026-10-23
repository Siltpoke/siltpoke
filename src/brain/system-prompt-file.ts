// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * How the system prompt reaches a reviewer CLI — argv, or a file on Windows.
 *
 * Defect `[26]`, measured on a real Windows 10 machine 2026-09-24: npm's
 * `claude` on Windows IS `claude.cmd`, and the Node/Bun runtime refuses to hand
 * a `.bat`/`.cmd` any argument containing a cmd.exe special character
 * (CVE-2024-27980 hardening). The review prompt always contains one, so EVERY
 * review failed there, deterministically, with
 * `TypeError [ERR_INVALID_ARG_VALUE]` before the process ever started.
 *
 * WHY THE SWITCH IS PLATFORM-GATED, which is not the usual preference.
 * The risk is asymmetric, not the elegance:
 *   - On macOS/Linux the argv form has run in production for months and works.
 *     Changing it there is spending a working path on a problem it does not
 *     have.
 *   - On Windows, for the npm install — where `claude` resolves to `claude.cmd`
 *     — the argv form is a 100% failure. That is the install the defect was
 *     measured on, and the gate here is the OS rather than the resolved
 *     extension: a native `claude.exe` install would not have been refused, so
 *     for those users this trades a working path for a flag verified on one
 *     machine. Accepted knowingly, because the flag is the CLI's own documented
 *     interface and the alternative — resolving the binary to check its
 *     extension — costs a `where` spawn on every review. Narrow the gate if a
 *     `.exe` user ever reports a regression.
 * So the branch is the honest shape here, not laziness. Verified on Windows
 * 2026-09-25 for `claude`: the argv form reproduced the refusal and the file
 * form exited 0, in the same run (audit §39.1).
 *
 * NOT a general "write prompts to files" mechanism: the file is deleted as soon
 * as the call returns, and the caller must run `cleanup` in a `finally`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nulSafe } from "./nul-safe";

interface SystemPromptArgs {
  /** argv fragment to splice in where `--system-prompt <text>` used to sit. */
  readonly args: readonly string[];
  /** Removes the temp file, if one was written. Safe to call more than once. */
  readonly cleanup: () => void;
}

const NO_CLEANUP = (): void => {};

/**
 * The characters the runtime refuses to hand a `.bat`/`.cmd`.
 *
 * This exists because the REPLACEMENT can carry them too, which is the way the
 * first version of this fix was inert: `os.tmpdir()` honours `%TEMP%`/`%TMP%`,
 * and a Windows account name may legally contain `&`, `^`, `%`, `(`, `)`. A
 * path under `C:\Users\A&B\AppData\Local\Temp` is refused for exactly the
 * reason the prompt was. Measured with TMPDIR pointed at a directory named
 * `A&B^C%Z`: the produced argv was dirty and the fix did nothing, while looking
 * shipped.
 *
 * Deliberately wider than strictly necessary — a false positive costs one
 * fallback, a false negative costs the whole fix on that machine.
 */
const CMD_SPECIAL = /[\t\n\r "&()<>^|%]/;

/**
 * Temp bases to try, in order, skipping any whose own path is already refused.
 * `%SystemRoot%\Temp` is the escape hatch for an account name that cannot be
 * used: it is writable by normal users on a default Windows install, and its
 * path contains no special characters.
 */
export function cleanTempBases(): string[] {
  const systemRoot = process.env.SystemRoot;
  return [tmpdir(), ...(systemRoot === undefined ? [] : [join(systemRoot, "Temp")])].filter(
    (base) => !CMD_SPECIAL.test(base),
  );
}

/**
 * Build the argv fragment that carries the system prompt.
 *
 * `supportsFile` is the caller's explicit statement that its CLI accepts
 * `--system-prompt-file`. It is NOT inferred: `codebuddy` was confirmed by
 * reading its `--help` on this machine, while `qoder` is merely a sibling fork
 * and is left on the argv form until someone can check it. Guessing wrong there
 * turns a working reviewer into a broken one.
 */
export function systemPromptArgs(
  systemPrompt: string,
  opts: {
    supportsFile: boolean;
    /** Injected in tests; defaults to the real platform. */
    platform?: NodeJS.Platform;
  },
): SystemPromptArgs {
  const platform = opts.platform ?? process.platform;
  // A NUL anywhere in the prompt makes the spawn itself impossible (nul-safe.ts).
  const prompt = nulSafe(systemPrompt);
  const inline = ["--system-prompt", prompt] as const;
  if (platform !== "win32" || !opts.supportsFile) {
    return { args: inline, cleanup: NO_CLEANUP };
  }

  // A private directory rather than a bare temp file: the prompt can quote the
  // user's own source, and a predictable name in a shared temp dir is readable
  // by any other process on the box.
  for (const base of cleanTempBases()) {
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(base, "siltpoke-sp-"));
      const path = join(dir, "system-prompt.txt");
      writeFileSync(path, prompt, "utf8");
      const made = dir;
      return {
        args: ["--system-prompt-file", path],
        cleanup: () => {
          try {
            rmSync(made, { recursive: true, force: true });
          } catch {
            // A leftover temp file must never fail a review.
          }
        },
      };
    } catch {
      // mkdtemp may have succeeded before the write threw — do not leave the
      // directory behind on the way to the next base.
      if (dir !== undefined) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
  }

  // No usable base. Falling back to argv means, on Windows, falling back to the
  // known-failing path — and the operator would see byte-for-byte the error
  // defect `[26]` produces, so the conclusion available to them would be "the
  // fix did not ship" rather than "no temp directory was usable". Say which.
  // (`resolveReviewerCwd` two files over sets the precedent: warn loudly rather
  // than degrade silently.)
  console.error(
    "[siltpoke] could not stage the system prompt in a temp file — no writable temp" +
      " directory whose path is free of cmd.exe special characters. Falling back to" +
      " passing it as an argument, which Windows will refuse (defect [26]).",
  );
  return { args: inline, cleanup: NO_CLEANUP };
}
