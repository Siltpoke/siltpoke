// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import { Dot } from "../atoms/Dot";

export type TimelineTone = "neutral" | "success" | "warn" | "danger";

export interface TimelineEventProps {
  time: string;
  title: string;
  body?: string;
  tone?: TimelineTone;
  isLast?: boolean;
}

const TONE_COLOR: Record<TimelineTone, string> = {
  neutral: tokens.color.ink3,
  success: tokens.color.moss,
  warn: tokens.color.amber,
  danger: tokens.color.terra,
};

export function TimelineEvent(props: TimelineEventProps) {
  const { time, title, body, tone = "neutral", isLast = false } = props;
  const dotColor = TONE_COLOR[tone];

  return (
    <div style={{ display: "flex", gap: 10 }}>
      {/* left column: dot + vertical line */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <Dot color={dotColor} size={8} />
        {!isLast && (
          <div
            style={{
              width: 1,
              flex: 1,
              background: tokens.color.edge,
              marginTop: 4,
            }}
          />
        )}
      </div>

      {/* right column: time + title + body */}
      <div style={{ paddingBottom: isLast ? 0 : 12, minWidth: 0 }}>
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10.5,
            color: tokens.color.ink3,
          }}
        >
          {time}
        </div>
        <div
          style={{
            fontFamily: tokens.font.body,
            fontSize: 13,
            color: tokens.color.ink,
            fontWeight: 600,
            marginTop: 2,
          }}
        >
          {title}
        </div>
        {body && (
          <div
            style={{
              fontFamily: tokens.font.body,
              fontSize: 12.5,
              color: tokens.color.ink2,
              lineHeight: 1.45,
              marginTop: 3,
            }}
          >
            {body}
          </div>
        )}
      </div>
    </div>
  );
}
