// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Diff renderer — JSX components consuming the parse layer.
 *
 * Extracted from src/web/screens/critic/diff.tsx.
 */
import { tokens } from "../../../tokens/tokens";
import type { CriticCall } from "../../../../state/api";
import {
  parseDiffFiles,
  parseHunks,
  alignHunkSides,
  type SideRow,
} from "./parse";

export function DiffSummaryView({ summary }: { summary: NonNullable<CriticCall["diff_summary"]> }) {
  const enumeratedCount = summary.files_with_purpose.length;
  const mismatch = summary.file_count > 0 && enumeratedCount !== summary.file_count;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {mismatch && (
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.terra,
            padding: "4px 8px",
            border: `1px solid ${tokens.color.terra}`,
            borderRadius: tokens.radius.sm,
            background: tokens.color.paper,
          }}
        >
          ⚠ summary lists {enumeratedCount} file{enumeratedCount === 1 ? "" : "s"} but Haiku reports {summary.file_count} changed — summary may be incomplete.
        </div>
      )}
      <div
        style={{
          fontFamily: tokens.font.body,
          fontSize: 13,
          color: tokens.color.ink,
          lineHeight: 1.55,
        }}
      >
        <span style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3, textTransform: "uppercase", letterSpacing: "0.06em", marginRight: 8 }}>intent</span>
        {summary.intent}
      </div>
      {summary.key_changes.length > 0 && (
        <div>
          <div style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            key changes
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: tokens.font.body, fontSize: 12, color: tokens.color.ink, lineHeight: 1.6 }}>
            {summary.key_changes.map((k, i) => <li key={i}>{k}</li>)}
          </ul>
        </div>
      )}
      {summary.risks.length > 0 && (
        <div>
          <div style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.terra, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            risks
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: tokens.font.body, fontSize: 12, color: tokens.color.ink, lineHeight: 1.6 }}>
            {summary.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
      {summary.files_with_purpose.length > 0 && (
        <div>
          <div style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
            files ({enumeratedCount}{summary.file_count > 0 && summary.file_count !== enumeratedCount ? ` of ${summary.file_count}` : ""})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {summary.files_with_purpose.map((f, i) => (
              <div key={i} style={{ display: "flex", gap: 12, fontFamily: tokens.font.mono, fontSize: 11, color: tokens.color.ink2 }}>
                <span style={{ minWidth: 240, color: tokens.color.ink, fontWeight: 500 }}>{f.path}</span>
                <span style={{ color: tokens.color.ink3, flex: 1 }}>{f.purpose}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function DiffView({ text }: { text: string }) {
  const files = parseDiffFiles(text);
  if (files.length === 0) {
    return (
      <pre
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink3,
          background: tokens.color.cream,
          padding: 10,
          margin: 0,
          whiteSpace: "pre-wrap",
          lineHeight: 1.5,
        }}
      >
        (empty diff)
      </pre>
    );
  }
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Summary header — files changed + total additions/deletions */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink2,
        }}
      >
        <span>{files.length} file{files.length === 1 ? "" : "s"} changed</span>
        <span style={{ color: tokens.color.moss, fontWeight: 600 }}>+{totalAdd}</span>
        <span style={{ color: tokens.color.terra, fontWeight: 600 }}>−{totalDel}</span>
      </div>
      {/* Per-file rows — collapsed by default; <details> handles open/close
          natively via the <summary> click target. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {files.map((f, i) => (
          <details
            key={`${i}-${f.path}`}
            class="critic-diff-file"
            style={{
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.edge}`,
              background: tokens.color.paper,
              overflow: "hidden",
            }}
          >
            <summary
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "6px 10px",
                cursor: "pointer",
                fontFamily: tokens.font.mono,
                fontSize: 11,
                color: tokens.color.ink2,
                userSelect: "none",
              }}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: tokens.color.ink, fontWeight: 500 }}>{f.path}</span>
              <span style={{ color: tokens.color.moss, fontWeight: 600, minWidth: 36, textAlign: "right" }}>+{f.additions}</span>
              <span style={{ color: tokens.color.terra, fontWeight: 600, minWidth: 36, textAlign: "right" }}>−{f.deletions}</span>
            </summary>
            <SplitFileBody path={f.path} body={f.body} />
          </details>
        ))}
      </div>
    </div>
  );
}

const SIDE_BG: Record<SideRow["kind"], string> = {
  del: "rgba(214, 100, 100, 0.18)",
  add: "rgba(140, 168, 100, 0.20)",
  empty: "rgba(120, 120, 120, 0.06)",
  ctx: "transparent",
};

function sideFg(kind: SideRow["kind"]): string {
  if (kind === "del") return tokens.color.terra;
  if (kind === "add") return tokens.color.moss;
  return tokens.color.ink;
}

function SideCell({ rows, side }: { rows: SideRow[]; side: "left" | "right" }) {
  return (
    <div
      style={{
        minWidth: 0,
        fontFamily: tokens.font.mono,
        fontSize: 11,
        lineHeight: 1.5,
        overflowX: "auto",
        borderLeft: side === "right" ? `1px solid ${tokens.color.edge}` : "none",
      }}
    >
      {rows.map((r, i) => (
        <div
          key={`${side}-${i}`}
          style={{
            display: "grid",
            gridTemplateColumns: "44px 1fr",
            background: SIDE_BG[r.kind],
            color: sideFg(r.kind),
            whiteSpace: "pre",
          }}
        >
          <span
            style={{
              textAlign: "right",
              paddingRight: 8,
              color: tokens.color.ink3,
              userSelect: "none",
              borderRight: `1px solid ${tokens.color.edge}`,
            }}
          >
            {r.no ?? ""}
          </span>
          <span style={{ paddingLeft: 8 }}>{r.text || " "}</span>
        </div>
      ))}
    </div>
  );
}

function FallbackPre({ body }: { body: string }) {
  return (
    <pre
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 11,
        color: tokens.color.ink,
        background: tokens.color.cream,
        borderTop: `1px solid ${tokens.color.edge}`,
        padding: 10,
        margin: 0,
        whiteSpace: "pre",
        overflowX: "auto",
        maxHeight: 420,
        overflowY: "auto",
        lineHeight: 1.45,
      }}
    >
      {colorizeDiffLines(body)}
    </pre>
  );
}

function SplitFileBody({ path, body }: { path: string; body: string }) {
  const hunks = parseHunks(body);
  if (hunks.length === 0) return <FallbackPre body={body} />;
  return (
    <div
      style={{
        borderTop: `1px solid ${tokens.color.edge}`,
        background: tokens.color.cream,
        maxHeight: 520,
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink3,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          background: tokens.color.paper,
          borderBottom: `1px solid ${tokens.color.edge}`,
        }}
      >
        <div style={{ padding: "4px 12px" }}>{path} · before</div>
        <div style={{ padding: "4px 12px", borderLeft: `1px solid ${tokens.color.edge}` }}>
          {path} · after
        </div>
      </div>
      {hunks.map((h, i) => {
        const { left, right } = alignHunkSides(h);
        return (
          <div key={i}>
            <div
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                padding: "3px 12px",
                background: tokens.color.paper,
                borderTop: i > 0 ? `1px solid ${tokens.color.edge}` : "none",
                borderBottom: `1px solid ${tokens.color.edge}`,
              }}
            >
              {h.header}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
              <SideCell rows={left} side="left" />
              <SideCell rows={right} side="right" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function classifyDiffLineColor(line: string): string {
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff --git") ||
    line.startsWith("index ")
  ) {
    return tokens.color.ink3;
  }
  if (line.startsWith("@@")) return tokens.color.amber;
  if (line.startsWith("+")) return tokens.color.moss;
  if (line.startsWith("-")) return tokens.color.terra;
  return tokens.color.ink;
}

/**
 * Render a unified-diff string as colored line spans:
 *   "+ ..." → moss green
 *   "- ..." → terra red
 *   "@@ ..." → amber (hunk header)
 *   "diff --git" / "index" / "+++" / "---" → ink3 muted (file header)
 */
function colorizeDiffLines(text: string) {
  return text.split("\n").map((line, i) => (
    <span key={i} style={{ color: classifyDiffLineColor(line), display: "block" }}>
      {line || " "}
    </span>
  ));
}
