// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Settings screen — /settings, the Agents page, in mock F's shape (spec
 * agent-in-use-truth §12.1; an internal design note).
 *
 * Two blocks only:
 *   1. "Coding agents on this machine" — one chip per agent: building (a
 *      session was seen, and when), installed, or not installed. Observed,
 *      not a setting: nothing here changes it. Several can be building at once.
 *   2. "Siltpoke's own agents" — Chat / Critic / Summarizer. Each row: what it
 *      does; the agent and model in use and why, with what the records say
 *      happened last (AC7–AC11); its daily cap (saved when the field is left)
 *      with today's count; and Change model, which opens the one model window.
 *
 * No dropdowns on the page, no separate caps block, no "what's this?" (§12.1).
 */

import type { PerRole } from "../../brain/daily-caps-view";
import type { BrainView } from "../../cli/brain-cli";
import type { InUse, PickerRole } from "../client/islands/model-picker";
import { CANONICAL_NAV } from "../routes/nav";
import { Dashboard } from "../shells/Dashboard";
import { tokens } from "../tokens/tokens";
import { SettingsModelWindow } from "./SettingsModelWindow";
import type { LastCall } from "./settings-last-calls";
import { PAGE_LEAD, PAGE_TITLE, ROLE_COPY, chipText, lastLine, roleRows, when } from "./settings-text";

export interface SettingsScreenProps {
  view: BrainView;
  /** Daemon secret — on each write island's container (closest("[data-secret]")). */
  secret: string;
  /** Each role's daily cap and its calls today (the counter the cap checks). */
  caps: { caps: PerRole; usage: PerRole };
  /** What the records say happened last — never the current setting. */
  last: { chat: LastCall | null; review: LastCall | null };
  /** "Now", for saying a time on today's date without the date. */
  now?: Date;
  /** The model codex's own config sets, if any — named on a codex row. */
  codexModel?: string;
}

const hint = { fontFamily: tokens.font.body, fontSize: 12, color: tokens.color.ink3 };
const mono = tokens.font.mono;

/** The building dot's halo: moss at 30% over whatever is behind. */
const dotHalo = `color-mix(in srgb, ${tokens.color.moss} 30%, transparent)`;

function AgentChip({ a, now }: { a: BrainView["agents"][number]; now: Date }) {
  const seen = when(a.seenAt, now);
  const state = seen !== null ? "on" : a.installed ? "" : "off";
  return (
    <span
      data-agent-chip={a.family}
      data-state={state}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontFamily: mono,
        fontSize: 12.5,
        fontWeight: state === "off" ? 400 : 600,
        color: tokens.color.ink,
        border: `1px solid ${state === "on" ? tokens.color.moss : tokens.color.edge}`,
        ...(state === "on" ? { background: tokens.shadow.inUseWash } : {}),
        borderRadius: 99,
        padding: "5px 12px 5px 10px",
        opacity: state === "off" ? 0.45 : 1,
      }}
    >
      {state !== "off" && (
        <span
          data-chip-dot={state === "on" ? "on" : "idle"}
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: state === "on" ? tokens.color.moss : tokens.color.ink3,
            ...(state === "on" ? { boxShadow: `0 0 0 3px ${dotHalo}` } : {}),
          }}
        />
      )}
      {a.family}
      <span style={{ ...hint, fontSize: 11.5, fontWeight: 400 }}>
        {chipText(a, now)}
      </span>
    </span>
  );
}

function CapCell({ role, cap, used }: { role: PickerRole; cap: number; used: number }) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: 6,
          background: tokens.color.paperD,
          width: 132,
        }}
      >
        <input
          type="number"
          min="0"
          step="1"
          inputmode="numeric"
          name={`${role}-cap`}
          aria-label={`${ROLE_COPY[role].name} daily cap`}
          value={String(cap)}
          x-model={`values.${role}`}
          x-on:blur={`saveOne('${role}')`}
          {...{ "x-on:keydown.enter": `saveOne('${role}')` }}
          x-on:input={`touched('${role}')`}
          style={{
            border: "none",
            background: "none",
            width: 64,
            padding: "6px 8px",
            fontFamily: mono,
            fontSize: 13,
            color: tokens.color.ink,
          }}
        />
        <span style={{ ...hint, fontSize: 11.5, paddingRight: 8, whiteSpace: "nowrap" }}>/ day</span>
      </div>
      <div
        style={{ width: 132, height: 4, borderRadius: 2, background: tokens.color.edge, marginTop: 6, overflow: "hidden" }}
      >
        <b
          data-cap-meter={role}
          style={{ display: "block", height: "100%", width: `${pct}%`, background: tokens.color.moss }}
          x-bind:style={`{ width: (Number(saved.${role}) > 0 ? Math.min(100, used.${role} / Number(saved.${role}) * 100) : 0) + '%' }`}
        />
      </div>
      <div style={{ ...hint, fontSize: 11, marginTop: 3 }}>
        <span x-show={`flash.${role}`} style={{ color: tokens.color.moss, display: "none" }}>
          ✓ saved
        </span>
        <span x-show={`!flash.${role}`} x-text={`usedText('${role}')`}>
          {cap === 0 ? `no cap · ${used} used today` : `${used} used today`}
        </span>
      </div>
      <div
        x-show={`errors.${role}`}
        x-text={`errors.${role}`}
        style={{ fontFamily: mono, fontSize: 10.5, color: tokens.color.terra, maxWidth: 200 }}
      />
    </div>
  );
}

