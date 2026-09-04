// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Doctor check for per-role brain health rows (single-brain #10 S1).
 *
 * Replaces the old single reviewer-provider row (track #7 T5, AC11; agy
 * branch added track #7 T9) with THREE rows — one per `BrainRole` (chat,
 * review, extract) — sourced from `loadBrainConfigSync` (Task 1) +
 * `resolveRole` (Task 2) rather than this file's own ad-hoc config reader.
 * Split out of doctor.ts to keep that file under the 400-LOC ratchet,
 * mirroring doctor-brain-check.ts / doctor-daemon-check.ts.
 *
 * Always pass=true (fail-soft posture, same as daemon-alive/autostart):
 *   - a role's family binary missing from PATH -> ⚠ warn row (that role's
 *     Brain calls fail-soft skip until installed). claude runs in-process
 *     (`claude -p`, always available in a Claude Code env) so it has no
 *     binary gate and is never a warn source on that basis.
 *   - review-only cross-family facet: an info note (NOT a warn) stating
 *     whether the review role's family differs from the author family —
 *     S1 deliberately adds no NEW warn beyond the pre-existing agy-running-
 *     a-Claude-model case (track #7 T7's `isClaudeFamilyModel` — agy's
 *     `--model` menu includes Claude-family entries that would defeat the
 *     point of picking agy as a cross-family reviewer).
 *   - eval provenance (AC12): "eval: uncertified" when no on-record verdict
 *     covers this role's exact family, else "eval: certified <ts> —
 *     servedModel=<model>" — surfaced on every non-claude row.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isClaudeFamilyModel } from "../brain/agy-honesty";
import { loadBrainConfigSync, type BrainRole, type ProviderFamily } from "../brain/brain-config";
import { familyBinary, resolveRoleMeta } from "../brain/registry";
import { siltpokeRoot } from "../installer/paths";
import { defaultRepoRoot } from "./doctor";
import type { CheckResult, DoctorOptions } from "./doctor";

/** Sidecar written by run-eval.ts's `--provider codex` execute path
 * (src/eval/caller-impact/verdict-writer.ts's VerdictProvenance, T5 AC12). */
interface VerdictProvenanceFile {
  schemaVersion?: unknown;
  provider?: unknown;
  servedModel?: unknown;
  ts?: unknown;
}

function readEvalProvenance(path: string): VerdictProvenanceFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as VerdictProvenanceFile;
  } catch {
    // Corrupt/unreadable sidecar -> treated the same as absent (uncertified).
    return null;
  }
}

/** Default location run-eval.ts writes to: sibling of the caller-impact
 * verdict.md (src/eval/caller-impact/verdict.provenance.json). */
export function defaultEvalProvenancePath(repoRoot: string): string {
  return join(repoRoot, "src", "eval", "caller-impact", "verdict.provenance.json");
}

/**
 * Resolve the eval-provenance sidecar path this check will read, honoring
 * (in priority order): an explicit `evalProvenancePath` override, else
 * `defaultEvalProvenancePath` derived from an explicit `repoRoot` override,
 * else `defaultEvalProvenancePath(defaultRepoRoot())` — the REPO checkout
 * (T5 review fix: this previously fell back to `siltpokeRoot()`, the
 * `~/.siltpoke` runtime dir, which is NOT where run-eval.ts's `--execute`
 * path writes the sidecar — `import.meta.dir`-relative, always under the
 * repo). Exported so the no-override default branch is independently
 * testable without writing into the real repo checkout from a test.
 */
export function resolveEvalProvenancePath(opts: Pick<DoctorOptions, "repoRoot" | "evalProvenancePath">): string {
  return opts.evalProvenancePath ?? defaultEvalProvenancePath(opts.repoRoot ?? defaultRepoRoot());
}

/**
 * One-liner: "eval: uncertified" when no on-record verdict covers this exact
 * family, else "eval: certified <ts> — servedModel=<model>". Certification
 * is per-family (a verdict for claude says nothing about codex, AC12's
 * whole point) — the served-model string is recorded as-is, staleness
 * detection (a codex model rotation invalidating an old verdict) is a
 * maintainer/manual concern per the release-gate doc, not this check's job.
 */
