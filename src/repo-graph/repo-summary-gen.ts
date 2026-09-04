// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Generation helpers for the cached per-repo "what this is about" blurb shown
 * on the active-repos card. The blurb is produced by ONE small Brain call from
 * a repo's existing arch-model (boundary + layers + component descriptions),
 * then cached to `<home>/repo-memory/<proj_hash>/repo-summary.json` so reads
 * stay $0. This module holds the pure pieces (prompt context + output parse +
 * cache write); the gated Brain call itself lives in the daemon route so it can
 * be injected in tests.
 */
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import { computeProjHash } from "./proj-hash";
import { claimValue } from "./repo-card";
import { resolveExternalScope, isOutOfScopeRegistryNode } from "../explain/arch-reconcile";

const REPO_MEMORY_DIR = "repo-memory";
const SUMMARY_FILE = "repo-summary.json";

export const SUMMARY_SYSTEM_PROMPT =
  "You summarize a software repository for a one-line dashboard card. " +
  "You are given the repo name, its architecture layers, and its components " +
  "(each with a short description). Reply with ONLY a JSON object of the exact " +
  'shape {"summary": "<text>"} where <text> is one or two plain-English ' +
  "sentences (max 40 words) describing what the repository IS and DOES for " +
  "someone who has never seen it. No preamble, no markdown, no other keys.";

export interface RepoSummaryRecord {
  text: string;
  model: string;
  generated_ts: string;
  cost_usd: number;
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

/**
 * Build the context bundle (claude -p stdin) from a cached arch-model doc:
 * repo name, its layer labels, and each component's title + description.
 * Tolerates malformed/partial arch-models (missing pieces are skipped).
 *
 * `repoRoot` drops registry-declared reviewer externals the repo cannot
 * evidence. This one matters more than the other surfaces: the bundle is the
 * prompt for a PAID Brain call, so an unscoped model had Siltpoke spending real
 * tokens telling the summariser that some travel app is built out of four code
 * review CLIs — and then caching the blurb that came back.
 */
export function buildSummaryContext(archModel: unknown, repoRoot: string | null): string {
  const model = asRecord(archModel);
  const scope = resolveExternalScope(repoRoot);
  const boundary = model ? claimValue(model.boundary) : "";
  const bands =
    model && Array.isArray(model.bands)
      ? model.bands.map((b) => claimValue(asRecord(b)?.label)).filter((s) => s.length > 0)
      : [];
  const components =
    model && Array.isArray(model.nodes)
      ? model.nodes
          .filter((n) => !isOutOfScopeRegistryNode(n, scope))
          .map((n) => {
            const r = asRecord(n);
            if (!r) return "";
            const title = claimValue(r.title);
            const desc = claimValue(r.desc);
            if (!title) return "";
            return desc ? `- ${title}: ${desc}` : `- ${title}`;
          })
          .filter((s) => s.length > 0)
      : [];

  return [
    `Repo name: ${boundary || "unknown"}`,
    `Architecture layers: ${bands.join(", ")}`,
    "Components:",
    ...components,
  ].join("\n");
}

/** Extract + validate the summary string from the Brain's parsed JSON output. */
export function parseSummaryOutput(raw: unknown): string {
  const obj = asRecord(raw);
  const summary = obj && typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (summary.length === 0) {
    throw new Error("Brain response had no non-empty 'summary' field");
  }
  return summary;
}

export function repoSummaryPath(home: string, projectRoot: string): string {
  return join(home, REPO_MEMORY_DIR, computeProjHash(projectRoot), SUMMARY_FILE);
}

/** Atomically cache the generated blurb next to the repo's arch-model. */
export function writeRepoSummary(home: string, projectRoot: string, record: RepoSummaryRecord): void {
  atomicWrite(repoSummaryPath(home, projectRoot), JSON.stringify(record, null, 2));
}
