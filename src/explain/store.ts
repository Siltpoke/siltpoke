// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Markdown + sidecar JSON storage for explanations.
 *
 * Layout:
 *   {cwd}/.siltpoke/explanations/{key}.md
 *   {cwd}/.siltpoke/explanations/{key}.meta.json
 *
 * Mirrors `src/repo-graph/store.ts` atomic-write pattern (tmp file + rename)
 * so a crash mid-write leaves either the old pair or no files — never a
 * half-written one.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EXPLANATION_SCHEMA_VERSION,
  type ExplanationMeta,
  type ExplainResult,
} from "./types";

const EXPL_DIR = join(".siltpoke", "explanations");

export function cacheKey(targetNodeId: string): string {
  return createHash("sha256").update(targetNodeId, "utf8").digest("hex").slice(0, 12);
}

export function explanationDir(cwd: string): string {
  return join(cwd, EXPL_DIR);
}

export interface ExplanationPaths {
  mdPath: string;
  metaPath: string;
}

export function explanationPaths(cwd: string, key: string): ExplanationPaths {
  const dir = explanationDir(cwd);
  return {
    mdPath: join(dir, `${key}.md`),
    metaPath: join(dir, `${key}.meta.json`),
  };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

export async function writeExplanation(
  cwd: string,
  key: string,
  markdown: string,
  meta: ExplanationMeta,
): Promise<ExplainResult> {
  await mkdir(explanationDir(cwd), { recursive: true });
  const { mdPath, metaPath } = explanationPaths(cwd, key);
  await atomicWrite(mdPath, markdown);
  await atomicWrite(metaPath, JSON.stringify(meta, null, 2));
  return {
    mdPath,
    metaPath,
    markdown,
    meta,
    fromCache: false,
  };
}

export interface ExplanationListEntry {
  key: string;
  target: string;
  target_node_id: string;
  created_ts: string;
  graph_indexed_ts: string;
  evidence_score: number;
  low_confidence: boolean;
  depth: 1 | 2;
}

/**
 * Scan `{cwd}/.siltpoke/explanations/*.meta.json` and return entries sorted
 * by `created_ts` descending (newest first). Corrupt / schema-mismatched
 * meta files are silently skipped — same defensive tolerance pattern as
 * `readExplanation()`.
 */
export async function listExplanations(
  cwd: string,
): Promise<ExplanationListEntry[]> {
  const dir = explanationDir(cwd);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ExplanationListEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const key = name.slice(0, -".meta.json".length);
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const meta = JSON.parse(raw) as ExplanationMeta;
      if (meta.schemaVersion !== EXPLANATION_SCHEMA_VERSION) continue;
      out.push({
        key,
        target: meta.target,
        target_node_id: meta.target_node_id,
        created_ts: meta.created_ts,
        graph_indexed_ts: meta.graph_indexed_ts,
        evidence_score: meta.evidence_score,
        low_confidence: meta.low_confidence,
        depth: meta.depth,
      });
    } catch {
      // skip unreadable entry
    }
  }
  out.sort((a, b) => b.created_ts.localeCompare(a.created_ts));
  return out;
}

export async function readExplanation(
  cwd: string,
  key: string,
): Promise<ExplainResult | null> {
  const { mdPath, metaPath } = explanationPaths(cwd, key);
  if (!existsSync(mdPath) || !existsSync(metaPath)) return null;
  try {
    const [markdown, metaRaw] = await Promise.all([
      readFile(mdPath, "utf8"),
      readFile(metaPath, "utf8"),
    ]);
    const meta = JSON.parse(metaRaw) as ExplanationMeta;
    if (meta.schemaVersion !== EXPLANATION_SCHEMA_VERSION) return null;
    return {
      mdPath,
      metaPath,
      markdown,
      meta,
      fromCache: true,
    };
  } catch {
    return null;
  }
}
