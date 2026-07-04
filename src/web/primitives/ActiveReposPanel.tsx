// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import type { ActiveProject } from "../../memory/project";
import type { RepoCard } from "../../repo-graph/repo-card";
import { relativeTime, shortenPath } from "./active-repos-format";

/** An active project plus its repo-graph card (null when never indexed). */
export type ActiveRepoView = ActiveProject & { repo?: RepoCard | null };

export interface ActiveReposPanelProps {
  activeProjects: ActiveRepoView[];
  /** project_id of the repo the daemon is currently rooted in — marked active. */
  currentProjectId: string;
  /** OS home dir, for path collapsing. */
  homeDir: string;
  /** Injectable clock for deterministic relative-time rendering / tests. */
  now: Date;
}

/** A distinct 5th accent (teal) so the card reads as a sibling of the four
 *  memory-type cards without colliding with semantic-blue / episodic-purple /
 *  procedural-green / working-terra. */
const REPO_THEME = {
  color: "#5e9ca3",
  gradient: "linear-gradient(165deg,#fffdf8,#edf3f2)",
  border: "#cdddd9",
  enColor: "#4f878d",
};

/** Repo-graph nodes glyph (matches the white-stroke-on-color icon style). */
const REPO_ICON = (
  <svg aria-hidden="true" width="17" height="17" viewBox="0 0 16 16" fill="none">
    <circle cx="4" cy="4.5" r="1.7" stroke="#fff" stroke-width="1.3" />
    <circle cx="12" cy="6" r="1.7" stroke="#fff" stroke-width="1.3" />
    <circle cx="6.5" cy="12" r="1.7" stroke="#fff" stroke-width="1.3" />
    <path
      d="M5.4 5.2 L10.6 5.7 M5.6 10.8 L10.9 7.3"
      stroke="#fff"
      stroke-width="1.2"
      stroke-linecap="round"
    />
  </svg>
);

/**
 * Right-rail "Active Repos" card — the other half of the working-memory rail
 * (companion to {@link WorkingMemoryPanel}). For each repo siltpoke has indexed,
 * a row expands (per-row inline Alpine toggle — no bound listeners, survives
 * hx-boost morph) to a repo-graph digest: a one-line "what this is" blurb plus
 * its architecture areas + components, all read $0 from the structural index.
 * A repo with no structural index shows an honest "not indexed" line.
 */