const ghostBtn = {
  fontFamily: mono,
  fontSize: 12,
  color: tokens.color.ink,
  background: "none",
  border: `1px solid ${tokens.color.edge}`,
  borderRadius: tokens.radius.sm,
  padding: "6px 12px",
  cursor: "pointer",
};

export function SettingsScreen({ view, secret, caps, last, now = new Date(), codexModel }: SettingsScreenProps) {
  const rows = roleRows(view, codexModel);
  const inUse = Object.fromEntries(rows.map(({ role, u }) => [role, u.inUse])) as Record<PickerRole, InUse>;
  const big = { fontFamily: mono, fontSize: 15, fontWeight: 600, color: tokens.color.ink };

  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="settings">
      <div style={{ padding: 16, maxWidth: 1100 }}>
        <h1 style={{ fontFamily: tokens.font.body, fontSize: 20, color: tokens.color.ink, margin: "0 0 4px" }}>
          {PAGE_TITLE}
        </h1>
        <p style={{ ...hint, margin: "0 0 20px" }}>{PAGE_LEAD}</p>

        <div data-agents-bar style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "0 0 30px" }}>
          <span style={{ ...hint, marginRight: 6 }}>Coding agents on this machine</span>
          {view.agents.map((a) => (
            <AgentChip a={a} now={now} />
          ))}
        </div>

        <h2 style={{ fontFamily: tokens.font.body, fontSize: 15, color: tokens.color.ink, margin: "0 0 10px" }}>
          Siltpoke's own agents
        </h2>
        <div
          x-data="dailyCaps"
          data-secret={secret}
          data-chat={String(caps.caps.chat)}
          data-review={String(caps.caps.review)}
          data-extract={String(caps.caps.extract)}
          data-chat-used={String(caps.usage.chat)}
          data-review-used={String(caps.usage.review)}
          data-extract-used={String(caps.usage.extract)}
          x-init="startPolling()"
          {...{ "x-on:visibilitychange.document": "refreshUsage()" }}
          style={{ border: `1px solid ${tokens.color.edge}`, borderRadius: 10, overflow: "hidden" }}
        >
          {rows.map(({ role, u }, i) => (
            <div
              data-role-row={role}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "12px 24px",
                padding: "18px 20px",
                borderTop: i === 0 ? "none" : `1px solid ${tokens.color.edge}`,
              }}
            >
              <div style={{ flex: "0 1 200px", minWidth: 150 }}>
                <div style={{ fontFamily: tokens.font.body, fontSize: 15, fontWeight: 600, color: tokens.color.ink }}>
                  {ROLE_COPY[role].name}
                </div>
                <div style={{ ...hint, marginTop: 2 }}>{ROLE_COPY[role].does}</div>
              </div>
              <div data-using={role} style={{ flex: "1 1 260px", minWidth: 0 }}>
                <div style={{ overflowWrap: "anywhere" }}>
                  <span style={big}>{u.head} </span>
                  <span style={{ fontFamily: mono, fontSize: 13, color: tokens.color.ink2 }}>{u.modelText}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 6, ...hint }}>
                  {u.why ? <span>{u.why}</span> : null}
                  <span data-last-call={role}>{lastLine(role, last, now)}</span>
                </div>
              </div>
              <div style={{ flex: "0 0 170px" }}>
                <CapCell role={role} cap={caps.caps[role]} used={caps.usage[role]} />
              </div>
              <div style={{ flex: "0 0 auto", marginLeft: "auto" }}>
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={`Change model for ${ROLE_COPY[role].name}`}
                  x-on:click={`$dispatch('open-model-window', { role: '${role}' })`}
                  style={ghostBtn}
                >
                  Change model
                </button>
              </div>
            </div>
          ))}
        </div>

        <SettingsModelWindow secret={secret} roles={inUse} />
      </div>
    </Dashboard>
  );
}
