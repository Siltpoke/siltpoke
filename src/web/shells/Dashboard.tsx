// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";
import { AppChrome } from "../atoms/AppChrome";
import { NavItem } from "../atoms/NavItem";
import { SectionLabel } from "../atoms/SectionLabel";
import type { Section } from "../client/stores/navState";
import { CANONICAL_NAV } from "../routes/nav";
import type { NavEntry, NavSection } from "../routes/nav";

/** Merge navMetaOverrides into a NavSection array, overriding each entry's meta. */
function applyNavMetaOverrides(
  sections: readonly NavSection[],
  overrides: Partial<Record<Section, string>>,
): NavSection[] {
  return sections.map((section) => ({
    ...section,
    entries: section.entries.map((entry) => {
      const override = overrides[entry.id];
      if (override !== undefined) {
        return { ...entry, meta: override };
      }
      return entry;
    }),
  }));
}

/**
 * DashboardNavItem is aliased to NavEntry so call sites that import
 * DashboardNavItem directly keep working without changes.
 * New code should prefer importing NavEntry from "../routes/nav" directly.
 */
export type DashboardNavItem = NavEntry;

export interface DashboardProps {
  title?: string;
  subtitle?: string;
  accent?: string;
  /**
   * Sectioned nav. Render priority:
   *   1. navSections provided → sectioned render loop.
   *   2. navItems provided → flat back-compat render (tests / previews).
   *   3. Neither provided → defaults to CANONICAL_NAV sectioned render.
   */
  navSections?: readonly NavSection[];
  /**
   * Flat nav entries for back-compat with tests / previews that pre-date the
   * sectioned schema. Takes lower priority than navSections. New screens
   * should pass navSections or omit both to use the CANONICAL_NAV default.
   *
   * @deprecated Use navSections instead. Removal scheduled once all preview
   * stories migrate.
   */
  navItems?: readonly NavEntry[];
  activeSection: Section;
  children?: Child;
  /**
   * Real pet level from progression.level. When provided, renders L<level>
   * pill in the sidebar brand chip. When absent, pill is hidden entirely —
   * NO hardcoded fallback.
   */
  level?: number;
  /**
   * Live trailing-meta overrides per nav entry, keyed by Section id.
   * Applied on top of CANONICAL_NAV (or navSections) at render time so
   * per-render counts (facts / chat sessions) stay fresh without mutating
   * the static nav definition.
   *
   * Example: { memory: "5 facts", chat: "3" }
   */
  navMetaOverrides?: Partial<Record<Section, string>>;
}

