// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import { formatCount } from "../_shared/format";
import { Icon } from "./Icon";

export interface NavItemProps {
  icon?: string;
  label: string;
  active?: boolean;
  count?: number | null;
  color?: string;
  /**
   * Optional Alpine `x-show` expression injected onto the label span.
   * Parent shells use this to hide labels when their sidebar collapses
   * (Dashboard does `labelXShow="!collapsed"`). Empty / undefined leaves
   * the label always visible.
   */
  labelXShow?: string;
  /** Same as `labelXShow`, but for the count badge. */
  countXShow?: string;
  /**
   * When true, renders as a non-interactive <span aria-disabled="true"> with
   * opacity 0.5 and cursor:not-allowed instead of a clickable element.
   * Active highlight is suppressed — disabled entries cannot be "active".
   * Used for Settings (route not yet implemented).
   */
  disabled?: boolean;
  /**
   * Navigation target for enabled entries. Rendered as `href` on the `<a>`
   * element so HTMX hx-boost can intercept navigation.
   * Not rendered on disabled entries (no `<a>` is emitted).
   */
  href?: string;
  /**
   * Optional right-aligned trailing meta string (e.g. "today" / "7d" / "1.3k facts").
   * Rendered as ink3 11px mono text, distinct from the count badge.
   * Hidden when sidebar is collapsed (same Alpine x-show as label).
   */
  meta?: string;
}

export function NavItem(props: NavItemProps) {
  const {
    icon,
    label,
    active,
    count,
    color = tokens.color.terra,
    labelXShow,
    countXShow,
    disabled,
    href,
    meta,
  } = props;

  // Disabled entries render as non-interactive <span aria-disabled="true">.
  // Active highlight is suppressed — a disabled entry cannot be selected.
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        role="link"
        tabIndex={-1}
        class="nav-item nav-item--disabled"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "7px 10px",
          // Lock minHeight so rows stay the same vertical size whether the
          // label is visible (expanded sidebar) or hidden (collapsed).
          // Matches expanded text-line height (label 12.5px * 1.5 ≈ 18.75 + 14
          // vertical padding ≈ 32.75) so the icons sit on the same baseline.
          minHeight: 30,
          boxSizing: "border-box",
          borderRadius: 6,
          background: "transparent",
          color: tokens.color.ink2,
          fontSize: 12.5,
          fontFamily: tokens.font.body,
          fontWeight: 500,
          cursor: "not-allowed",
          opacity: 0.5,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            color: tokens.color.ink3,
            flexShrink: 0,
          }}
        >
          {icon != null && <Icon name={icon} size={16} />}
        </span>
        <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden" }} x-show={labelXShow}>
          {label}
        </span>
        {count != null && (
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
            }}
            x-show={countXShow}
          >
            {formatCount(count)}
          </span>
        )}
        {meta != null && (
          <span
            class="nav-item__meta"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 11,
              color: tokens.color.ink3,
              marginLeft: "auto",
            }}
            x-show={labelXShow}
          >
            {meta}
          </span>
        )}
      </span>
    );
  }

  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      class="nav-item"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "7px 10px",
        borderRadius: 6,
        background: active ? tokens.color.paperD : "transparent",
        color: active ? tokens.color.ink : tokens.color.ink2,
        fontSize: 12.5,
        fontFamily: tokens.font.body,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        textDecoration: "none",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          color: active ? color : tokens.color.ink3,
          flexShrink: 0,
        }}
      >
        {icon != null && <Icon name={icon} size={16} />}
      </span>
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden" }} x-show={labelXShow}>
        {label}
      </span>
      {count != null && (
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
          x-show={countXShow}
        >
          {formatCount(count)}
        </span>
      )}
      {meta != null && (
        <span
          class="nav-item__meta"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: tokens.color.ink3,
            marginLeft: "auto",
          }}
          x-show={labelXShow}
        >
          {meta}
        </span>
      )}
    </a>
  );
}
