// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { Overlay } from "./types";

function edgeProse(key: string): string {
  const [a, b] = key.split("->");
  return `${a} → ${b}`;
}

/** A contradicted key is stored under the user's REVERSED (wrong-direction) claim
 *  "a->b"; contradict is only emitted when the reverse edge exists (fact-check.ts), so
 *  the real edge is always "b->a". Flip before rendering — never surface the wrong
 *  direction as a place to explore. */
function flippedEdgeProse(key: string): string {
  const [a, b] = key.split("->");
  return `${b} → ${a}`;
}

/** Evidence-specific, score-free wrap-up. Names established vs not-established
 *  connections in graph terms; never a count, percentage, or evaluative adjective (R4). */
export function buildWrapup(overlay: Overlay): string {
  const established = [...overlay.supported].map(edgeProse);
  const corrected = [...overlay.contradicted].map(flippedEdgeProse);
  const open = [...overlay.unverified].map(edgeProse);

  const parts: string[] = [];
  if (established.length > 0) {
    parts.push(`You connected: ${established.join("; ")}.`);
  } else {
    parts.push("We didn't establish any connections this round.");
  }
  if (corrected.length > 0) {
    parts.push(`The dependency runs the other way than described: ${corrected.join("; ")}.`);
  }
  if (open.length > 0) {
    parts.push(`We haven't established: ${open.join("; ")} — a place to look next.`);
  }
  return parts.join(" ");
}