function provenanceLine(family: ProviderFamily, provenance: VerdictProvenanceFile | null): string {
  if (provenance === null || provenance.provider !== family) {
    return "eval: uncertified — no release-gate verdict on record for this provider";
  }
  const servedModel = typeof provenance.servedModel === "string" ? provenance.servedModel : "(unknown)";
  const ts = typeof provenance.ts === "string" ? provenance.ts : "(unknown date)";
  return `eval: certified ${ts} — servedModel=${servedModel}`;
}

const ROLE_ORDER: readonly BrainRole[] = ["chat", "review", "extract"];

/** Info-only cross-family state for the review row (S1 warns nowhere new). */
function crossFamilyNote(reviewFamily: ProviderFamily, authorFamily: ProviderFamily, model?: string): string {
  if (reviewFamily === "agy" && model !== undefined && isClaudeFamilyModel(model)) {
    return `cross-family: ⚠ agy is running a Claude-family model ("${model}") — not a true cross-family review.`;
  }
  return reviewFamily === authorFamily
    ? `cross-family: ◦ same family as author (${authorFamily}) — a different family reduces self-preference bias.`
    : `cross-family: ✓ (review=${reviewFamily}, author=${authorFamily}).`;
}

export function checkBrainRoles(opts: DoctorOptions): CheckResult[] {
  const siltpokeHome = opts.siltpokeHome ?? siltpokeRoot();
  const config = loadBrainConfigSync(siltpokeHome);
  const which = opts.reviewerWhichFn ?? ((cmd: string) => Bun.which(cmd));
  const provenance = readEvalProvenance(resolveEvalProvenancePath(opts));

  return ROLE_ORDER.map((role): CheckResult => {
    const resolved = resolveRoleMeta(config, role);
    const family = resolved.family;
    const name = `brain role: ${role}`;
    const modelLabel = resolved.model ?? "(CLI default)";
    const bin = familyBinary(family);

    // claude family: in-process, nothing to gate -> plain healthy row for
    // chat/extract (no provenance, no cross-family concern to surface — a
    // default all-claude install should read as three silent ✓ rows, not
    // three ◦ info rows). review keeps the info row: the cross-family note
    // is the one load-bearing signal of this feature and must not be
    // silenced (product decision 2026-07-11 — post-final-review fix wave).
    if (bin === null) {
      if (role !== "review") {
        return { name, pass: true, detail: null };
      }
      // Builder-default caveat (Slice A T1): at review time the review role
      // defaults to the BUILDING host's CLI family (via SILTPOKE_HOST). Doctor
      // runs OUTSIDE the Stop hook, so SILTPOKE_HOST is unset here and review
      // resolves to this claude/config default — which understates what actually
      // runs on a non-claude host. Say so, so a claude row here isn't read as
      // "reviews are always claude". (This branch is claude-only by construction.)
      const builderNote =
        " (at review time this defaults to the building host's CLI family; set brain.roles.review to pin one.)";
      const detail = `family: claude. model=${modelLabel}. ${crossFamilyNote(family, config.authorFamily, resolved.model)}${builderNote}`;
      return { name, pass: true, status: "info", detail };
    }

    const present = which(bin) !== null;
    if (!present) {
      return {
        name,
        pass: true,
        status: "warn",
        detail: `family: ${family}. binary: ✗ \`${bin}\` not found on PATH — this role fails-soft until installed. model=${modelLabel}. ${provenanceLine(family, provenance)}`,
      };
    }

    // Present binary. review adds cross-family state; agy running a Claude model
    // bumps to warn — but ONLY for the review role (the cross-family-honesty
    // facet this warn protects is review-specific, same gate as crossNote
    // below; chat/extract running agy+a Claude model is not a self-review
    // risk and must stay a plain info row).
    const claudeModel =
      role === "review" && family === "agy" && resolved.model !== undefined && isClaudeFamilyModel(resolved.model);
    const crossNote = role === "review" ? ` ${crossFamilyNote(family, config.authorFamily, resolved.model)}` : "";
    return {
      name,
      pass: true,
      status: claudeModel ? "warn" : "info",
      detail: `family: ${family}. binary: ✓ present. model=${modelLabel}.${crossNote} ${provenanceLine(family, provenance)}`,
    };
  });
}
