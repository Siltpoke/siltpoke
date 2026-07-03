// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * critique-sidecar-loader — resolve the v2 sidecar for a critique.
 *
 * Sidecars live under `${cwd}/.siltpoke/critiques/archive/...` when cwd
 * is known (project-local), with `~/.siltpoke/...` as the fallback for
 * daemon-side or legacy critiques. Looks up the call's cwd from
 * brain-calls.jsonl by exact critique_id match.
 *
 * Extracted from critique-narrative.ts when the narrative surfaces were
 * removed; the few-shot endpoint still needs this loader.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadV2Sidecar, type V2SidecarData } from "./v2-sidecar";

function parseCwdFromLine(line: string, critiqueId: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const ev = JSON.parse(trimmed) as { critique_id?: string; cwd?: string };
    if (ev.critique_id === critiqueId && typeof ev.cwd === "string") {
      return ev.cwd;
    }
  } catch {
    // malformed line — skip
  }
  return null;
}

async function findCwdForCritique(
  basePath: string,
  critiqueId: string,
): Promise<string | null> {
  const callsPath = join(basePath, "brain-calls.jsonl");
  if (!existsSync(callsPath)) return null;
  let raw: string;
  try {
    raw = await readFile(callsPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const cwd = parseCwdFromLine(line, critiqueId);
    if (cwd) return cwd;
  }
  return null;
}

export async function loadSidecarForCritique(
  basePath: string,
  critiqueId: string,
): Promise<V2SidecarData | null> {
  const cwd = await findCwdForCritique(basePath, critiqueId);
  if (cwd) {
    const projectLocal = join(cwd, ".siltpoke");
    const v2 = await loadV2Sidecar(critiqueId, null, projectLocal);
    if (v2) return v2;
  }
  return loadV2Sidecar(critiqueId, null, basePath);
}
