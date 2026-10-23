// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The Generated-view grounded chip + its arch status/notice line
 * (`#rg-arch-chip` + `#rg-arch-noevi`) — pulled out of `repo-graph.ts`'s
 * `updateArchAffordance` (extraction, not a new feature) so that pinned file
 * could grow the AC32 trust-note wiring without going over its `lint:files`
 * length pin. Pure DOM writer: every input is passed in, nothing is read
 * from module scope, so this is exactly the block that used to live inline.
 */
import type { TierMap } from "./repo-graph-c4-adapter";
import type { C4Model } from "./repo-graph-c4-model";
import { trustNote, type TrustState } from "./repo-graph-trust-edges";

interface GroundedChipEls {
  archChip: HTMLElement;
  archNoEvi: HTMLElement | null;
  archChipPct: HTMLElement | null;
  archChipBlind: HTMLElement | null;
}

/**
 * Show/hide + fill the grounded chip and its notice line for the current
 * state. `visible` is the caller's `archSource === "generated"` check — the
 * chip stays meaningless (and hidden) for Authored/Subset.
 *
 * Notice-line priority (AC32): a failed trust fetch (`trustNote`) pre-empts
 * the no-file-evidence count — both are "read this container list with
 * doubt" signals, but a fetch failure means the ON-SCREEN DASHES themselves
 * fell back to the legacy tier rule, which is the more urgent thing to say.
 */
export function updateGroundedChip(
  els: GroundedChipEls,
  visible: boolean,
  C4: C4Model,
  archTiers: TierMap | null,
  trustState: TrustState,
): void {
  els.archChip.hidden = !visible;
  if (!visible) {
    if (els.archNoEvi) els.archNoEvi.hidden = true;
    return;
  }
  const note = trustNote(trustState);
  if (els.archNoEvi) {
    if (note) {
      els.archNoEvi.textContent = note;
      els.archNoEvi.hidden = false;
    } else {
      // Count conts the model drew WITHOUT file evidence — surfaced, not
      // silent (claude-code's truncated model honestly reads 19 here).
      const k = Object.values(C4.N).filter((n) => n.kind === "cont" && !n.memberFiles?.length).length;
      if (k > 0) {
        els.archNoEvi.textContent = `${k} containers carry no file evidence`;
        els.archNoEvi.hidden = false;
      } else {
        els.archNoEvi.hidden = true;
      }
    }
  }
  if (els.archChipPct) els.archChipPct.textContent = `${archTiers?.groundedPct ?? 0}%`;
  // Count topology-blind bands from the tier map (derived, no new payload
  // field). Surfaced as a NEUTRAL "· K layer-not-confirmable" — these are
  // honest abstentions (cores the import gradient can't place), NOT
  // grounding failures, so they sit apart from the grounded %.
  if (els.archChipBlind) {
    const k = Object.values(archTiers?.bands ?? {}).filter((t) => t === "topology-blind").length;
    if (k > 0) {
      els.archChipBlind.textContent = `· ${k} layer-not-confirmable`;
      els.archChipBlind.hidden = false;
    } else {
      els.archChipBlind.hidden = true;
    }
  }
}
