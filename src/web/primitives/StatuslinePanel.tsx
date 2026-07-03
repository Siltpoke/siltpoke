// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";

export interface StatuslinePanelProps {
  /** Pre-rendered statusline string (6 lines of mood/stat/progression text). */
  text: string;
}

/**
 * Dark-tile mono panel wrapping a pre-rendered statusline string.
 *
 * Renders a single `<pre>` so newlines + leading whitespace in the source
 * string are preserved without manual `<br>` splicing. No scroll bar:
 * the content height drives the panel height; long lines wrap visually
 * because `white-space: pre-wrap` is left to caller styling (panel itself
 * uses `pre` which is `white-space: pre` by default).
 */
export function StatuslinePanel(props: StatuslinePanelProps) {
  const { text } = props;
  return (
    <pre
      class="statusline-panel"
      style={{
        background: tokens.color.ink,
        color: tokens.color.cream,
        fontFamily: tokens.font.mono,
        fontSize: 11,
        lineHeight: 1.45,
        padding: "12px 14px",
        margin: 0,
        border: `1px solid ${tokens.color.ink2}`,
        borderRadius: tokens.radius.sm,
        overflow: "visible",
      }}
    >
      {text}
    </pre>
  );
}
