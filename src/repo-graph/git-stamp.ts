/**
 * Git facts for the Code Map export stamp (spec §4). argv arrays only, 2 s
 * timeout; any failure reads as "no git". Never infers a commit from a time.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type HeadRelation =
  | "same" | "ahead" | "behind" | "diverged" | "history-unavailable" | "not-recorded" | "no-git";
export interface Relation { relation: HeadRelation; count: number | null }

function git(root: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return { ok: true, out: out.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

const SHA_RE = /^[0-9a-f]{40}$/;

/** True for a well-formed 40-hex commit SHA. Used to validate a commit value
 * READ FROM A PERSISTED CACHE (`RepoGraphMeta.head_commit` / `ArchModelMeta.headCommit`)
 * before it is ever passed to a `git` subprocess — a hand-edited or corrupt
 * cache entry must degrade to "not-recorded", never reach `git cat-file`/`merge-base`
 * with an arbitrary string. */
export function isValidSha(s: string | undefined | null): s is string {
  return typeof s === "string" && SHA_RE.test(s);
}

/**
 * The project-relative paths git would show under `root` — tracked files plus
 * untracked files no ignore rule covers. Code Map's other-file list is
 * filtered by it so `__pycache__/`, build output and an ignored `.env` are
 * never drawn, not even by name.
 *   - a Set: inside git, listed;
 *   - "no-git": not a work tree — there are no ignore rules to apply;
 *   - "failed": inside git but the listing failed — callers must fail CLOSED
 *     (list nothing), since unfiltered would name ignored files.
 */
export function gitVisibleFiles(root: string): Set<string> | "no-git" | "failed" {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  // The probe can fail inside a real repo too (timeout under load, dubious
  // ownership, a corrupt HEAD). Only a folder with no `.git` at or above it
  // is "no-git"; anything else that is not a clean "true" is "failed".
  if (!inside.ok || inside.out !== "true") return hasDotGitAtOrAbove(root) ? "failed" : "no-git";
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return "failed";
  }
}

function hasDotGitAtOrAbove(root: string): boolean {
  let dir = resolve(root);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function headCommit(root: string): string | null {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok && SHA_RE.test(r.out) ? r.out : null;
}

/** `{ headCommit }` when `root` is set and resolves in a git repo, else `{}` —
 * spreads directly into a meta literal so a missing/failed lookup never writes
 * `headCommit: undefined` to disk (callers that need a snake_case key spread
 * `headCommit(root) ?? undefined` themselves instead). */
export function headCommitField(root: string | undefined): { headCommit: string } | Record<string, never> {
  if (!root) return {};
  const h = headCommit(root);
  return h ? { headCommit: h } : {};
}

function count(root: string, range: string): number | null {
  const r = git(root, ["rev-list", "--count", range]);
  const n = Number.parseInt(r.out, 10);
  return r.ok && Number.isFinite(n) ? n : null;
}

export function relationTo(root: string, commit: string | null): Relation {
  const head = headCommit(root);
  if (head === null) return { relation: "no-git", count: null };
  if (commit === null) return { relation: "not-recorded", count: null };
  if (!git(root, ["cat-file", "-e", `${commit}^{commit}`]).ok) return { relation: "history-unavailable", count: null };
  if (git(root, ["merge-base", "--is-ancestor", commit, "HEAD"]).ok) {
    const n = count(root, `${commit}..HEAD`);
    return { relation: n === 0 ? "same" : "ahead", count: n };
  }
  if (git(root, ["merge-base", "--is-ancestor", "HEAD", commit]).ok) {
    return { relation: "behind", count: count(root, `HEAD..${commit}`) };
  }
  return { relation: "diverged", count: null };
}

export function lastCommitForFile(root: string, relPath: string): { commit: string; date: string } | null {
  const r = git(root, ["log", "-1", "--follow", "--format=%H%x09%cI", "--", relPath]);
  if (!r.ok || !r.out) return null;
  const [commit, date] = r.out.split("\t");
  return commit && date ? { commit, date } : null;
}

const day = (iso: string) => iso.slice(0, 10);
const short = (c: string) => c.slice(0, 7);

export function stampText(mapDate: string, commit: string | null, rel: Relation): string {
  const head = `Map from ${day(mapDate)}`;
  switch (rel.relation) {
    case "no-git": return `${head} · not a git repository`;
    case "not-recorded": return `${head} · commit not recorded — regenerate to record it`;
    case "same": return `${head} · commit ${short(commit ?? "")} · up to date`;
    case "ahead": return `${head} · commit ${short(commit ?? "")} · ${rel.count} commits behind HEAD`;
    case "behind": return `${head} · commit ${short(commit ?? "")} · ${rel.count} commits newer than this checkout`;
    case "diverged": return `${head} · commit ${short(commit ?? "")} · built on a different branch`;
    case "history-unavailable": return `${head} · commit ${short(commit ?? "")} · history not available here`;
  }
}

export function isFarBehind(rel: Relation): boolean {
  return (rel.relation === "ahead" && (rel.count ?? 0) > 100) || rel.relation === "diverged";
}

/** Guard against a `Relation` that claims `ahead`/`behind` but carries no
 * count (a `git rev-list --count` failure after the ancestor check already
 * succeeded — rare, but `stampText` must never print "null commits"; downgrade
 * to `history-unavailable`, which has its own count-free wording). */
export function safeRelation(rel: Relation): Relation {
  if ((rel.relation === "ahead" || rel.relation === "behind") && rel.count === null) {
    return { relation: "history-unavailable", count: null };
  }
  return rel;
}

/** Stamp text for an AUTHORED map whose `.siltpoke/arch-c4.json` has never
 * been committed (relation forced to `not-recorded`). The generic
 * `not-recorded` wording says "regenerate", which is meaningless for a
 * hand-authored file — the fix is to commit it. */
export function authoredUncommittedText(mapDate: string): string {
  return `Map from ${day(mapDate)} · file not committed — commit it to record its version`;
}
