// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

/**
 * Where setup records the absolute path of the bun binary.
 *
 * Defect [20] / [21]: bun's installer appends its PATH export to
 * ~/.bash_profile, which only a LOGIN shell reads. Claude Code runs the Stop
 * hook and the statusline in a non-login shell, so a bare `command -v bun`
 * found nothing there — the hook exited 0 in silence on every turn and review
 * never fired, while config.json, the pet and the statusline all still said
 * "installed". The user's own terminal ran bun fine, which is exactly why the
 * failure was invisible.
 *
 * Same pointer-file pattern as ~/.siltpoke/plugin-root (src/installer/shim.ts):
 * one small file, written by the one component that knows the answer, read by
 * every component that cannot work it out for itself.
 *
 * DELIBERATELY raw `home`, NOT siltpokeRoot(env) — and this deviates from the
 * convention the rest of the codebase follows, so read this before "fixing" it:
 *
 *   The READERS are shell. hooks/lib/resolve-bun.sh, the five hook guards
 *   (`SILTPOKE_DIR="${HOME}/.siltpoke"`) and both generated shims all resolve
 *   this file from raw $HOME and know nothing about SILTPOKE_HOME. Routing the
 *   WRITE through siltpokeRoot(env) would put the pointer somewhere no reader
 *   ever looks the moment SILTPOKE_HOME is set — i.e. it would turn a working
 *   path into a silent no-op, which is the exact bug class this file exists to
 *   close. The writer follows the readers here, not the convention.
 *
 *   Residual, stated rather than hidden: a fixture that relocates ~/.siltpoke
 *   with SILTPOKE_HOME while leaving HOME alone still gets its config.json in
 *   the scratch dir and this pointer in the developer's real ~/.siltpoke. The
 *   content is just the absolute path of the bun that is already running, so
 *   the write is idempotent and harmless — but it IS a write outside the
 *   scratch dir, and the honest fix is to teach the shell side about
 *   SILTPOKE_HOME, which is a change to every hook and out of scope here.
 *
 * tests/installer/bun-resolution-parity.test.ts writes the pointer through
 * recordBunPath() and then reads it with the real shell lib, so writer and
 * reader cannot drift apart without a test going red.
 */
export function bunPathPointerPath(home: string): string {
  return join(home, ".siltpoke", "bun-path");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record the running bun's absolute path. Returns the pointer file's path, or
 * null when the candidate isn't an executable file.
 *
 * `process.execPath` under bun IS the bun binary, so setup — itself a bun
 * program — never has to guess. Nothing is written when the candidate doesn't
 * resolve: a pointer naming a path that isn't there is WORSE than no pointer,
 * because every reader then pays a stat, fails, and falls through, while the
 * install looks configured.
 */
export function recordBunPath(home: string, candidate: string = process.execPath): string | null {
  if (!candidate || !isExecutable(candidate)) return null;
  const pointer = bunPathPointerPath(home);
  atomicWrite(pointer, `${candidate}\n`);
  return pointer;
}

interface ResolveBunDeps {
  /** PATH lookup seam. Returns null to model a shell whose PATH has no bun. */
  pathLookup?: () => string | null;
}

/**
 * Resolve bun the same way hooks/lib/resolve-bun.sh does: PATH first, then the
 * recorded pointer, then bun's default install location.
 *
 * This mirror exists so /siltpoke-doctor can answer "would the hook find bun?"
 * with the real answer rather than its own PATH — the doctor process is usually
 * started from an interactive shell, which is precisely the environment where
 * the bug is invisible.
 */
export function resolveBunPath(home: string, deps: ResolveBunDeps = {}): string | null {
  const lookup = deps.pathLookup ?? (() => Bun.which("bun"));
  const onPath = lookup();
  if (onPath && isExecutable(onPath)) return onPath;

  try {
    const recorded = readFileSync(bunPathPointerPath(home), "utf8").trim();
    if (recorded.length > 0 && isExecutable(recorded)) return recorded;
  } catch {
    // no pointer file — fall through to the default location
  }

  const fallback = join(home, ".bun", "bin", "bun");
  return isExecutable(fallback) ? fallback : null;
}

/**
 * The bun to bake into a command string written at install time.
 *
 * Defect [22] and its siblings: several installers wrote a literal `bun <path>`
 * into a host's hook config, a launchd unit or a skill's instructions. Every one
 * of those commands is later run by the HOST, in a non-login shell — the same
 * shell that could not find bun in defect [20]. A bare `bun` there is a hook
 * that reports `127 command not found`, or simply never runs.
 *
 * `process.execPath` is the honest answer: the code writing the command string
 * is itself running under bun, so the interpreter it wants is the one executing
 * it. No PATH lookup, no guessing, no dependence on the installer's own shell —
 * which is what `which bun` got wrong: launch setup by absolute path from a
 * shell with no bun on PATH and that lookup fails while bun is plainly running.
 */
export function bunForCommandString(): string {
  return process.execPath;
}
