// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  // Pinned against the developer's own global config reshaping the fixture.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function realOf(p: string): string {
  const r = resolve(p);
  return existsSync(r) ? resolve(realpathSync(r)) : r;
}

function assertUnderTmp(fn: string, cwd: string): void {
  // BOTH spellings of the temp root, and BOTH spellings of the candidate.
  // On macOS `tmpdir()` is `/var/folders/…`, a symlink to `/private/var/…`, and
  // `realOf` can only resolve a path that already exists — so a fixture dir
  // that has not been created yet stays `/var/…` while the root resolves to
  // `/private/var/…` and a single-prefix check rejects every legitimate call.
  const roots = new Set([realOf(tmpdir()), resolve(tmpdir())]);
  const candidates = [realOf(cwd), resolve(cwd)];
  const ok = candidates.some((c) => [...roots].some((r) => c.startsWith(`${r}/`)));
  if (!ok) {
    throw new Error(
      `${fn} refused: ${cwd} is not under the OS temp dir. ` +
        `This helper runs 'git add -A && git commit'; pointing it at a real ` +
        `checkout commits the working tree. Use mkdtempSync().`,
    );
  }
}

/** The repo root git would use from `cwd`, or undefined when there is none. */
function repoRootOf(cwd: string): string | undefined {
  if (!existsSync(cwd)) return undefined;
  const probe = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
  });
  if (probe.exitCode !== 0) return undefined;
  const out = new TextDecoder().decode(probe.stdout).trim();
  return out.length > 0 ? realOf(out) : undefined;
}

/**
 * Refuse to initialise a repo anywhere that is not a throwaway directory.
 *
 * ⚠️ THIS GUARD EXISTS BECAUSE THE UNGUARDED VERSION DID THE DAMAGE, 2026-08-26.
 * `tests/hooks/handle-stop.test.ts` passes `process.cwd()` as one test's cwd, so
 * `makeGitRepo` ran `git add -A && git commit` inside the REAL worktree and
 * committed the entire in-progress branch under the message "fixture base". It
 * was caught only because `git status` afterwards showed no `src/` changes — the
 * commit had swallowed them. Nothing about "it only ever gets temp dirs" was
 * true, and no amount of care in the callers can make it true, so the check
 * lives here where it cannot be forgotten.
 */
function assertSafeToInit(cwd: string): void {
  assertUnderTmp("makeGitRepo", cwd);
  if (repoRootOf(cwd) !== undefined) {
    throw new Error(
      `makeGitRepo refused: ${cwd} is already inside a git repository. ` +
        `Committing there would commit somebody's real work.`,
    );
  }
}

/**
 * Refuse to commit unless `cwd` is a throwaway repo's OWN root.
 *
 * Being "inside a repo" is normal here — the fixture just created one. What
 * must never happen is committing into an ENCLOSING repo, which is what a
 * fixture path nested in a checkout would do.
 */
function assertSafeToCommit(cwd: string): void {
  assertUnderTmp("commitAll", cwd);
  const root = repoRootOf(cwd);
  if (root === undefined) {
    throw new Error(`commitAll refused: ${cwd} is not a git repository.`);
  }
  if (root !== realOf(cwd)) {
    throw new Error(
      `commitAll refused: ${cwd} sits inside the repo at ${root}, not at its root. ` +
        `Committing would commit that repo's tree.`,
    );
  }
}

function run(cwd: string, args: string[]): void {
  // `-c core.excludesFile=/dev/null` for the same reason `git-facts.test.ts`
  // carries it: `GIT_CONFIG_GLOBAL=/dev/null` silences global CONFIG, but git's
  // default excludes file (`$XDG_CONFIG_HOME/git/ignore`) is read regardless.
  // This helper runs `git add -A`, so whatever the developer's machine happens
  // to ignore silently changes what a fixture commits — which produced three
  // tests that were green here and red on CI. Not a live bug in these fixtures
  // today; carried so it cannot become one.
  Bun.spawnSync(["git", "-c", "core.excludesFile=/dev/null", ...args], {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
  });
}

/**
 * Make `cwd` a real git repo with one commit.
 *
 * Needed since the ⏱ review-unit gate (spec D1 / AC14): the Stop hook now asks
 * git "has a unit of work closed", and a directory git knows nothing about is
 * answered with `not_a_git_repo` — correctly, and before any Brain call. A
 * fixture that is a bare temp dir therefore exercises the skip path no matter
 * what the rest of the test is about.
 *
 * This is NOT a bypass: a real user's cwd IS a git repo, so this makes the
 * fixture match how the gate is actually met rather than routing around it.
 * With no anchor yet the gate fires with NO range (`anchor_unusable`), which is
 * exactly the pre-axis working-tree behaviour these tests were written against.
 *
 * ⚠️ ORDER MATTERS, and it is not obvious. Creating `.git` changes what
 * siltpoke resolves as the PROJECT ROOT for that directory, which is the key
 * per-repo memory is stored under. A test that seeds memory against the
 * pre-`.git` root and only then makes the directory a repo writes to one key
 * and reads from another — it presents as `rules_in_store: 0`, which looks
 * like a memory bug rather than a fixture one. Call this BEFORE anything that
 * resolves a project root.
 */
export function makeGitRepo(cwd: string): void {
  // Idempotent: several fixtures call this once when the directory is created
  // and again from their event factory. Re-initialising would be harmless, but
  // this also makes the ORDER safe to reason about — see the note below about
  // calling it before anything that resolves a project root.
  if (existsSync(join(cwd, ".git"))) return;
  assertSafeToInit(cwd);
  mkdirSync(cwd, { recursive: true });
  run(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(join(cwd, ".gitkeep"), "");
  run(cwd, ["add", "-A"]);
  run(cwd, ["commit", "-q", "-m", "fixture base"]);
}

/**
 * Commit whatever is in the working tree, so HEAD moves with a new tree.
 * Use when a test needs the gate to fire on a REAL unit (`new_commit`, with a
 * range) rather than on the first-contact path.
 */
export function commitAll(cwd: string, message: string): void {
  // Same class of refusal as makeGitRepo, for the same reason — this one also
  // runs `git add -A`, and makeGitRepo's early return on an existing `.git`
  // means a caller can reach here without having passed that check.
  assertSafeToCommit(cwd);
  run(cwd, ["add", "-A"]);
  run(cwd, ["commit", "-q", "-m", message]);
}

export function headSha(cwd: string): string {
  const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
  });
  return new TextDecoder().decode(r.stdout).trim();
}
