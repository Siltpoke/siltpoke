// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The freshness banner `/siltpoke-last` prints above a surfaced review.
 *
 * Why this exists: a reader has no way to tell WHICH change a surfaced review
 * is about, and assumes it is the one they just made. A review about someone
 * else's change reads exactly like a review about yours.
 *
 * A bare timestamp does NOT fix that, which is why this does more. Measured
 * case (critique `c-2722`, 2026-09-17): the review's `timestamp` was ~3 hours
 * old and its `branch` was the branch actually being worked on — both looked
 * right — while the diff it read contained none of the files that had changed.
 * Age alone would have printed a reassuring line over a review about a merged
 * PR. So the banner also reports what has changed SINCE, and says plainly when
 * the review cannot have seen it.
 *
 * Everything here is computed at READ time and stored nowhere: a banner baked
 * in at write time is a stale banner by definition.
 */
import { spawnSync } from "node:child_process";

export interface FreshnessInputs {
  /** ISO timestamp from the critique frontmatter. */
  timestamp: string | null;
  /** Branch from the frontmatter; absent on critiques written before it existed. */
  branch: string | null;
  /** Whether the reviewer cited any code at all (frontmatter evidence_label). */
  evidenceLabel: string | null;
  /** Repo the reader is standing in. */
  cwd: string;
  now: Date;
  /** @internal test seam — stub git so tests never shell out. */
  gitFn?: (args: string[], cwd: string) => string | null;
}

function runGit(args: string[], cwd: string): string | null {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/**
 * "3 hours ago" / "just now". Coarse on purpose: the reader wants an order of
 * magnitude, and a precise "2h 57m" invites the arithmetic this banner exists
 * to remove. Hours are not folded into days below 48h — "yesterday" is a
 * different claim from "26 hours ago" when you worked past midnight.
 *
 * Hours ROUND rather than floor, which is the opposite of `brain-health.ts`'s
 * `coarseDuration`, on purpose. That one counts DOWN to a retry, where
 * rounding 90 minutes up to "2h" overstates the wait. This one measures AGE,
 * where the dangerous direction is the other one: flooring 2h57m to "2 hours"
 * makes a stale review read as fresher than it is, which is the exact misread
 * this banner exists to prevent.
 */
export function humanAge(ms: number): string {
  if (ms < 0) return "in the future (clock skew)";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Files touched since `sinceIso`: committed, staged, and working-tree alike. */
export function changedSince(
  sinceIso: string,
  cwd: string,
  git: (args: string[], cwd: string) => string | null,
): string[] {
  const out = new Set<string>();
  // Committed after the review was written. `--since` is the commit date, so a
  // rebase can move a commit across this line — accepted: the banner is a
  // prompt to look, not a proof.
  const log = git(["log", `--since=${sinceIso}`, "--name-only", "--pretty=format:"], cwd);
  for (const l of (log ?? "").split("\n")) if (l.trim()) out.add(l.trim());
  // Uncommitted, both halves of the index. These carry no timestamp, so they
  // are counted regardless of age: a dirty file is by definition not something
  // a past review read.
  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--name-only", "--cached"],
  ]) {
    for (const l of (git(args, cwd) ?? "").split("\n")) if (l.trim()) out.add(l.trim());
  }
  return [...out].sort();
}

/**
 * Render the banner, or "" when there is nothing honest to say (no timestamp).
 *
 * Every line is a fact with its source; none of it is a verdict on the review's
 * content. The strong line — "it cannot have seen the files you have changed
 * since" — only fires when the evidence for it exists, and the wording says
 * what was compared so a reader can disagree with it.
 */
const MAX_LISTED = 6;

/**
 * Build output and lockfiles sort LAST in the listed sample.
 *
 * Not a filter — the count stays whole and nothing is hidden. Display order
 * only: the first real run listed five `dist/*.js` bundles and pushed every
 * `src/` file past the cap, so the line meant to answer "did it see the work"
 * showed only build artifacts. Dropping them would be siltpoke deciding which
 * of the user's changes count.
 */
function isGenerated(path: string): boolean {
  return (
    path.startsWith("dist/") ||
    path.startsWith("public/static/") ||
    path.endsWith("lock") ||
    path.endsWith(".lockb")
  );
}

function listingOrder(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const ga = isGenerated(a) ? 1 : 0;
    const gb = isGenerated(b) ? 1 : 0;
    return ga !== gb ? ga - gb : a.localeCompare(b);
  });
}

/**
 * Render the banner, or "" when there is nothing honest to say (no timestamp).
 *
 * **This is written for a coding agent, not for the statusline.** The two
 * surfaces have different readers and deliberately diverge: the pet's bubble
 * gets one glanceable `[10:44] "…"` line and nothing else, because a human
 * scanning it wants orientation, not a report. What lands here is pasted into
 * an agent's context to be reasoned over, so it carries the facts that decide
 * whether the review still applies — which branch, what has changed since,
 * whether there is any citation to check. Everything an agent would otherwise
 * have to go and derive.
 *
 * Facts with their source, never a verdict on the review's content. The strong
 * line only fires when its evidence exists, and it says what was compared so
 * the reader can disagree with it.
 */
export function renderFreshness(input: FreshnessInputs): string {
  const { timestamp, branch, evidenceLabel, cwd, now } = input;
  if (!timestamp) return "";
  const written = Date.parse(timestamp);
  if (!Number.isFinite(written)) return "";
  const git = input.gitFn ?? runGit;

  const clock = new Date(written).toTimeString().slice(0, 5);
  const lines = [`> 🕐 This review was written **${humanAge(now.getTime() - written)}** (${clock}).`];

  const currentBranch = (git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "").trim();
  if (branch && currentBranch && branch !== currentBranch) {
    lines.push(
      `> 🔀 It ran on branch \`${branch}\`; you are on \`${currentBranch}\`. It is about other work.`,
    );
  } else if (branch) {
    lines.push(`> 🔀 Branch \`${branch}\`.`);
  }

  const changed = changedSince(timestamp, cwd, git);
  if (changed.length > 0) {
    const ordered = listingOrder(changed);
    const shown = ordered.slice(0, MAX_LISTED);
    const more = changed.length - shown.length;
    lines.push(
      `> ⚠️ **${changed.length} file${changed.length === 1 ? "" : "s"} changed since it ran — it did not see ${changed.length === 1 ? "it" : "them"}:** ` +
        shown.map((f) => `\`${f}\``).join(", ") +
        (more > 0 ? `, and ${more} more` : ""),
    );
  }

  if (evidenceLabel === "no_evidence") {
    lines.push(
      "> 📄 It cited no code, so there is no line to walk to and nothing here to check against.",
    );
  }

  return `${lines.join("\n")}\n\n`;
}

/** Pull the three frontmatter fields the banner needs. Tolerant by design. */
export function parseFrontmatter(md: string): {
  timestamp: string | null;
  branch: string | null;
  evidenceLabel: string | null;
} {
  const end = md.indexOf("\n---", 4);
  const head = md.startsWith("---\n") && end > 0 ? md.slice(4, end) : "";
  const get = (key: string): string | null => {
    const m = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1]!.trim() : null;
  };
  return {
    timestamp: get("timestamp"),
    branch: get("branch"),
    evidenceLabel: get("evidence_label"),
  };
}
