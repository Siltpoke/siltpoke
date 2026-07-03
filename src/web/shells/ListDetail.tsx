// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface ListDetailProps {
  list: Child;
  detail: Child;
  listWidth?: number;
}

export function ListDetail(props: ListDetailProps) {
  const { list, detail, listWidth = 280 } = props;

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
      }}
    >
      {/* Left: filter / list sidebar */}
      <div
        style={{
          width: listWidth,
          flexShrink: 0,
          background: tokens.color.paper,
          borderRight: `1px solid ${tokens.color.edge}`,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {list}
      </div>

      {/* Right: detail pane */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "auto",
          background: tokens.color.cream,
        }}
      >
        {detail}
      </div>
    </div>
  );
}
