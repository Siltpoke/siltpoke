// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The real (node:fs-backed) `CaptureDeps` for `captureCase1Pre`/`finalizeCase1`
// (src/memory/case1-capture.ts). Kept in its own module so the pure record/
// gate logic in case1-capture.ts stays fs-free and unit-testable with fakes;
// this file is the one production call sites (handle-stop.ts, distil-worker.ts)
// import — built once at module load, not per-call.
import { open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite } from "../utils/atomic-write";
import { lineContentFingerprint } from "./line-fingerprint";
import type { CaptureDeps, CritiqueAnchor, FinalizeDeps, GcDeps } from "./case1-capture";

const execFileAsync = promisify(execFile);

const CHUNK_SIZE = 64 * 1024;

/**
 * Chunked, byte-capped file read via `node:fs/promises` `open`. Never throws —
 * any failure (missing file, permission, not-a-file) returns `null` so the
 * caller (captureCase1Pre) treats it as "skip this file", not fatal.
 *
 * `truncated: true` when the file has MORE content beyond `byteCap` (probed
 * with one extra read past the cap, not by reading the whole file first).
 */
export async function readFileCapped(
  absPath: string,
  byteCap: number,
): Promise<{ content: string; truncated: boolean } | null> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await open(absPath, "r");
    const stat = await handle.stat();
    if (!stat.isFile()) return null;

    const chunks: Buffer[] = [];
    let totalRead = 0;
    while (totalRead < byteCap) {
      const toRead = Math.min(CHUNK_SIZE, byteCap - totalRead);
      const buf = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (bytesRead === 0) break; // EOF
      chunks.push(bytesRead === toRead ? buf : buf.subarray(0, bytesRead));
      totalRead += bytesRead;
      if (bytesRead < toRead) break; // short read = EOF
    }

    // Probe one more byte past the cap to detect truncation without reading
    // the rest of a potentially huge file.
    let truncated = false;
    if (totalRead >= byteCap) {
      const probe = Buffer.alloc(1);
      const { bytesRead } = await handle.read(probe, 0, 1, null);
      truncated = bytesRead > 0;
    }

    const content = Buffer.concat(chunks).toString("utf8");
    return { content, truncated };
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      // best-effort close; never let a close failure surface
    }
  }
}

/**
 * `fingerprintsFor` — the FLAGGED lines' content hashes for `relPath`, per
 * spec §5 ("the per-file flagged-line content hashes ... kept even when
 * `content` is truncated, so a later step can still verify a line's
 * presence/absence on a truncated file").
 *
 * Prefers each anchor's `fingerprint`, computed at critique-creation from the
 * FULL file — that is what survives truncation, since a line past the byte cap
 * is absent from `content` entirely. Falls back to hashing the captured content
 * at the anchor's `line` when no fingerprint was supplied. An anchor with
 * neither yields nothing: this deliberately does NOT fall back to the
 * whole-file set, which is what it used to return and which cannot answer
 * "did THIS line disappear" (and is recomputable from the stored content
 * anyway, so nothing is lost by dropping it).
 */
export function fingerprintsFor(
  relPath: string,
  content: string,
  anchors: CritiqueAnchor[],
): string[] {
  const out = new Set<string>();
  for (const a of anchors ?? []) {
    if (a?.file !== relPath) continue;
    const fp = a.fingerprint && a.fingerprint.length > 0
      ? a.fingerprint
      : (typeof a.line === "number" ? lineContentFingerprint(content, a.line) : "");
    if (fp.length > 0) out.add(fp);
  }
  return Array.from(out);
}

async function writeAtomicAsync(path: string, data: string): Promise<void> {
  atomicWrite(path, data);
}

/**
 * Wall-clock budget for the WHOLE capture (spec §4.1's "strict budgets ...
 * this is a hot Stop-hook path"). `captureCase1Pre` treats this as a
 * RELATIVE ms budget, not an absolute epoch timestamp: it captures its own
 * `startTime = deps.now().getTime()` once before the read loop, then before
 * starting each new file read computes `elapsed = deps.now().getTime() -
 * startTime` and stops STARTING further reads once `elapsed >= deadlineMs`
 * (case1-capture.ts:238-244) — it never tries to cancel an in-flight read.
 * 500ms is a conservative slice of an already-opt-in, already-budgeted
 * (byteCap/fileCap) Stop-hook path: generous enough for a handful of small
 * capped reads, small enough that a slow/stalled disk can't meaningfully
 * delay critique delivery.
 */
