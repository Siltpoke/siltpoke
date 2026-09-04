// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Build stamp — the impure half: measuring which build this process is serving.
 *
 * The one rule this file exists to keep: every field is derived from the
 * FILE THIS PROCESS LOADED (`process.argv[1]`), never from the checkout's
 * current git state. `git rev-parse HEAD` answers "what is this directory on
 * now", which is a different question and diverges from "what is this process
 * running" in exactly the situation the reader is trying to diagnose. The
 * commit is therefore recovered from the bundle's CONTENT — its git blob oid,
 * looked up with `git log --find-object` — so a build can be identified even
 * when the checkout has since moved somewhere else entirely.
 *
 * Every git call is best-effort: any error degrades that one field to null.
 * Nothing here throws, and nothing substitutes a plausible value for a
 * measurement that failed.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BuildStamp } from "./format";

/** Injected edge so the capture logic is testable without a repo or a daemon. */
export interface BuildStampIo {
  /** Bytes of `path`, or null if it cannot be read. */
  readFile(path: string): Uint8Array | null;
  /** Nearest ancestor of `startDir` containing `.git` (file or dir), else null. */
  findRepoRoot(startDir: string): string | null;
  /** Trimmed stdout of `git <args>` run in `repoRoot`, or null on any error. */
  gitOut(repoRoot: string, args: string[]): string | null;
}

/**
 * git's object id for a blob: sha1 over the header `blob <byteLength>\0`
 * followed by the content. Computed from the bytes we already read rather than
 * shelling to `git hash-object`, so the oid always describes the exact bytes
 * this process loaded — including after the file on disk has been replaced.
 */