export function ActiveReposPanel({
  activeProjects,
  currentProjectId,
  homeDir,
  now,
}: ActiveReposPanelProps) {
  return (
    <div
      class="active-repos-panel memory-type-card bk-card"
      style={{
        position: "relative",
        width: "100%",
        boxSizing: "border-box",
        background: REPO_THEME.gradient,
        border: `1px solid ${REPO_THEME.border}`,
        borderRadius: "14px",
        padding: "17px",
        overflow: "hidden",
      }}
    >
      {/* left accent bar — matches the by-type cards */}
      <span
        aria-hidden="true"
        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "4px", background: REPO_THEME.color }}
      />

      {/* header — icon + title + mono subtitle + count, same shape as a type card */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "15px" }}>
        <span
          style={{
            width: "30px",
            height: "30px",
            borderRadius: "8px",
            background: REPO_THEME.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {REPO_ICON}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: tokens.color.ink }}>Active Repos</div>
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 8.5,
              letterSpacing: "0.5px",
              color: REPO_THEME.enColor,
            }}
          >
            REPOS · what siltpoke has indexed
          </div>
        </div>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: REPO_THEME.enColor,
            flexShrink: 0,
          }}
        >
          {activeProjects.length}
        </span>
      </div>

      {activeProjects.length === 0 ? (
        <p
          class="active-repos-empty"
          style={{
            fontSize: 11.5,
            color: tokens.color.ink3,
            fontStyle: "italic",
            lineHeight: 1.45,
            margin: 0,
          }}
        >
          No repos yet — projects appear here as siltpoke learns them
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "13px" }}>
          {activeProjects.map((p) => {
            const isCurrent = p.project_id === currentProjectId;
            const repo = p.repo ?? null;
            // Any INDEXED repo is expandable — even a structural-index-only repo (no
            // arch-model, no summary) must expand so the ✨ Generate-summary affordance is
            // reachable (it was hidden for exactly the repos that needed it). A never-indexed
            // repo (repo === null) stays non-expandable.
            const isIndexed = repo !== null;
            // Structural-index-only: indexed but no enriched arch-model + no summary yet.
            const structuralOnly =
              repo !== null && repo.areas.length === 0 && repo.components === 0 && repo.summary_text === null;

            return (
              <div
                class="active-repos-row"
                x-data="repoRow"
                data-project-root={p.project_root}
                data-summary={repo?.summary_text ?? ""}
              >
                <div
                  class="active-repos-head"
                  role={isIndexed ? "button" : undefined}
                  tabindex={isIndexed ? 0 : undefined}
                  x-on:click={isIndexed ? "open = !open" : undefined}
                  x-on:keydown={isIndexed ? "if (event.key === 'Enter') open = !open" : undefined}
                  style={{ display: "flex", gap: "8px", cursor: isIndexed ? "pointer" : "default" }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      flexShrink: 0,
                      marginTop: "2px",
                      fontSize: 10,
                      color: isCurrent ? tokens.color.terra : tokens.color.ink3,
                    }}
                  >
                    {isCurrent ? "◉" : "○"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: tokens.color.ink,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.display_name}
                      </span>
                      {isCurrent && (
                        <span
                          style={{
                            fontFamily: tokens.font.mono,
                            fontSize: 8.5,
                            color: tokens.color.terra,
                            flexShrink: 0,
                          }}
                        >
                          · active
                        </span>
                      )}
                      {isIndexed && (
                        <span
                          aria-hidden="true"
                          class="mono"
                          x-text="open ? '▾' : '▸'"
                          style={{
                            marginLeft: "auto",
                            fontSize: 9,
                            color: tokens.color.ink3,
                            flexShrink: 0,
                          }}
                        >
                          ▸
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 9.5,
                        color: tokens.color.ink3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {shortenPath(p.project_root, homeDir)}
                    </div>
                    <div
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 9.5,
                        color: tokens.color.ink3,
                        marginTop: "3px",
                      }}
                    >
                      {repo
                        ? `${repo.files.toLocaleString()} files · ${repo.components} components · indexed ${relativeTime(repo.indexed_at, now) || "unknown"}`
                        : "not indexed"}
                    </div>
                  </div>
                </div>

                {isIndexed && repo && (
                  <div x-show="open" x-cloak class="active-repos-detail">
                    {/* flex column on an inner wrapper — x-show owns `display`
                        on its own node, which would otherwise kill the flex gap. */}
                    <div
                      style={{
                        marginTop: "9px",
                        marginLeft: "18px",
                        paddingLeft: "11px",
                        borderLeft: `1px solid ${tokens.color.paperD}`,
                        display: "flex",
                        flexDirection: "column",
                        gap: "12px",
                      }}
                    >
                      {/* summary — reactive: the cached blurb (x-text), or an
                          on-demand "generate" button when none exists yet. */}
                      <div>
                        <div
                          class="active-repos-summary"
                          x-show="hasSummary()"
                          x-text="summary"
                          style={{
                            fontSize: 11.5,
                            color: tokens.color.ink2,
                            fontStyle: "italic",
                            lineHeight: 1.5,
                          }}
                        >
                          {repo.summary_text ?? ""}
                        </div>
                        <div
                          x-show="!hasSummary()"
                          x-cloak
                          style={{ display: "flex", flexDirection: "column", gap: "5px" }}
                        >
                          {structuralOnly && (
                            <span
                              class="active-repos-structural-hint"
                              style={{
                                fontSize: 11,
                                color: tokens.color.ink3,
                                fontStyle: "italic",
                                lineHeight: 1.45,
                              }}
                            >
                              Structural index only — generate a summary to learn what this repo is about.
                            </span>
                          )}
                          <button
                            type="button"
                            x-on:click="generate()"
                            x-bind:disabled="generating"
                            style={{
                              alignSelf: "flex-start",
                              fontFamily: tokens.font.mono,
                              fontSize: 10,
                              color: "#4f878d",
                              background: "#edf3f2",
                              border: "1px solid #cdddd9",
                              borderRadius: "6px",
                              padding: "4px 10px",
                              cursor: "pointer",
                            }}
                          >
                            <span x-show="!generating">✨ Generate summary</span>
                            <span x-show="generating" x-cloak>
                              generating…
                            </span>
                          </button>
                          <span
                            x-show="error"
                            x-cloak
                            x-text="error"
                            style={{ fontSize: 10, color: tokens.color.terra }}
                          />
                        </div>
                      </div>

                      {repo.areas.length > 0 && (
                        <div>
                          <div
                            style={{
                              fontFamily: tokens.font.mono,
                              fontSize: 8.5,
                              letterSpacing: "0.05em",
                              color: tokens.color.ink3,
                              textTransform: "uppercase",
                              marginBottom: "6px",
                            }}
                          >
                            {repo.areas.length} areas
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                            {repo.areas.map((a) => (
                              <span
                                class="mono ar-chip-area"
                                style={{
                                  fontSize: 9.5,
                                  color: "#6a5a48",
                                  background: "#f1ece2",
                                  border: "1px solid #e2d8c8",
                                  borderRadius: "5px",
                                  padding: "2px 7px",
                                }}
                              >
                                {a}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {repo.component_titles.length > 0 && (
                        <div>
                          <div
                            style={{
                              fontFamily: tokens.font.mono,
                              fontSize: 8.5,
                              letterSpacing: "0.05em",
                              color: tokens.color.ink3,
                              textTransform: "uppercase",
                              marginBottom: "6px",
                            }}
                          >
                            {repo.components} components
                          </div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                            {repo.component_titles.map((c) => (
                              <span
                                class="mono ar-chip"
                                style={{
                                  fontSize: 9.5,
                                  color: "#5a6a48",
                                  background: "#eef1e7",
                                  border: "1px solid #dde4d0",
                                  borderRadius: "5px",
                                  padding: "2px 7px",
                                }}
                              >
                                {c}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
