// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * RepoMemoryPanel — compact card showing repo-memory index stats.
 *
 * Reads ~/.siltpoke/repo-memory/index.json. Shows: files indexed count,
 * top convention by confidence. Falls back to CTA when no index exists.
 */
import { tokens } from "../tokens/tokens";

export interface RepoMemoryStats {
  files: number;
  topConvention: { id: string; confidence: number } | null;
}

export interface RepoMemoryPanelProps {
  repoMemoryStats: RepoMemoryStats | null;
}

export function RepoMemoryPanel({ repoMemoryStats }: RepoMemoryPanelProps) {
  return (
    <div
      class="repo-memory-panel"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.paper,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          REPO MEMORY
        </span>
        <a
          href="/repo-memory"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.sky,
            textDecoration: "none",
          }}
        >
          view →
        </a>
      </div>

      {repoMemoryStats === null ? (
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          Run /repo-memory to build
        </div>
      ) : (
        <>
          {/* Files indexed */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: tokens.font.mono,
              fontSize: 10,
            }}
          >
            <span style={{ color: tokens.color.ink3 }}>files indexed</span>
            <span style={{ color: tokens.color.ink2 }}>{repoMemoryStats.files}</span>
          </div>

          {/* Top convention */}
          {repoMemoryStats.topConvention !== null ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontFamily: tokens.font.mono,
                fontSize: 10,
              }}
            >
              <span style={{ color: tokens.color.ink3 }}>
                {repoMemoryStats.topConvention.id}
              </span>
              <span style={{ color: tokens.color.ink2 }}>
                {Math.round(repoMemoryStats.topConvention.confidence * 100)}%
              </span>
            </div>
          ) : (
            <div
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
              }}
            >
              no conventions yet
            </div>
          )}
        </>
      )}
    </div>
  );
}
