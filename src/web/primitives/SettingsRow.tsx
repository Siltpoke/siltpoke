// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface SettingsRowProps {
  label: string;
  sub?: string;
  value?: string;
  right?: Child;
  inline?: boolean;
  mono?: boolean;
  /**
   * Suppress the top divider line in stacked mode. List shells set
   * this on the first row in a list so the list's outer Card doesn't
   * show a stray hairline against its interior padding. Default false.
   */
  firstRow?: boolean;
}

export function SettingsRow(props: SettingsRowProps) {
  const {
    label,
    sub,
    value,
    right,
    inline = false,
    mono = false,
    firstRow = false,
  } = props;

  if (inline) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
        }}
      >
        <span
          style={{
            fontFamily: tokens.font.body,
            fontSize: 13,
            color: tokens.color.ink3,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: mono ? tokens.font.mono : tokens.font.body,
            fontSize: 13,
            color: tokens.color.ink,
          }}
        >
          {value}
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        borderTop: firstRow ? "none" : `1px solid ${tokens.color.edge}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: tokens.color.ink,
            fontFamily: tokens.font.body,
            fontWeight: 500,
          }}
        >
          {label}
        </div>
        {sub && (
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10.5,
              color: tokens.color.ink3,
              marginTop: 2,
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {value && (
        <span
          style={{
            fontFamily: mono ? tokens.font.mono : tokens.font.body,
            fontSize: 13,
            color: tokens.color.ink,
          }}
        >
          {value}
        </span>
      )}
      {right}
    </div>
  );
}