export function Dashboard(props: DashboardProps) {
  const {
    title,
    subtitle,
    accent,
    navSections,
    navItems,
    activeSection,
    children,
    level,
    navMetaOverrides,
  } = props;

  // Resolve which render path to use.
  // Priority: navSections > navItems > CANONICAL_NAV (sectioned).
  const baseSections: readonly NavSection[] | null =
    navSections !== undefined
      ? navSections
      : navItems === undefined
        ? CANONICAL_NAV
        : null;

  // Apply live meta overrides when rendering sectioned path.
  const resolvedSections: readonly NavSection[] | null =
    baseSections !== null && navMetaOverrides !== undefined
      ? applyNavMetaOverrides(baseSections, navMetaOverrides)
      : baseSections;

  const resolvedItems: readonly NavEntry[] | null =
    resolvedSections === null ? (navItems ?? []) : null;

  return (
    <AppChrome title={title} subtitle={subtitle} accent={accent}>
      <div style={{ display: "flex", height: "100%" }}>
        {/* Sidebar — Alpine `sidebar` island manages collapsed state.
            hx-preserve REMOVED so each nav re-renders the sidebar with the
            correct SSR-time activeSection highlight. Alpine
            re-attaches via x-data="sidebar" on each nav; $nav nanostore
            preserves the collapsed state across navigation (state lives in
            the store, not in the DOM, so sidebar destruction is safe). */}
        <aside
          id="dashboard-sidebar"
          role="navigation"
          aria-label="Sidebar"
          data-sidebar
          x-data="sidebar"
          style={{
            display: "flex",
            flexDirection: "column",
            background: tokens.color.paper,
            borderRight: `1px solid ${tokens.color.edge}`,
            overflow: "hidden",
            transition: "width 0.15s ease",
            width: "220px",
            flexShrink: 0,
          }}
          // Alpine expression widens/collapses the sidebar after hydration.
          // SSR width=220px is the expanded baseline; a future task will
          // swap to server-driven width once $nav persistence lands,
          // eliminating the hard-load flash on collapsed users.
          x-bind:style="{ width: collapsed ? '52px' : '220px' }"
        >
          {/* Brand chip — logo + brand name + level pill + collapse arrow.
             Collapsed mode (52px) hides the logo + name + L12 pill so the
             toggle button fits; expanded mode (220px) shows everything. */}
          <div
            class="sidebar-brand"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 10px",
              borderBottom: `1px solid ${tokens.color.edge}`,
              flexShrink: 0,
              justifyContent: "space-between",
            }}
            x-bind:style="{ justifyContent: collapsed ? 'center' : 'space-between' }"
          >
            <span
              x-show="!collapsed"
              style={{
                fontFamily: tokens.font.display,
                fontSize: 14,
                color: tokens.color.ink,
                fontWeight: 600,
                flex: 1,
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              siltpoke
            </span>
            {level !== undefined && (
              <span
                x-show="!collapsed"
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink3,
                  border: `1px solid ${tokens.color.ink3}`,
                  borderRadius: 999,
                  padding: "1px 5px",
                  flexShrink: 0,
                }}
              >
                {`L${level}`}
              </span>
            )}
            <button
              aria-label="Toggle sidebar"
              x-on:click="toggle()"
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: tokens.font.mono,
                fontSize: 14,
                color: tokens.color.ink3,
                padding: 0,
                flexShrink: 0,
                lineHeight: 1,
                marginLeft: "auto",
                width: 18,
                height: 18,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              x-bind:style="{ marginLeft: collapsed ? '0' : 'auto' }"
            >
              <span x-text="collapsed ? '›' : '‹'">‹</span>
            </button>
          </div>

          <div style={{ padding: "10px 8px", display: "flex", flexDirection: "column", gap: 2, flex: 1, overflowY: "auto" }}>
            {resolvedSections !== null
              ? resolvedSections.map((section, idx) => (
                  <div
                    key={section.id}
                    style={
                      idx > 0
                        ? {
                            // Visible gap between PET and WORK groups — extra
                            // top margin survives collapsed mode (where the
                            // SectionLabel hides via x-show).
                            marginTop: 10,
                            paddingTop: 6,
                            borderTop: `1px solid ${tokens.color.edge}`,
                          }
                        : undefined
                    }
                  >
                    <SectionLabel xShow="!collapsed">{section.label}</SectionLabel>
                    {section.entries.map((item) => (
                      <NavItem
                        key={item.id}
                        icon={item.icon}
                        label={item.label}
                        active={item.id === activeSection}
                        count={item.count}
                        disabled={item.disabled}
                        href={item.href}
                        labelXShow="!collapsed"
                        countXShow="!collapsed"
                        meta={item.meta}
                      />
                    ))}
                  </div>
                ))
              : (resolvedItems ?? []).map((item) => (
                  <NavItem
                    key={item.id}
                    icon={item.icon}
                    label={item.label}
                    active={item.id === activeSection}
                    count={item.count}
                    disabled={item.disabled}
                    href={item.href}
                    labelXShow="!collapsed"
                    countXShow="!collapsed"
                    meta={item.meta}
                  />
                ))}
          </div>

          {/* Daemon footer — green dot + daemon identity.
             Single-line: no fake budget number (Wave 2 wires real tracker). */}
          <div
            class="sidebar-footer"
            style={{
              padding: "8px 10px",
              borderTop: `1px solid ${tokens.color.edge}`,
              flexShrink: 0,
            }}
            x-show="!collapsed"
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: tokens.color.moss,
                  flexShrink: 0,
                  display: "inline-block",
                }}
              />
              daemon · :9876
            </div>
          </div>
        </aside>

        {/* Main content area */}
        <main
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "auto",
            background: tokens.color.cream,
          }}
        >
          {children}
        </main>
      </div>
    </AppChrome>
  );
}
