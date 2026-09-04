// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { fileContentFingerprints } from "./line-fingerprint";
import type { PendingCritique } from "./pending-queue";
import { resolveInsideRepo } from "../utils/repo-path";

export interface OracleDeps {
  readFileAt?: (cwd: string, file: string) => Promise<string | null>;
  rerunChecker?: (cwd: string, tool: "tsc" | "eslint", file: string, line?: number) => Promise<boolean | null>;
}

export type Verdict = "acted" | "not_yet" | "abstain";

/**
 * Why the oracle declined to judge. Six causes that were previously
 * indistinguishable — they all surfaced as the bare string `"abstain"`, which
 * made an abstain rate uninterpretable: a high one could equally mean the
 * fingerprint capture is broken, files are being deleted, or the queue is full
 * of critiques written before a baseline existed. Those call for completely
 * different fixes, so the log has to keep them apart.
 */
export type AbstainReason =
  /** The critique was written with no baseline commit to compare against. */
  | "no_baseline_sha"
  /** The critique carried no anchor, so there is no line to look for. */
  | "no_anchor"
  /** The anchored file could not be read — deleted, permissions, or locked. */
  | "file_unreadable"
  /**
   * The anchor points outside the repo under review — a /tmp build log, a
   * scratchpad script, a stale pre-migration path. Kept distinct from
   * `file_unreadable` because it is a capture defect upstream, not a file that
   * moved: nothing the oracle does will ever make such an anchor judgeable.
   */
  | "anchor_outside_repo"
  /** Fingerprint capture failed when the critique was written; nothing to match. */
  | "no_fingerprint"
  /** Something threw. Kept distinct so a bug never hides inside a legitimate abstain. */
  | "threw";

export interface Adjudication {
  verdict: Verdict;
  /**
   * Which mechanism decided: 1 = the tsc/eslint rerun said the error cleared,
   * 2 = the content fingerprint. Undefined on abstain, where nothing decided.
   *
   * NOTE: tier 1 is currently unreachable in production — `defaultRerunChecker`
   * always returns null (a documented MVP punt, see below), so every live row
   * that has a tier at all reads 2 until the checker is wired. Abstains carry no
   * tier. An all-2s column in the log is that punt showing through, not a bug in
   * the adjudication.
   */
  verdict_tier?: 1 | 2;
  /** Present only when `verdict === "abstain"`. */
  abstain_reason?: AbstainReason;
}

/**
 * The full adjudication (eval design §2.2). `actedOnOracle` is the verdict-only
 * wrapper kept for callers that do not need the reason.
 */
export async function adjudicate(
  entry: PendingCritique,
  cwd: string,
  deps: OracleDeps = {},
): Promise<Adjudication> {
  try {
    if (entry.created_sha === null) return { verdict: "abstain", abstain_reason: "no_baseline_sha" };
    if (entry.anchors.length === 0) return { verdict: "abstain", abstain_reason: "no_anchor" };

    // Judge the FIRST USABLE anchor, not `anchors[0]`. A critique carries up to
    // five, and one unusable anchor used to discard the other four: critique
    // c-193a (2026-08-25) anchored a rubric hit on /tmp/ci-2-signal.log at [0]
    // and two readable, fingerprinted source lines at [1] and [2], and
    // abstained `file_unreadable` on every sweep until its TTL expired.
    let firstReason: AbstainReason | undefined;
    for (const anchor of entry.anchors) {
      const judged = await judgeAnchor(anchor, cwd, deps);
      if (judged.verdict !== "abstain") return judged;
      firstReason ??= judged.abstain_reason;
    }
    // Every anchor declined. Report the first one's reason so a log row still
    // names a cause, and the common single-anchor case reads exactly as before.
    return { verdict: "abstain", abstain_reason: firstReason };
  } catch {
    return { verdict: "abstain", abstain_reason: "threw" };
  }
}

/**
 * One anchor's verdict. Deliberately has NO try/catch: a throw is a bug signal
 * and must reach `adjudicate`'s handler as `threw`, not be laundered into "this
 * anchor was unusable, try the next one".
 */
async function judgeAnchor(
  anchor: PendingCritique["anchors"][number],
  cwd: string,
  deps: OracleDeps,
): Promise<Adjudication> {
  // Containment first, before any disk access. `join(cwd, "/tmp/x.log")`
  // produces `<cwd>/tmp/x.log`, so an out-of-repo anchor used to come back as a
  // plausible-looking `file_unreadable` instead of the capture defect it is.
  if (resolveInsideRepo(cwd, anchor.file) === null) {
    return { verdict: "abstain", abstain_reason: "anchor_outside_repo" };
  }

  const readFileAt = deps.readFileAt ?? defaultReadFileAt;
  const current = await readFileAt(cwd, anchor.file);
  if (current === null) return { verdict: "abstain", abstain_reason: "file_unreadable" };

  // Tier 1 — error-cleared
  if (anchor.tool === "tsc" || anchor.tool === "eslint") {
    const rerun = deps.rerunChecker ?? defaultRerunChecker;
    const cleared = await rerun(cwd, anchor.tool, anchor.file, anchor.line);
    if (cleared === true) return { verdict: "acted", verdict_tier: 1 };
    if (cleared === false) return { verdict: "not_yet", verdict_tier: 1 };
    // null → fall through to Tier 2
  }

  // Tier 2 — content-existence (drift-robust, SonarQube-style): is the flagged
  // line's captured content still present ANYWHERE in the current file?
  if (anchor.fingerprint === "") return { verdict: "abstain", abstain_reason: "no_fingerprint" };
  const present = fileContentFingerprints(current).has(anchor.fingerprint);
  return { verdict: present ? "not_yet" : "acted", verdict_tier: 2 };
}

export async function actedOnOracle(entry: PendingCritique, cwd: string, deps: OracleDeps = {}): Promise<Verdict> {
  return (await adjudicate(entry, cwd, deps)).verdict;
}

// --- default deps: real git + checker. Thin; safe to iterate later. ---
async function defaultReadFileAt(cwd: string, file: string): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    // NOT `join(cwd, file)`: join treats an absolute `file` as a relative
    // segment (`join("/repo", "/tmp/x")` → `/repo/tmp/x`), which reads as a
    // deleted file. resolveInsideRepo resolves either form and refuses to leave
    // the repo, so this stays a defence even if a caller skips judgeAnchor's check.
    const abs = resolveInsideRepo(cwd, file);
    if (abs === null) return null;
    return await readFile(abs, "utf8");
  } catch {
    return null;
  }
}

async function defaultRerunChecker(): Promise<boolean | null> {
  // RATIFIED (b), 2026-07-15: MVP ships fingerprint-only LIVE (the SonarQube/CodeQL-grade
  // high-precision line-content-hash — NOT the demoted hunk-overlap). error-cleared is
  // exercised via injected deps in tests and goes live in the immediate fast-follow that
  // wires the critic's existing tsc/eslint runner here. Returning null = fall to Tier 2.
  return null;
}
