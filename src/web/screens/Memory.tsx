// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */

import type { ChatSession } from "../../memory/memory";
import type { MemoryEvent } from "../../memory/memory-log";
import { ActiveReposPanel, type ActiveRepoView } from "../primitives/ActiveReposPanel";
import { MemoryAlpineRow } from "../primitives/MemoryAlpineRow";
import { MemoryByTypeCards } from "../primitives/MemoryByTypeCards";
import { MemoryComposer } from "../primitives/MemoryComposer";
import { MemoryFilterBar } from "../primitives/MemoryFilterBar";
import { MemoryModal } from "../primitives/MemoryModal";
import { ResolvedContextBadge, type ResolvedContextBadgeProps } from "../primitives/ResolvedContextBadge";
import { SinceYouLookedPanel } from "../primitives/SinceYouLookedPanel";
import { WorkingMemoryPanel } from "../primitives/WorkingMemoryPanel";
import { CANONICAL_NAV } from "../routes/nav";
import { Dashboard } from "../shells/Dashboard";
import { tokens } from "../tokens/tokens";

export interface MemoryProps {
  events: MemoryEvent[];
  secret: string;
  /** Recent chat sessions — display-only working memory (rail + island recall). */
  recentChats: ChatSession[];
  /** Per-project digests (joined to their repo-graph card) for the "active
   *  repos" rail. Optional — defaults to empty so existing callers/tests work. */
  activeProjects?: ActiveRepoView[];
  /** project_id of the repo the daemon is currently rooted in. */
  currentProjectId?: string;
  /** OS home dir, for path collapsing in the rail. */
  homeDir?: string;
  /** The daemon's per-request project resolution (source/display_name/proj_hash)
   *  — see `src/daemon/project-context.ts`. Optional so existing callers/tests
   *  that don't pass it still render (badge is simply omitted). */
  resolvedProject?: ResolvedContextBadgeProps;
}

/** Compact, client-safe projection of chat sessions for the island. */
function recentChatsForClient(
  recentChats: ChatSession[],
): Array<{ id: string; summary: string; started_at: string; message_count: number }> {
  return recentChats.map((c) => ({
    id: c.id,
    summary: c.summary || "(no summary)",
    started_at: c.started_at,
    message_count: c.message_count,
  }));
}

const tabBase = {
  fontFamily: tokens.font.body,
  fontSize: 12,
  fontWeight: 600,
  border: "none",
  borderRadius: "7px",
  padding: "6px 14px",
  cursor: "pointer",
} as const;

/** Empty-state row shared by the timeline and by-entity streams — same
 * markup, only the Alpine x-show guard (which "is empty" check) differs. */
function StreamEmptyState({ showWhen }: { showWhen: string }) {
  return (
    <div
      class="memory-empty-state"
      x-show={showWhen}
      x-text="emptyMessage()"
      style={{
        padding: "32px 16px",
        textAlign: "center",
        color: tokens.color.ink3,
        fontFamily: tokens.font.mono,
        fontSize: 12,
      }}
    />
  );
}

/**
 * One date-grouped row of the memory stream — used by both the TIMELINE
 * view (`groups()`, with the "group.sub" relative-time span) and the
 * BY-ENTITY view (`byEntityGroups()`, no sub span). References `group` /
 * `event` from the enclosing Alpine `x-for` scope, not JS props — this is
 * server-rendered markup, the Alpine expressions are identical either way.
 */
function DateGroupRow({ showSub }: { showSub: boolean }) {
  return (
    <div style={{ marginBottom: "6px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          margin: "14px 0 12px",
        }}
      >
        <span
          x-text="group.label"
          style={{
            fontFamily: tokens.font.display,
            fontSize: 14,
            fontWeight: 600,
            color: tokens.color.ink3,
          }}
        />
        {showSub && (
          <span
            x-text="group.sub"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.dateGroupSubInk,
            }}
          />
        )}
        <div style={{ flex: 1, height: "1px", background: tokens.color.dateGroupDivider }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "13px" }}>
        <template x-for="event in group.items" x-bind:key="event.id">
          <MemoryAlpineRow />
        </template>
      </div>
    </div>
  );
}

