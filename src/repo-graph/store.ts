// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Read/write helpers for the repo-graph storage layout.
 *
 *   ~/.siltpoke/repo-memory/{proj-hash}/
 *     ├── graph.json
 *     ├── queryIndex.json
 *     ├── fingerprints.json
 *     └── meta.json
 *
 * All writes use async atomic-write (tmp file + rename) so partial
 * writes don't corrupt the graph on crash. All reads are tolerant —
 * missing/corrupt files return the empty defaults from `types.ts`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  emptyFingerprints,
  emptyGraph,
  emptyQueryIndex,
  type Fingerprints,
  type QueryIndex,
  type RepoGraph,
  type RepoGraphMeta,
} from "./types";

const GRAPH_FILE = "graph.json";
const QUERY_INDEX_FILE = "queryIndex.json";
const FINGERPRINTS_FILE = "fingerprints.json";
const META_FILE = "meta.json";

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

async function readJsonOr<T>(path: string, fallback: () => T): Promise<T> {
  if (!existsSync(path)) return fallback();
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback();
  }
}

export async function ensureStorageDir(storageDir: string): Promise<void> {
  await mkdir(storageDir, { recursive: true });
}

export async function readGraph(storageDir: string): Promise<RepoGraph> {
  const parsed = await readJsonOr<RepoGraph>(join(storageDir, GRAPH_FILE), emptyGraph);
  // Defensive: ensure required fields exist even if file was hand-edited.
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    return emptyGraph();
  }
  return parsed;
}

export async function writeGraph(storageDir: string, graph: RepoGraph): Promise<void> {
  await ensureStorageDir(storageDir);
  await atomicWriteJson(join(storageDir, GRAPH_FILE), graph);
}

export async function readQueryIndex(storageDir: string): Promise<QueryIndex> {
  const parsed = await readJsonOr<QueryIndex>(join(storageDir, QUERY_INDEX_FILE), emptyQueryIndex);
  if (parsed.schemaVersion !== 1 || typeof parsed.name_to_node_ids !== "object" || parsed.name_to_node_ids === null) {
    return emptyQueryIndex();
  }
  return parsed;
}

export async function writeQueryIndex(storageDir: string, index: QueryIndex): Promise<void> {
  await ensureStorageDir(storageDir);
  await atomicWriteJson(join(storageDir, QUERY_INDEX_FILE), index);
}

export async function readFingerprints(storageDir: string): Promise<Fingerprints> {
  const parsed = await readJsonOr<Fingerprints>(join(storageDir, FINGERPRINTS_FILE), emptyFingerprints);
  if (parsed.schemaVersion !== 1 || typeof parsed.files !== "object" || parsed.files === null) {
    return emptyFingerprints();
  }
  return parsed;
}

export async function writeFingerprints(storageDir: string, fp: Fingerprints): Promise<void> {
  await ensureStorageDir(storageDir);
  await atomicWriteJson(join(storageDir, FINGERPRINTS_FILE), fp);
}

export async function readMeta(storageDir: string): Promise<RepoGraphMeta | null> {
  const path = join(storageDir, META_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as RepoGraphMeta;
    if (parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeMeta(storageDir: string, meta: RepoGraphMeta): Promise<void> {
  await ensureStorageDir(storageDir);
  await atomicWriteJson(join(storageDir, META_FILE), meta);
}
