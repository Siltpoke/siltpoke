// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { SectionHead } from "../atoms/SectionHead";
import { TimelineEvent } from "../primitives/TimelineEvent";
import { EmptyPlaceholder } from "../primitives/EmptyPlaceholder";
import type { TimelineTone } from "../primitives/TimelineEvent";

export interface TimelineEventData {
  time: string;
  title: string;
  body?: string;
  tone?: TimelineTone;
}

export interface TimelineProps {
  events: TimelineEventData[];
  title?: string;
  emptyArt?: Child;
  emptySub?: string;
}

export function Timeline(props: TimelineProps) {
  const {
    events,
    title,
    emptyArt,
    emptySub = "no events yet",
  } = props;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {title && (
        <div style={{ padding: "14px 16px 8px", flexShrink: 0 }}>
          <SectionHead title={title} kicker="TIMELINE" />
        </div>
      )}

      {/* Scrollable body — explicit height: 0 + flex:1 so vertical lines resolve */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "8px 16px",
        }}
      >
        {events.length === 0 ? (
          <EmptyPlaceholder
            art={emptyArt}
            headline="nothing here yet"
            sub={emptySub}
          />
        ) : (
          events.map((event, i) => (
            <div
              key={`${event.time}-${i}`}
              style={{ height: "auto" }}
            >
              <TimelineEvent
                time={event.time}
                title={event.title}
                body={event.body}
                tone={event.tone}
                isLast={i === events.length - 1}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
