// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import { Pill } from "../atoms/Pill";

export interface FactCardProps {
  id: string;
  text: string;
  age: string;
  confidence: number;
  goal?: boolean;
  constraint?: boolean;
  supersedes?: string;
  reason?: string;
  borderAccent?: string;
}

export function FactCard(props: FactCardProps) {
  const {
    id,
    text,
    age,
    confidence,
    goal,
    constraint,
    supersedes,
    reason,
    borderAccent = tokens.color.terra,
  } = props;

  const confColor =
    confidence >= 0.85
      ? tokens.color.moss
      : confidence >= 0.6
        ? tokens.color.amber
        : tokens.color.terra;

  return (
    <div
      style={{
        background: tokens.color.paper,
        border: `1px solid ${tokens.color.edge}`,
        borderLeft: `3px solid ${borderAccent}`,
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        boxShadow: tokens.shadow.sm,
      }}
    >
      {/* header: id + age */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <code
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          {id}
        </code>
        <span
          style={{
            marginLeft: "auto",
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          {age}
        </span>
      </div>

      {/* tag pills */}
      {(goal || constraint) && (
        <div style={{ display: "flex", gap: 4 }}>
          {goal && (
            <Pill border={tokens.color.terra} color={tokens.color.terra}>
              goal
            </Pill>
          )}
          {constraint && (
            <Pill border={tokens.color.sky} color={tokens.color.sky}>
              constraint
            </Pill>
          )}
        </div>
      )}

      {/* text */}
      <div
        style={{
          fontSize: 12.5,
          color: tokens.color.ink,
          fontFamily: tokens.font.body,
          lineHeight: 1.45,
        }}
      >
        {text}
      </div>

      {/* supersedes arrow */}
      {supersedes && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            background: tokens.color.cream,
            padding: "3px 6px",
            borderRadius: 4,
          }}
        >
          <span>↶ supersedes</span>
          <code style={{ color: tokens.color.terra }}>{supersedes}</code>
        </div>
      )}

      {/* retired reason */}
      {reason && (
        <div
          style={{
            fontSize: 11,
            color: tokens.color.ink3,
            lineHeight: 1.4,
            fontFamily: tokens.font.body,
            background: tokens.color.cream,
            border: `1px dashed ${tokens.color.edge}`,
            padding: "4px 6px",
            borderRadius: 4,
            fontStyle: "italic",
          }}
        >
          {reason}
        </div>
      )}

      {/* confidence bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            flex: 1,
            height: 4,
            background: tokens.color.paperD,
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${confidence * 100}%`,
              height: "100%",
              background: confColor,
            }}
          />
        </div>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: confColor,
            fontWeight: 600,
          }}
        >
          {confidence.toFixed(2)}
        </span>
      </div>
    </div>
  );
}
