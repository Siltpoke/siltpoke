// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * A diagnostic or match line as the tsc / eslint / ripgrep formatters in `prompt-tools.ts` print it. The tail
 * is `[^\n]*`, not `.*`: `.` stops at `\r` and U+2028, and a ripgrep match from
 * a CRLF file keeps its `\r`.
 */
const WRAPPED_LOCATION = /^- `([^`\n]+)` — ([^\n]*)$/;

/** The location lines of one tsc / eslint / ripgrep block, backticks removed. */
export function unwrappedLocationLines(block: string): string[] {
  const out: string[] = [];
  for (const line of block.split("\n")) {
    const m = WRAPPED_LOCATION.exec(line);
    if (m !== null) out.push(`- ${m[1]} — ${m[2]}`);
  }
  return out;
}

/**
 * The citation text plus, for every location line of the three list blocks,
 * the same line without the backticks around the location.
 *
 * Defect [52]: the reviewer sees `` - `src/a.ts:52:3` — TS2322 error: … `` and
 * quotes it back as `src/a.ts:52:3 — TS2322 error: …`. The backticks are this
 * file's markup, not tool output, and the raw tsc stdout has another shape
 * (`src/a.ts(52,3): error TS2322: …`), so the quote matched nowhere and a
 * correct finding was refused. The added lines say exactly what the tool said,
 * minus two characters siltpoke put there, so the guard's "a tool really said
 * this" property holds. Appended after the section, never in place: the
 * guard's hunk parser stops at each hunk's own counts, so trailing lines are
 * never read as diff content. Collected from the list blocks only (see
 * `pushList`): a removed source line can print as `` - `x` — y `` inside a diff
 * hunk, and unwrapping that would verify text no tool printed.
 */
export function withUnwrappedLocations(text: string, unwrapped: readonly string[]): string {
  return unwrapped.length === 0 ? text : `${text}\n${unwrapped.join("\n")}`;
}