function gitBlobOid(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Nothing measured — the shape returned whenever there is no bundle to look at. */
function emptyStamp(bundlePath: string | null): BuildStamp {
  return {
    bundlePath,
    bootSha256: null,
    diskSha256: null,
    commit: null,
    commitTime: null,
    commitSubject: null,
    behindUpstream: null,
    upstreamRef: null,
  };
}

const UPSTREAM_REF = "origin/main";

/**
 * Resolve the commit that ships `blobOid` at `repoRelPath`.
 *
 * `--all` rather than the current branch: the whole point is to identify a
 * build whose commit may not be reachable from wherever the checkout sits now.
 * Most-recent-first, so a branch commit and the squash that landed it resolve
 * to the squash — the name the reader recognises.
 */
function lookupCommit(
  io: BuildStampIo,
  repoRoot: string,
  blobOid: string,
  repoRelPath: string,
): Pick<BuildStamp, "commit" | "commitTime" | "commitSubject"> {
  const out = io.gitOut(repoRoot, [
    "log",
    "--all",
    "-1",
    "--format=%H%x00%cI%x00%s",
    `--find-object=${blobOid}`,
    "--",
    repoRelPath,
  ]);
  const [commit, commitTime, commitSubject] = (out ?? "").split("\0");
  if (!commit) return { commit: null, commitTime: null, commitSubject: null };
  return {
    commit,
    commitTime: commitTime || null,
    commitSubject: commitSubject || null,
  };
}

/**
 * How many commits on `origin/main` this BUILD does not contain.
 *
 * Counted from the build's own commit, not from HEAD: the build is what is
 * being served, so it is the thing that can be behind. Null whenever the ref
 * is absent or the count does not parse — an unmeasured distance is not zero.
 *
 * Freshness caveat, stated because the number cannot show it: `origin/main`
 * is only as current as the last `git fetch`. This code deliberately does no
 * network I/O, so the count answers "behind the last-fetched main".
 */
function countBehind(
  io: BuildStampIo,
  repoRoot: string,
  commit: string,
): Pick<BuildStamp, "behindUpstream" | "upstreamRef"> {
  const refExists = io.gitOut(repoRoot, ["rev-parse", "--verify", "--quiet", UPSTREAM_REF]);
  if (!refExists) return { behindUpstream: null, upstreamRef: null };
  const out = io.gitOut(repoRoot, ["rev-list", "--count", `${commit}..${UPSTREAM_REF}`]);
  if (out === null) return { behindUpstream: null, upstreamRef: UPSTREAM_REF };
  const n = Number.parseInt(out, 10);
  if (!Number.isFinite(n)) return { behindUpstream: null, upstreamRef: UPSTREAM_REF };
  return { behindUpstream: n, upstreamRef: UPSTREAM_REF };
}

/**
 * Full measurement in one pass. `bootBytes`, when supplied, is the content the
 * process loaded — passing it is what lets a cached reader keep reporting the
 * build actually being served after the file on disk has been rebuilt.
 */
export function captureBuildStamp(
  argv1: string | undefined,
  io: BuildStampIo,
  bootBytes?: Uint8Array | null,
): BuildStamp {
  if (!argv1) return emptyStamp(null);
  const bundlePath = isAbsolute(argv1) ? argv1 : resolve(argv1);

  const diskBytes = io.readFile(bundlePath);
  // `undefined` means "not supplied, measure it now"; an explicit `null` means
  // "the boot read FAILED". `??` would collapse the two and silently adopt the
  // current disk content as the boot content — the process would then report
  // whatever is on disk as the code it is running, which is the exact
  // substitution this module exists to prevent.
  const boot = bootBytes === undefined ? diskBytes : bootBytes;
  if (!boot) return emptyStamp(bundlePath);

  const stamp = emptyStamp(bundlePath);
  stamp.bootSha256 = sha256(boot);
  stamp.diskSha256 = diskBytes ? sha256(diskBytes) : null;

  const repoRoot = io.findRepoRoot(dirname(bundlePath));
  if (!repoRoot) return stamp;

  const found = lookupCommit(io, repoRoot, gitBlobOid(boot), relative(repoRoot, bundlePath));
  stamp.commit = found.commit;
  stamp.commitTime = found.commitTime;
  stamp.commitSubject = found.commitSubject;
  if (!stamp.commit) return stamp;

  const behind = countBehind(io, repoRoot, stamp.commit);
  stamp.behindUpstream = behind.behindUpstream;
  stamp.upstreamRef = behind.upstreamRef;
  return stamp;
}

/**
 * Reader with the boot half frozen and the disk half live.
 *
 * The boot bytes are read once, on first call, and every later call re-derives
 * the disk hash while reporting the same build identity. That asymmetry IS the
 * layer-② signal: boot hash ≠ disk hash means the file changed under a process
 * that is still serving the old one.
 */
export function makeBuildStampReader(
  argv1: string | undefined,
  io: BuildStampIo,
): () => BuildStamp {
  let bootBytes: Uint8Array | null | undefined;
  return () => {
    if (bootBytes === undefined) bootBytes = argv1 ? io.readFile(resolve(argv1)) : null;
    return captureBuildStamp(argv1, io, bootBytes);
  };
}

// --- real io ---------------------------------------------------------------

export const realBuildStampIo: BuildStampIo = {
  readFile: (path) => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  },
  findRepoRoot: (startDir) => {
    let dir = startDir;
    for (;;) {
      if (existsSync(join(dir, ".git"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  },
  gitOut: (repoRoot, args) => {
    try {
      return execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  },
};

/**
 * Hold a stamp for `ttlMs` before re-measuring.
 *
 * Measured, not assumed: a full re-measure against the real 3.2 MB daemon
 * bundle costs ~67 ms (sha256 of the file plus three git calls). Every
 * dashboard page renders this line, so paying that per request would be the
 * most expensive thing on the page. A few seconds of staleness is invisible to
 * the reader — the thing being watched, a rebuild or a merge, is minutes-scale.
 */
export function withTtl(
  read: () => BuildStamp,
  ttlMs: number,
  now: () => number = Date.now,
): () => BuildStamp {
  let cached: BuildStamp | null = null;
  let takenAt = 0;
  return () => {
    const t = now();
    if (cached === null || t - takenAt >= ttlMs) {
      cached = read();
      takenAt = t;
    }
    return cached;
  };
}

/** Re-measure at most this often. See withTtl's note for why this is not zero. */
export const BUILD_STAMP_TTL_MS = 5_000;

let cachedReader: (() => BuildStamp) | null = null;

/**
 * Process-wide reader bound to this process's own entry file. The bundle is
 * hashed once at boot and the derivation is TTL-cached, so the dashboard's
 * per-page cost is a property read.
 */
export function readBuildStamp(): BuildStamp {
  if (!cachedReader) {
    cachedReader = withTtl(
      makeBuildStampReader(process.argv[1], realBuildStampIo),
      BUILD_STAMP_TTL_MS,
    );
  }
  return cachedReader();
}