const DEADLINE_MS = 500;

/** Module-level singleton — built once, imported by every production call site. */
export const nodeCaptureDeps: CaptureDeps = {
  readFileCapped,
  fingerprintsFor,
  writeAtomic: writeAtomicAsync,
  now: () => new Date(),
  deadlineMs: DEADLINE_MS,
};

// --- Task 9: real FinalizeDeps (Phase 2, distil-worker acted/appended branch) ---

/**
 * `finalizeCase1` runs inside the detached distil worker while holding the
 * GLOBAL `distil-worker.lock` (spec §4.2 "Robustness + placement") — a hung
 * `git` subprocess here must never stall every project's loop. `timeout` +
 * `killSignal: "SIGKILL"` give Node's `child_process` a hard wall it enforces
 * itself (SIGTERM can be ignored/swallowed by a wedged process; SIGKILL
 * cannot). 3s is generous for `rev-parse`/`status --porcelain` (both are
 * near-instant on a healthy repo) and small enough that a hung git can't
 * meaningfully delay the sweep.
 */
const GIT_TIMEOUT_MS = 3_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

async function defaultRunGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
}

/**
 * `git rev-parse HEAD`, killable-timeout. Exported (not just the `nodeFinalizeDeps`
 * closure) so tests can inject a fake `runGit` without spawning a real git
 * process — mirrors `loadRecentCommits`'s `runGit` seam in `coding-signal.ts`.
 */
export async function gitRevParseHead(
  cwd: string,
  opts?: { runGit?: (args: string[], cwd: string) => Promise<string> },
): Promise<string | null> {
  try {
    const runGit = opts?.runGit ?? defaultRunGit;
    const sha = (await runGit(["rev-parse", "HEAD"], cwd)).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/** `git status --porcelain`, killable-timeout. Non-empty output = dirty worktree. */
export async function gitWorktreeDirty(
  cwd: string,
  opts?: { runGit?: (args: string[], cwd: string) => Promise<string> },
): Promise<boolean> {
  try {
    const runGit = opts?.runGit ?? defaultRunGit;
    const out = await runGit(["status", "--porcelain"], cwd);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Read + parse a `.pre.json` candidate. Never throws — any read/parse failure
 * (missing file, corrupt JSON) returns `null` so `finalizeCase1` treats it as
 * "skip" (fail-soft), not fatal.
 */
async function readPre(path: string): Promise<any | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Best-effort delete — a failure to remove the stale `.pre.json` is never fatal. */
async function deleteFileSwallow(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort; a leftover .pre.json is housekeeping, not correctness
  }
}

/**
 * Module-level singleton — the real `FinalizeDeps` for `finalizeCase1`
 * (Phase 2). Reuses `nodeCaptureDeps`'s file-read/write/clock plumbing and
 * adds the pre-candidate reader + killable-timeout git deps + file delete.
 */
export const nodeFinalizeDeps: FinalizeDeps = {
  ...nodeCaptureDeps,
  readPre,
  headSha: (cwd: string) => gitRevParseHead(cwd),
  worktreeDirty: (cwd: string) => gitWorktreeDirty(cwd),
  deleteFile: deleteFileSwallow,
};

// --- Task 10: real GcDeps (orphan GC, distil-worker opportunistic sweep) ---

/**
 * Lists filenames in the candidates dir. Never throws — a missing dir (capture
 * never enabled/used yet) or any readdir failure returns `[]` so `gcCase1Candidates`
 * treats it as "nothing to GC", not fatal.
 */
async function listPreCandidates(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** mtime (epoch ms) of the file at `path`. Let `gcCase1Candidates`'s own try/catch handle failures. */
async function statMtime(path: string): Promise<number> {
  const s = await stat(path);
  return s.mtimeMs;
}

/**
 * Module-level singleton — the real `GcDeps` for `gcCase1Candidates` (Task 10).
 * Reuses the same best-effort delete as Phase 2's pre-cleanup.
 */
export const nodeGcDeps: GcDeps = {
  listPre: listPreCandidates,
  statMtime,
  deleteFile: deleteFileSwallow,
};
