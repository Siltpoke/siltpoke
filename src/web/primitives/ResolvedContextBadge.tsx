// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import type { DaemonProjectSource } from "../../memory/active-project";

export interface ResolvedContextBadgeProps {
  /** How the daemon's per-request resolver arrived at this project — see
   *  `src/memory/active-project.ts` `resolveDaemonProject`. */
  source: DaemonProjectSource;
  /** Project display name, or null when no project resolved (`none`/`stale`). */
  displayName: string | null;
  /** Full repo-graph proj_hash; only the first 7 chars are rendered. */
  projHash: string | null;
}

/**
 * Small house-style pill (mirrors FactoidPanel) that makes the daemon's
 * per-request project resolution VISIBLE — which project a page resolved to,
 * and how (explicit ?repo=, sticky pin, recency guess, a dead pin, or none).
 * A wrong or empty resolution should be obvious at a glance rather than
 * silently rendering the wrong scope's data.
 */
export function ResolvedContextBadge(props: ResolvedContextBadgeProps) {
  const { source, displayName, projHash } = props;
  const label =
    displayName ??
    (source === "stale" ? "this project no longer exists" : "no active project");

  return (
    <div
      class="resolved-context-badge"
      title={projHash ?? undefined}
      style={{
        display: "inline-flex",
        gap: 6,
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: tokens.radius.sm,
        background: tokens.color.paper,
        border: `1px solid ${tokens.color.edge}`,
        fontFamily: tokens.font.body,
        fontSize: 11,
        color: tokens.color.ink3,
      }}
    >
      <span class="resolved-context-badge__name">{label}</span>
      {projHash ? (
        <span class="resolved-context-badge__hash" style={{ opacity: 0.6 }}>
          {projHash.slice(0, 7)}
        </span>
      ) : null}
      <span class="resolved-context-badge__source" style={{ opacity: 0.6 }}>
        · {source}
      </span>
    </div>
  );
}
