/**
 * One-line note for a kept result whose cost went over its hard cap
 * (defect [38]). The cost is only known after the Brain has been billed, so an
 * over-cap result is kept rather than thrown away — this note is how the page
 * says so. Returns null when there is nothing to flag: under the cap, or no
 * cost recorded (a missing cost is never read as $0 or as "over").
 */
function overCapNote(
  costUsd: number | null | undefined,
  hardCapUsd: number | null | undefined,
): string | null {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return null;
  if (typeof hardCapUsd !== "number" || !Number.isFinite(hardCapUsd)) return null;
  if (costUsd <= hardCapUsd) return null;
  return `cost $${costUsd.toFixed(2)} — over the $${hardCapUsd.toFixed(2)} limit; kept because it was already paid for`;
}

/** The two fields a payload carries so a surface can flag a kept over-cap result. */
export interface OverCapFields {
  costUsd?: number | null;
  hardCapUsd?: number;
}

/** `hint`, with the over-cap note appended when the payload is over its cap. */
export function withOverCapNote(hint: string, o: OverCapFields | null | undefined): string {
  const note = overCapNote(o?.costUsd, o?.hardCapUsd);
  return note ? `${hint} · ${note}` : hint;
}

/** A `<tag class=cls data-over-cap>` line for the note, or "" when there is none. */
export function overCapHtml(o: OverCapFields, tag: string, cls: string, esc: (s: string) => string): string {
  const note = overCapNote(o.costUsd, o.hardCapUsd);
  return note ? `<${tag} class="${cls}" data-over-cap>⚠ ${esc(note)}</${tag}>` : "";
}
