// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import { CompactFactoidRow } from "./CompactFactoidRow";
import type { Fact } from "../../memory/memory";

export interface FactoidPanelProps {
  facts: readonly Fact[];
  /** Cap on rendered rows. Default 10. */
  max?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

/**
 * Scrollable fixed-height container for a feed of compact factoid rows.
 * Renders up to `max` rows (default 10); slices the array if longer.
 * Empty state renders an inline ink3 placeholder.
 */
export function FactoidPanel(props: FactoidPanelProps) {
  const { facts, max = 10, now } = props;
  const sliced = facts.slice(0, max);

  return (
    <div
      class="factoid-panel"
      style={{
        maxHeight: 280,
        overflowY: "auto",
        background: tokens.color.paper,
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
      }}
    >
      {sliced.length === 0 ? (
        <div
          class="factoid-panel__empty"
          style={{
            padding: "16px 12px",
            fontFamily: tokens.font.body,
            fontSize: 12,
            color: tokens.color.ink3,
            textAlign: "center",
          }}
        >
          no facts yet
        </div>
      ) : (
        sliced.map((fact) => (
          <CompactFactoidRow key={fact.id} fact={fact} now={now} />
        ))
      )}
    </div>
  );
}