export function Memory({
  events,
  secret,
  recentChats,
  activeProjects = [],
  currentProjectId = "",
  homeDir = "",
  resolvedProject,
}: MemoryProps) {
  return (
    <Dashboard activeSection="memory" navSections={CANONICAL_NAV}>
      {/* x-data="memoryBook" — Alpine island (global bundle), on the outer
          container so the right rail (a sibling of the main column) can read
          `view` and stay stream-only via x-show.
          data-memories / data-recent-chats: SSR hydration.
          data-secret: for the composer's retire API call. */}
      <div
        x-data="memoryBook"
        data-memories={JSON.stringify(events)}
        data-recent-chats={JSON.stringify(recentChatsForClient(recentChats))}
        data-secret={secret}
        class="memory-book"
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100%",
          padding: "22px 34px 0",
          boxSizing: "border-box",
          maxWidth: "1320px",
          margin: "0 auto",
        }}
      >
        {/* ── header (full width) ── */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: "20px",
              flexWrap: "wrap",
              paddingBottom: "16px",
              borderBottom: `1px solid ${tokens.color.edge}`,
              marginBottom: "16px",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 11,
                  letterSpacing: "0.13em",
                  color: tokens.color.ink3,
                  textTransform: "uppercase",
                  marginBottom: "6px",
                }}
              >
                MEMORY · everything siltpoke has learned
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "11px" }}>
                {resolvedProject && (
                  <ResolvedContextBadge
                    source={resolvedProject.source}
                    displayName={resolvedProject.displayName}
                    projHash={resolvedProject.projHash}
                  />
                )}
                <span style={{ fontSize: 21 }}>📖</span>
                <h1
                  style={{
                    margin: 0,
                    fontFamily: tokens.font.display,
                    fontSize: 30,
                    fontWeight: 600,
                    letterSpacing: "-0.3px",
                    lineHeight: 1,
                    color: tokens.color.ink,
                  }}
                >
                  Memory Book
                </h1>
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: tokens.color.ink2,
                  lineHeight: 1.5,
                  marginTop: "7px",
                }}
              >
                Everything siltpoke remembers, oldest to newest —{" "}
                <b style={{ color: tokens.color.ink }}>when</b>,{" "}
                <b style={{ color: tokens.color.ink }}>what</b>,{" "}
                <b style={{ color: tokens.color.ink }}>why</b>, and{" "}
                <b style={{ color: tokens.color.ink }}>which type</b>.
              </div>
            </div>
            {/* view toggle */}
            <div
              class="memory-view-toggle"
              style={{
                display: "flex",
                background: tokens.color.paper,
                border: `1px solid ${tokens.color.edge}`,
                borderRadius: "9px",
                padding: "3px",
                gap: "2px",
              }}
            >
              <button
                type="button"
                class="memory-view-btn"
                x-on:click="setView('timeline')"
                x-bind:style={`view === 'timeline' ? { background: '${tokens.color.ink}', color: '${tokens.color.cream}' } : { background: 'transparent', color: '${tokens.color.ink3}' }`}
                style={tabBase}
              >
                Timeline
              </button>
              <button
                type="button"
                class="memory-view-btn"
                x-on:click="setView('byType')"
                x-bind:style={`view === 'byType' ? { background: '${tokens.color.ink}', color: '${tokens.color.cream}' } : { background: 'transparent', color: '${tokens.color.ink3}' }`}
                style={tabBase}
              >
                By type
              </button>
              {/* 实体 (entity) view hidden — button removed from selector.
                  Restore this block to re-expose the entity tab. */}
            </div>
          </div>

          {/* ── body: main column + stream-only rail (grows to push the
              by-type composer to the true window bottom) ── */}
          <div style={{ display: "flex", gap: "24px", alignItems: "flex-start", flex: 1, width: "100%" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
          {/* ── TIMELINE VIEW ── */}
          <div x-show="view === 'timeline'" style={{ paddingBottom: "40px" }}>
            <MemoryFilterBar />
            <div class="memory-timeline">
              <StreamEmptyState showWhen="filteredMemories().length === 0" />
              {/* date-grouped stream */}
              <template x-for="group in groups()" x-bind:key="group.date">
                <DateGroupRow showSub={true} />
              </template>
              {/* footer — x-show on the wrapper; the flex row lives on an inner
                  div so Alpine's display-restore doesn't drop it to block. */}
              <div x-show="filteredMemories().length > 0">
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    marginTop: "20px",
                    paddingLeft: "54px",
                  }}
                >
                  <div
                    style={{
                      width: "11px",
                      height: "11px",
                      borderRadius: "50%",
                      border: `2px dashed ${tokens.color.bookPendingBorder}`,
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 11.5, color: tokens.color.ink3, fontStyle: "italic" }}>
                    The book is still being written — every time siltpoke learns something, a new page is added here.
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ── BY-TYPE VIEW ── (active-repos banner + type cards; composer docked below) */}
          <div x-show="view === 'byType'" x-cloak>
            {/* flex column on an inner wrapper — x-show owns `display` on its own node */}
            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              <MemoryByTypeCards />
              {/* "Since you last looked" — current-repo discovery panel
                  (slice ③, task 6). Only mounted once a repo has actually
                  resolved; the island's own defensive branch handles "" but
                  there's no reason to render the shell for a session with
                  no repo context at all. */}
              {resolvedProject?.projHash ? (
                <SinceYouLookedPanel projHash={resolvedProject.projHash} />
              ) : null}
              <ActiveReposPanel
                activeProjects={activeProjects}
                currentProjectId={currentProjectId}
                homeDir={homeDir}
                now={new Date()}
                // Switching stays on /memory — the panel's rows describe each
                // repo's memory, so "read that one instead" means this page
                // about that repo, not a different page entirely.
                switchPath="/memory"
              />
            </div>
          </div>

          {/* ── BY-ENTITY VIEW ── (Task 6: groups facts via shared groupByEntity)
              x-if (not x-show): the entity tab was removed in #182, so `view` is
              never 'entity'. Under x-show the block stayed in the DOM (display:none)
              and its x-for still rendered a duplicate .memory-row / .memory-timeline
              / .memory-empty-state for every fact — doubling every row and breaking
              memory-book e2e strict-mode/row-count assertions. x-if unmounts it so a
              hidden view renders nothing; restoring the tab re-enables it unchanged. */}
          <template x-if="view === 'entity'">
            <div x-cloak style={{ paddingBottom: "40px" }}>
            <div class="memory-timeline">
              <StreamEmptyState showWhen="byEntityGroups().length === 0" />
              <template x-for="group in byEntityGroups()" x-bind:key="group.key">
                <DateGroupRow showSub={false} />
              </template>
            </div>
          </div>
          </template>
            </div>

            {/* Display-only working-memory rail — stream view only (SSR). */}
            <div x-show="view === 'timeline'">
              <WorkingMemoryPanel recentChats={recentChats} />
            </div>
          </div>

          {/* docked NL composer — by-type view only. A top margin separates it
              from the cards above so it reads as anchored at the bottom. */}
          <div x-show="view === 'byType'" x-cloak style={{ marginTop: "28px" }}>
            <MemoryComposer />
          </div>

          {/* modal + toast */}
          <MemoryModal />
          <div
            class="memory-toast"
            x-show="toast !== null"
            x-cloak
            x-text="toast"
            style={{
              position: "fixed",
              bottom: "96px",
              right: "36px",
              zIndex: 60,
              background: tokens.color.ink,
              color: tokens.color.cream,
              fontSize: 12.5,
              fontWeight: 500,
              padding: "10px 16px",
              borderRadius: "9px",
              boxShadow: tokens.shadow.lg,
            }}
          />
        </div>
    </Dashboard>
  );
}
