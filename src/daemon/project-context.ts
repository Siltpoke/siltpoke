// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @module project-context — per-request project resolution for daemon routes.
 * Reads the server-side pin, resolves via resolveDaemonProject, and persists
 * the pin for intentional selections so the next bare request is sticky.
 */
import {
  type DaemonProject,
  type ResolveDaemonProjectDeps,
  resolveDaemonProject,
} from "../memory/active-project";
import { readProjectPin, writeProjectPin } from "../state/project-pin";

export async function resolveRequestProject(
  home: string,
  explicitProjHash: string | undefined,
  deps?: ResolveDaemonProjectDeps,
): Promise<DaemonProject> {
  const pinnedProjHash = (await readProjectPin(home)) ?? undefined;
  const resolved = await resolveDaemonProject({ home, explicitProjHash, pinnedProjHash }, deps);
  // Persist intentional selections. `recent` is a one-shot guess that we pin so
  // the next bare visit sticks; `sticky` is already the pin; `stale`/`none` are not persisted.
  if (resolved.proj_hash && (resolved.source === "explicit" || resolved.source === "recent")) {
    await writeProjectPin(home, resolved.proj_hash);
  }
  return resolved;
}
