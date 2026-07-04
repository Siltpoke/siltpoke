// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * FewShotScreen — /few-shot
 *
 * Shows few-shot index stats + "Try a query" form.
 * When ?q= is present in the URL, shows top-k anti-example results.
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { tokens } from "../tokens/tokens";

export interface NeighborResult {
  id: string;
  critique_summary: string;
  reason_text: string | null;
  ts: string;
  similarity: number;
}

export interface FewShotScreenProps {
  totalEntries: number;
  embeddingDim: number;
  oldestTs: string | null;
  newestTs: string | null;
  query: string | null;
  neighbors: NeighborResult[];
}

export function FewShotScreen({
  totalEntries,
  embeddingDim,
  oldestTs,
  newestTs,
  query,
  neighbors,
}: FewShotScreenProps) {
  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="few-shot">
      <div style={{ padding: 16 }}>
        <div style={{ marginBottom: 16 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              display: "block",
              marginBottom: 4,
            }}
          >
            FEW-SHOT INDEX · {totalEntries} entries
          </span>
          <h1
            style={{
              margin: "0 0 4px",
              fontFamily: tokens.font.display,
              fontSize: 28,
              fontWeight: 400,
              color: tokens.color.ink,
              lineHeight: 1,
            }}
          >
            Anti-Example Index
          </h1>
          <div style={{ fontFamily: tokens.font.body, fontSize: 13, color: tokens.color.ink3 }}>
            Dismissed critiques indexed for few-shot retrieval
          </div>
        </div>

        {/* Stats strip */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 8,
            marginBottom: 20,
          }}
        >
          {[
            { label: "Entries", value: String(totalEntries) },
            { label: "Dim", value: String(embeddingDim) },
            {
              label: "Oldest",
              value: oldestTs
                ? new Date(oldestTs).toLocaleDateString()
                : "—",
            },
            {
              label: "Newest",
              value: newestTs
                ? new Date(newestTs).toLocaleDateString()
                : "—",
            },
          ].map(({ label, value }) => (
            <div
              key={label}
              style={{
                padding: "8px 12px",
                background: tokens.color.paper,
                border: `1px solid ${tokens.color.edge}`,
                borderRadius: tokens.radius.md,
              }}
            >
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink3,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 4,
                }}
              >
                {label}
              </div>
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 18,
                  color: tokens.color.ink,
                }}
              >
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* Query form */}
        <div
          style={{
            marginBottom: 20,
            padding: 16,
            background: tokens.color.paper,
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: tokens.radius.md,
          }}
        >
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 8,
            }}
          >
            Try a query
          </div>
          <form method="get" action="/few-shot" style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              name="q"
              defaultValue={query ?? ""}
              placeholder="describe a type of critique..."
              style={{
                flex: 1,
                padding: "6px 10px",
                fontFamily: tokens.font.mono,
                fontSize: 12,
                background: tokens.color.cream,
                border: `1px solid ${tokens.color.edge}`,
                borderRadius: tokens.radius.sm,
                color: tokens.color.ink,
                outline: "none",
              }}
            />
            <button
              type="submit"
              style={{
                padding: "6px 16px",
                fontFamily: tokens.font.mono,
                fontSize: 12,
                background: tokens.color.sky,
                color: tokens.color.ink,
                border: "none",
                borderRadius: tokens.radius.sm,
                cursor: "pointer",
              }}
            >
              Search
            </button>
          </form>
        </div>

        {/* Results */}
        {query !== null && (
          <div>
            <div
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 8,
                paddingBottom: 4,
                borderBottom: `1px solid ${tokens.color.edge}`,
              }}
            >
              Results for "{query}" — {neighbors.length} match{neighbors.length !== 1 ? "es" : ""}
            </div>
            {neighbors.length === 0 ? (
              <div
                style={{
                  padding: 16,
                  fontFamily: tokens.font.mono,
                  fontSize: 12,
                  color: tokens.color.ink3,
                }}
              >
                No anti-examples found (index too small or no matches above threshold).
              </div>
            ) : (
              neighbors.map((n, i) => (
                <div
                  key={`${n.id}-${i}`}
                  style={{
                    padding: "10px 12px",
                    marginBottom: 8,
                    background: tokens.color.paper,
                    border: `1px solid ${tokens.color.edge}`,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 11,
                        color: tokens.color.sky,
                      }}
                    >
                      {n.id}
                    </span>
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 11,
                        color: tokens.color.moss,
                        fontWeight: 600,
                      }}
                    >
                      sim {n.similarity.toFixed(3)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: tokens.font.body,
                      fontSize: 13,
                      color: tokens.color.ink,
                      marginBottom: 4,
                    }}
                  >
                    {n.critique_summary}
                  </div>
                  {n.reason_text && (
                    <div
                      style={{
                        fontFamily: tokens.font.body,
                        fontSize: 12,
                        color: tokens.color.ink3,
                        fontStyle: "italic",
                      }}
                    >
                      Dismissed: {n.reason_text}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </Dashboard>
  );
}
