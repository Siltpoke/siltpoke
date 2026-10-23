// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { basename } from "node:path";
import { alertBubbleText, type InjectionAlert } from "../critic/injection-alert";
import { clearAlert, type FaceState, setAlert, writeStateKeepingAlert } from "../state/state";

/**
 * State write for a REVIEW result. A loud injection alert is set; any other
 * review (no alert, or quiet-only) clears it — the bubble is loud-only and the
 * next alert-free review in this project ends it. A blanked bubble (low
 * confidence / empty) does not write `next`: only the alert field is merged
 * into the existing file (set or cleared). Resolves whether the file was written,
 * which the review row reports as `state_written`.
 */
export async function writeReviewState(
  stateBase: string,
  cwd: string | undefined,
  next: Omit<FaceState, "alert">,
  bubbleBlank: boolean,
  alert: InjectionAlert | undefined,
): Promise<boolean> {
  const loud = alert?.level === "loud" ? alert : undefined;
  if (loud === undefined) {
    return bubbleBlank ? await clearAlert(stateBase) : await writeStateKeepingAlert(stateBase, next, "clear");
  }
  const project = basename(cwd ?? process.cwd());
  const set = { text: alertBubbleText(loud, project), project, at: Date.now() };
  if (bubbleBlank) return await setAlert(stateBase, set, { ...next, bubble_short: "" });
  return await writeStateKeepingAlert(stateBase, next, { set });
}
