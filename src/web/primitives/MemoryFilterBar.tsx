// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";

interface Chip {
  value: "" | "semantic" | "episodic" | "procedural";
  label: string;
  count: string; // Alpine expression yielding the live count
  color: string;
}

const CHIPS: Chip[] = [
  { value: "", label: "All", count: "memories.length", color: tokens.color.ink2 },
  {
    value: "semantic",
    label: "Semantic",
    count: "countByType('semantic')",
    color: "#5a86a0",
  },
  {
    value: "episodic",
    label: "Episodic",
    count: "countByType('episodic')",
    color: "#8a72a8",
  },
  {
    value: "procedural",
    label: "Procedural",
    count: "countByType('procedural')",
    color: "#6f8a54",
  },
];

interface StatusChip {
  value: "active" | "retired";
  label: string;
  color: string;
}

/** 生效 / 退休 status chips. Clicking an already-active chip clears to "". */
const STATUS_CHIPS: StatusChip[] = [
  { value: "active", label: "Active", color: "#5a7a3e" },
  { value: "retired", label: "Retired", color: "#b84a4a" },
];

/**
 * Stream-view controls bar: 筛选 type chips (全部/语义/情景/程序 with live
 * counts) + 状态 status chips (生效/退休, toggle-off to clear) + sort toggle
 * (旧→新 / 新→旧). State lives in the ancestor x-data="memoryBook".
 * Clicking a status chip again deselects it (filterStatus back to "").
 */
export function MemoryFilterBar() {
  return (
    <div
      class="memory-filter-bar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        flexWrap: "wrap",
        padding: "13px 0",
        marginBottom: "8px",
        borderBottom: `1px solid ${tokens.color.edge}`,
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: tokens.color.ink3,
          flexShrink: 0,
        }}
      >
        Filter
      </span>
      {CHIPS.map((chip) => (
        <button
          key={chip.value}
          type="button"
          class="memory-filter-chip"
          x-on:click={`setFilterType('${chip.value}')`}
          x-bind:style={`filterType === '${chip.value}' ? { color: '${tokens.color.cream}', background: '${chip.color}', border: '1px solid ${chip.color}' } : { color: '${tokens.color.ink3}', background: '#fff', border: '1px solid ${tokens.color.edge}' }`}
          style={{
            fontFamily: tokens.font.body,
            fontSize: 11.5,
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "5px 12px",
            borderRadius: tokens.radius.pill,
            cursor: "pointer",
          }}
        >
          {chip.value !== "" && (
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: chip.color,
                display: "inline-block",
              }}
            />
          )}
          {chip.label} <span x-text={chip.count} />
        </button>
      ))}
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: tokens.color.ink3,
          flexShrink: 0,
          marginLeft: "6px",
        }}
      >
        Status
      </span>
      {STATUS_CHIPS.map((chip) => (
        <button
          key={chip.value}
          type="button"
          class="memory-status-chip"
          x-on:click={`setFilterStatus(filterStatus === '${chip.value}' ? '' : '${chip.value}')`}
          x-bind:style={`filterStatus === '${chip.value}' ? { color: '${tokens.color.cream}', background: '${chip.color}', border: '1px solid ${chip.color}' } : { color: '${tokens.color.ink3}', background: '#fff', border: '1px solid ${tokens.color.edge}' }`}
          style={{
            fontFamily: tokens.font.body,
            fontSize: 11.5,
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "5px 12px",
            borderRadius: tokens.radius.pill,
            cursor: "pointer",
          }}
        >
          <span
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              background: chip.color,
              display: "inline-block",
            }}
          />
          {chip.label}
        </button>
      ))}
      <button
        type="button"
        class="memory-sort-toggle"
        x-on:click="toggleSort()"
        x-text="'⇅ ' + sortLabel()"
        style={{
          marginLeft: "auto",
          fontFamily: tokens.font.body,
          fontSize: 11.5,
          fontWeight: 500,
          padding: "5px 13px",
          borderRadius: tokens.radius.pill,
          cursor: "pointer",
          background: "transparent",
          color: tokens.color.ink2,
          border: `1px solid ${tokens.color.edge}`,
        }}
      >
        ⇅ Newest → Oldest
      </button>
    </div>
  );
}
