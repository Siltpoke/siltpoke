// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Build stamp — pure derivation of the "which build is this daemon serving"
 * footer line.
 *
 * Why this exists next to `daemon/build-state.ts` rather than inside it:
 * that module answers "which commit was the CHECKOUT on when the process
 * booted", which is a different question from "which code did the process
 * load". The two diverge exactly when it matters — a directory can sit on
 * `main` while the running process still serves a bundle built on another
 * branch — and a version number derived from the checkout would be a new
 * lying signal of precisely the kind this work exists to remove.
 *
 * Three layers, three independent measurements, never collapsed into one
 * number:
 *   ③ process — sha256 of the file THIS process loaded, taken at load time
 *   ② dist    — sha256 of that same path right now
 *   ① branch  — the commit whose committed copy of that path has content
 *               identical to ③ (reverse blob lookup, not a checkout HEAD read)
 *
 * This file is pure: it derives a line from an already-measured stamp and
 * shells to nothing. `capture.ts` owns the impure half.
 */

export type BuildDrift = "same" | "rebuilt-since-boot" | "unknown";

export interface BuildStamp {
  /** Absolute path of the file this process actually loaded. null = unmeasured. */
  bundlePath: string | null;
  /** sha256 of that file at load time (layer ③). */
  bootSha256: string | null;
  /** sha256 of that same path now (layer ②). */
  diskSha256: string | null;
  /** Commit whose committed copy of the bundle IS `bootSha256` (layer ①). */
  commit: string | null;
  /** That commit's committer date, ISO-8601 with offset. */
  commitTime: string | null;
  /** That commit's subject line. */
  commitSubject: string | null;
  /** Commits in `HEAD..<upstreamRef>`. null = unmeasured, which is NOT zero. */
  behindUpstream: number | null;
  /** The ref `behindUpstream` was counted against, e.g. "origin/main". */
  upstreamRef: string | null;
}

export interface BuildLine {
  /** false = nothing was measured; render nothing (never a placeholder). */
  show: boolean;
  /** ok = all three layers agree · warn = a named mismatch · unknown = unmeasured. */
  state: "ok" | "warn" | "unknown";
  /** The one-line footer text. "" when show is false. */
  text: string;
  /** Hover detail: commit subject + the exact path measured. "" when show is false. */
  title: string;
}

/**
 * Layer ②/③ comparison. An unmeasured side yields "unknown" rather than
 * "same" — two nulls comparing equal would report agreement between two
 * things nobody looked at.
 */
export function driftBetween(
  bootSha256: string | null,
  diskSha256: string | null,
): BuildDrift {
  if (!bootSha256 || !diskSha256) return "unknown";
  return bootSha256 === diskSha256 ? "same" : "rebuilt-since-boot";
}

/** First 7 chars, git-short-sha style. Empty input → "". */
function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "";
}

/**
 * "2026-08-18T22:37:47-07:00" → "08-18 22:37".
 *
 * Read straight out of the ISO string's own fields rather than through a Date:
 * the commit's recorded local time is the useful one, and going through a Date
 * would re-render it in whatever timezone the daemon happens to run in.
 */
function stampTime(iso: string | null): string {
  if (!iso || iso.length < 16) return "";
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Derive the footer line. Precedence is nearest-cause-first: a process serving
 * a bundle that has since been rebuilt is a more immediate explanation for
 * "the page didn't change" than a checkout that trails its upstream, so the
 * rebuilt case wins and names its own fix (restart) without also reciting the
 * branch count.
 */
export function formatBuildLine(stamp: BuildStamp): BuildLine {
  if (!stamp.bundlePath || !stamp.bootSha256) {
    return { show: false, state: "unknown", text: "", title: "" };
  }

  const title = [
    stamp.commitSubject ?? "(no commit matches this bundle's contents)",
    stamp.bundlePath,
  ].join("\n");

  // A commit sha and a content sha256 are both hex and would be
  // indistinguishable in the same slot, so an unmatched build says so rather
  // than letting its content hash read as a commit id.
  const id = stamp.commit
    ? short(stamp.commit)
    : `${short(stamp.bootSha256)} (uncommitted)`;

  if (driftBetween(stamp.bootSha256, stamp.diskSha256) === "rebuilt-since-boot") {
    return {
      show: true,
      state: "warn",
      text: `build ${id} · dist rebuilt — restart the daemon`,
      title,
    };
  }

  // No commit ships this exact content: a local build that was never
  // committed. Normal while iterating, so it is stated, not flagged.
  if (!stamp.commit) {
    return {
      show: true,
      state: "unknown",
      text: `build ${short(stamp.bootSha256)} · uncommitted build`,
      title,
    };
  }

  if (stamp.behindUpstream !== null && stamp.behindUpstream > 0) {
    return {
      show: true,
      state: "warn",
      text: `build ${short(stamp.commit)} · ${stamp.behindUpstream} behind ${stamp.upstreamRef ?? "upstream"}`,
      title,
    };
  }

  return {
    show: true,
    state: "ok",
    text: `build ${short(stamp.commit)} · ${stampTime(stamp.commitTime)}`.trimEnd(),
    title,
  };
}
