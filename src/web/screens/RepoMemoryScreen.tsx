// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * RepoMemoryScreen — /repo-memory
 *
 * Shows repo-memory index summary: file count, conventions, last built.
 * "Build now" button POSTs to /api/repo-memory/build.
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { tokens } from "../tokens/tokens";
import type { RepoMemoryIndex } from "../../repo-memory/types";

export interface RepoMemoryScreenProps {
  index: RepoMemoryIndex | null;
  /**
   * The page's resolved proj_hash — baked into the build form's `action`
   * URL as `?repo=` so `POST /api/repo-memory/build` has an explicit
   * target. The API route's write guard rejects a bare POST that resolves
   * only to a recency guess (source "recent") or nothing (source "none");
   * this is what lets a build from this page count as "explicit" instead.
   */
  projHash?: string | null;
}

export function RepoMemoryScreen({ index, projHash }: RepoMemoryScreenProps) {
  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="repo-memory">
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
            REPO MEMORY · {index ? `${index.files.length} files` : "not built"}
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
            Repo Memory
          </h1>
          <div style={{ fontFamily: tokens.font.body, fontSize: 13, color: tokens.color.ink3 }}>
            Indexed conventions + file summaries for review context
          </div>
        </div>

        {index === null ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              border: `1px dashed ${tokens.color.edge}`,
              borderRadius: tokens.radius.md,
              marginBottom: 20,
            }}
          >
            <div
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 12,
                color: tokens.color.ink3,
                marginBottom: 12,
              }}
            >
              Run build to create repo-memory index
            </div>
            {/*
              Query string, not a hidden field: a plain (or hx-boosted)
              POST form sends its fields in the request body, but the API
              route reads the target project from `c.req.query("repo")` —
              the same convention every other ?repo= consumer in this app
              uses (repo-graph, memory-log, explain). Baking the hash into
              the action URL is what actually reaches the route.
            */}
            <form
              method="post"
              action={projHash ? `/api/repo-memory/build?repo=${encodeURIComponent(projHash)}` : "/api/repo-memory/build"}
            >
              <button
                type="submit"
                style={{
                  padding: "8px 20px",
                  fontFamily: tokens.font.mono,
                  fontSize: 12,
                  background: tokens.color.sky,
                  color: tokens.color.onSky,
                  border: "none",
                  borderRadius: tokens.radius.sm,
                  cursor: "pointer",
                }}
              >
                Build now
              </button>
            </form>
          </div>
        ) : (
          <>
            {/* Stats strip */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 8,
                marginBottom: 20,
              }}
            >
              {[
                { label: "Files indexed", value: String(index.files.length) },
                {
                  label: "Conventions",
                  value: String(index.conventions.length),
                },
                {
                  label: "Built at",
                  value: new Date(index.built_at).toLocaleString(),
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
                      fontSize: label === "Built at" ? 12 : 20,
                      color: tokens.color.ink,
                    }}
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>

            {/* Conventions */}
            {index.conventions.length > 0 && (
              <div style={{ marginBottom: 20 }}>
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
                  Conventions detected
                </div>
                {index.conventions.map((conv) => (
                  <div
                    key={conv.id}
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
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: tokens.font.mono,
                          fontSize: 11,
                          color: tokens.color.sky,
                        }}
                      >
                        {conv.id}
                      </span>
                      <span
                        style={{
                          fontFamily: tokens.font.mono,
                          fontSize: 11,
                          color:
                            conv.confidence >= 0.8
                              ? tokens.color.moss
                              : tokens.color.amber,
                        }}
                      >
                        {Math.round(conv.confidence * 100)}% confidence
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
                      {conv.description}
                    </div>
                    {conv.example_files.length > 0 && (
                      <div
                        style={{
                          fontFamily: tokens.font.mono,
                          fontSize: 10,
                          color: tokens.color.ink3,
                        }}
                      >
                        e.g. {conv.example_files.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Build now button */}
            {/*
              Query string, not a hidden field: a plain (or hx-boosted)
              POST form sends its fields in the request body, but the API
              route reads the target project from `c.req.query("repo")` —
              the same convention every other ?repo= consumer in this app
              uses (repo-graph, memory-log, explain). Baking the hash into
              the action URL is what actually reaches the route.
            */}
            <form
              method="post"
              action={projHash ? `/api/repo-memory/build?repo=${encodeURIComponent(projHash)}` : "/api/repo-memory/build"}
            >
              <button
                type="submit"
                style={{
                  padding: "6px 16px",
                  fontFamily: tokens.font.mono,
                  fontSize: 12,
                  background: tokens.color.paper,
                  color: tokens.color.ink2,
                  border: `1px solid ${tokens.color.edge}`,
                  borderRadius: tokens.radius.sm,
                  cursor: "pointer",
                }}
              >
                Rebuild index
              </button>
            </form>
          </>
        )}
      </div>
    </Dashboard>
  );
}
