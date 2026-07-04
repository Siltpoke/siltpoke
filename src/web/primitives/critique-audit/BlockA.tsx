// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Block A — WHAT I READ
 *
 * Surfaces the inputs the critic considered before forming its verdict:
 * changed files, user raw query, agent reply, diff intent.
 *
 * Extracted from CritiqueAuditBlocks.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { V2SidecarData } from "../../../state/api";
import type { CriticCall } from "../../../state/api";
import {
  AuditSection,
  PlaceholderNote,
  MonoBlock,
  V2_MISSING_NOTE,
} from "./shared";

export interface BlockAProps {
  v2: V2SidecarData | null;
  c: CriticCall;
  /**
   * Label for the agent-reply block. Default keeps the legacy /history
   * wording; /timeline passes an honesty-caveated label ("opening") because
   * capture stores only the reply's FIRST PARAGRAPH capped at 1200 chars
   * (src/critic/capture.ts) — it was never the full verbatim reply.
   */
  agentReplyLabel?: string;
}

/**
 * Redact absolute paths into project-relative or home-relative form:
 *   "${cwd}/src/foo.ts"            → "src/foo.ts"
 *   "/Users/{user}/.claude/x.json" → "~/.claude/x.json"
 *   "/dev/null", "<unknown>"       → unchanged
 *
 * Pure prefix-strip — no path normalization beyond what the input has.
 */
export function redactPath(p: string, cwd: string | null | undefined): string {
  if (!p) return p;
  if (cwd && cwd.length > 0) {
    const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (p.startsWith(prefix)) return p.slice(prefix.length);
    if (p === cwd) return ".";
  }
  const homeMatch = p.match(/^\/(?:Users|home)\/[^/]+\//);
  if (homeMatch) return `~/${p.slice(homeMatch[0].length)}`;
  return p;
}

export function BlockA({ v2, c, agentReplyLabel = "agent reply (verbatim)" }: BlockAProps) {
  if (!v2) {
    return (
      <AuditSection id="A" label="A · WHAT I READ">
        <PlaceholderNote text={V2_MISSING_NOTE} />
      </AuditSection>
    );
  }

  const cwd = c.cwd ?? null;
  const changedFiles = v2.changed_files;

  return (
    <AuditSection id="A" label="A · WHAT I READ">
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.ink3,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          changed files
        </span>
        {changedFiles.length > 0 ? (
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink2,
              background: tokens.color.paper,
              border: `1px solid ${tokens.color.edge}`,
              borderRadius: tokens.radius.sm,
              padding: "5px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {changedFiles.slice(0, 30).map((f, i) => (
              <span key={i} title={f}>{redactPath(f, cwd)}</span>
            ))}
            {changedFiles.length > 30 && (
              <span style={{ color: tokens.color.ink3 }}>
                … and {changedFiles.length - 30} more
              </span>
            )}
          </div>
        ) : (
          <PlaceholderNote text="no changed files recorded (older entry or non-code change)" />
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.ink3,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          user raw query (verbatim)
        </span>
        {v2.user_raw_query ? (
          <MonoBlock>{v2.user_raw_query}</MonoBlock>
        ) : (
          <PlaceholderNote text="not captured — older critique" />
        )}
      </div>

      {v2.agent_reply && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9,
              color: tokens.color.ink3,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {agentReplyLabel}
          </span>
          <MonoBlock>{v2.agent_reply}</MonoBlock>
        </div>
      )}

      {v2.diff_intent && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9,
              color: tokens.color.ink3,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            diff intent (haiku pre-pass)
          </span>
          <MonoBlock>{v2.diff_intent}</MonoBlock>
        </div>
      )}

      {!v2.diff_intent && c.diff_summary?.intent && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9,
              color: tokens.color.ink3,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            diff intent (haiku pre-pass)
          </span>
          <MonoBlock>{c.diff_summary.intent}</MonoBlock>
        </div>
      )}
    </AuditSection>
  );
}
