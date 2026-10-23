// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * The Change-model window (spec §12.2) — one per Settings page, opened for a
 * role by that row's `Change model` button (`$dispatch('open-model-window',
 * { role })`). Everything it shows and does is the `modelPicker` island's
 * (src/web/client/islands/model-picker.ts); this is its markup, in the shape
 * of mock F (an internal design note).
 *
 * No special options (Follow / Ask me in chat / Back to default): the maintainer
 * took them out (§12.2). The row in use is marked by a ✓ alone.
 */
import type { InUse, PickerRole } from "../client/islands/model-picker";
/** The tabs, in the mock's order. */
const FAMILY_TABS = ["all", "claude", "agy", "codex", "qoder", "codebuddy"] as const;
import { tokens } from "../tokens/tokens";

export interface SettingsModelWindowProps {
  secret: string;
  roles: Record<PickerRole, InUse>;
}

const mono = tokens.font.mono;
const ink3 = tokens.color.ink3;
const small = { fontFamily: tokens.font.body, fontSize: 12, color: ink3 };
const th = {
  textAlign: "left" as const,
  fontWeight: 500,
  color: ink3,
  padding: "6px 8px",
  borderBottom: `1px solid ${tokens.color.edge}`,
  position: "sticky" as const,
  top: 0,
  background: tokens.color.paper,
};
const thNum = { ...th, textAlign: "right" as const, whiteSpace: "nowrap" as const };
const td = { padding: "7px 8px", borderBottom: `1px solid ${tokens.color.edge}`, verticalAlign: "top" as const };
const btn = {
  fontFamily: mono,
  fontSize: 11,
  color: tokens.color.ink,
  background: "none",
  border: `1px solid ${tokens.color.edge}`,
  borderRadius: tokens.radius.sm,
  padding: "3px 10px",
  cursor: "pointer",
};

export function SettingsModelWindow({ secret, roles }: SettingsModelWindowProps) {
  return (
    <div
      x-data="modelPicker"
      {...{ "x-on:open-model-window.window": "openFor($event.detail.role)" }}
      {...{ "x-on:keydown.escape.window": "open && close()" }}
      data-secret={secret}
      data-roles={JSON.stringify(roles)}
    >
      <div
        data-model-backdrop
        {...{ "x-on:click.self": "close()" }}
        style={{
          display: "none",
          position: "fixed",
          inset: 0,
          background: tokens.shadow.scrim,
          zIndex: 50,
          alignItems: "flex-start",
          justifyContent: "center",
          paddingTop: "6vh",
        }}
        x-bind:style="{ display: open ? 'flex' : 'none' }"
      >
        <div
          role="dialog"
          aria-modal="true"
          tabindex={-1}
          x-bind:aria-label="title()"
          x-on:keydown="onKey($event)"
          style={{
            width: "min(1000px, calc(100vw - 32px))",
            maxHeight: "86vh",
            display: "flex",
            flexDirection: "column",
            background: tokens.color.paper,
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: 10,
            boxShadow: tokens.shadow.lg,
          }}
        >
          <div style={{ padding: "16px 20px 10px", borderBottom: `1px solid ${tokens.color.edge}` }}>
            <button
              type="button"
              aria-label="Close"
              x-on:click="close()"
              style={{ float: "right", background: "none", border: "none", color: ink3, fontSize: 18, cursor: "pointer" }}
            >
              ×
            </button>
            <h3 x-text="title()" style={{ margin: 0, fontFamily: tokens.font.body, fontSize: 16, color: tokens.color.ink }}>
              Choose an agent and model
            </h3>
            <p style={{ ...small, margin: "4px 0 0" }}>
              <span x-show="view && view.savedOn" x-text="'Showing the list saved on ' + (view ? view.savedOn : '')" />
              <span x-show="!view || !view.savedOn">No list saved yet</span>
              <span x-show="refreshing"> — refreshing now.</span>
            </p>
          </div>

          <div
            data-model-sources
            style={{ padding: "10px 20px", borderBottom: `1px solid ${tokens.color.edge}`, ...small }}
          >
            {/* The two sites on one line, the agents on the next. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 24px", marginBottom: 4 }}>
              <template x-for="s in sources('sites')" x-bind:key="s.name">
                <span>
                  <span x-text="s.ok ? '✓ ' : '✕ '" x-bind:style={`{ color: s.ok ? '${tokens.color.moss}' : '${tokens.color.terra}' }`} />
                  <span x-text="s.text" />
                </span>
              </template>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 24px" }}>
              <template x-for="s in sources('agents')" x-bind:key="s.name">
                <span>
                  <span x-text="s.ok ? '✓ ' : '✕ '" x-bind:style={`{ color: s.ok ? '${tokens.color.moss}' : '${tokens.color.terra}' }`} />
                  <span x-text="s.text" />
                </span>
              </template>
              <span x-show="refreshing" style={{ color: tokens.color.amber }}>
                … asking every agent, models.dev and openrouter.ai
              </span>
            </div>
          </div>

          <div style={{ padding: "10px 20px 4px" }}>
            <div
              data-model-now
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                padding: "10px 12px",
                border: `1px solid ${tokens.color.moss}`,
                background: tokens.shadow.inUseWash,
                borderRadius: 8,
                flexWrap: "wrap",
              }}
            >
              <span style={{ ...small, fontSize: 11.5, color: tokens.color.moss }}>In use now</span>
              <span x-text="inUse ? (inUse.family || inUse.label || inUse.why || '—') : '—'" style={{ fontFamily: mono, fontSize: 14, color: tokens.color.ink }} />
              <span
                x-text="inUseModelText()"
                style={{ fontFamily: mono, fontSize: 12, color: tokens.color.ink2 }}
              />
              <span
                x-text="error ? error : (saved ? '✓ Saved' : (inUse ? (inUse.isDefault ? 'Siltpoke’s default' : inUse.why) : ''))"
                x-bind:style={`{ color: error ? '${tokens.color.terra}' : (saved ? '${tokens.color.moss}' : '${tokens.color.ink3}') }`}
                style={{ ...small, marginLeft: "auto" }}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, padding: "10px 20px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ ...small, marginRight: 4 }}>Show models from:</span>
            {FAMILY_TABS.map((t) => (
              <button
                type="button"
                x-on:click={`tab = '${t}'`}
                x-bind:aria-pressed={`tab === '${t}'`}
                x-bind:style={`tab === '${t}' ? { background: '${tokens.color.ink}', color: '${tokens.color.paper}' } : { background: 'none', color: '${tokens.color.ink}' }`}
                style={{ ...btn, fontSize: 12, borderRadius: 99, padding: "4px 10px" }}
              >
                {t}
              </button>
            ))}
          </div>

          <div style={{ overflow: "auto", padding: "0 20px 8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, color: tokens.color.ink }}>
              <thead>
                <tr>
                  <th style={th}>Family</th>
                  <th style={th}>Model</th>
                  <th style={th}>What it's for</th>
                  <th style={thNum}>In $/1M</th>
                  <th style={thNum}>Out $/1M</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                <template x-for="r in rows()" x-bind:key="r.family + ':' + r.id">
                  <tr data-model-row x-bind:data-in-use="isInUse(r) ? '1' : ''">
                    <td style={{ ...td, color: ink3 }} x-text="r.family" />
                    <td style={{ ...td, fontFamily: mono }}>
                      {/* The Family column names the agent; its own row shows only the model words. */}
                      <span x-text="r.id || r.description || 'its own default model'" />
                      <span x-show="isCheapest(r)" style={{ fontSize: 10.5, color: tokens.color.moss, marginLeft: 6 }}>
                        cheapest
                      </span>
                      <div x-show="missingNote(r)" x-text="missingNote(r)" style={{ ...small, fontSize: 11 }} />
                    </td>
                    <td style={td}>
                      {/* The short line on top, tags under it; the full words on hover. */}
                      <div style={{ ...small, fontSize: 11.5, marginBottom: 3 }}>
                        <span
                          x-show="whatFor(r)"
                          x-text="whatFor(r)"
                          x-bind:title="hoverFor(r)"
                          style={{ color: tokens.color.ink2, cursor: "help" }}
                        />
                        <a
                          x-show="r.guide"
                          x-bind:href="r.guide ? r.guide.url : null"
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="details on openrouter.ai"
                          title="details on openrouter.ai"
                          style={{ color: tokens.color.ink3, marginLeft: 6, textDecoration: "none" }}
                        >
                          ↗
                        </a>
                      </div>
                      <div>
                        <template x-for="t in tagsFor(r)" x-bind:key="t">
                          <span
                            data-model-tag
                            x-text="t"
                            style={{
                              display: "inline-block",
                              fontSize: 10.5,
                              border: `1px solid ${tokens.color.edge}`,
                              borderRadius: 4,
                              padding: "0 5px",
                              margin: "0 4px 2px 0",
                              color: tokens.color.ink2,
                            }}
                          />
                        </template>
                      </div>
                      <div x-show="note(r)" x-text="note(r)" style={{ ...small, fontSize: 11 }} />
                    </td>
                    <td style={{ ...td, textAlign: "right" }} x-text="r.input === null ? '—' : '$' + r.input" />
                    <td style={{ ...td, textAlign: "right" }} x-text="r.output === null ? '—' : '$' + r.output" />
                    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                      <span
                        x-show="isInUse(r)"
                        role="img"
                        aria-label="in use"
                        x-bind:title="inUse && inUse.isDefault ? 'In use (Siltpoke’s default)' : 'In use'"
                        style={{ color: tokens.color.moss, fontSize: 17, fontWeight: 700, paddingRight: 14 }}
                      >
                        ✓
                      </span>
                      <button
                        type="button"
                        x-show="!isInUse(r) && r.choosable !== false"
                        x-on:click="use(r)"
                        x-bind:disabled="saving"
                        style={btn}
                      >
                        Use
                      </button>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>

          <div style={{ padding: "10px 20px", borderTop: `1px solid ${tokens.color.edge}`, ...small, fontSize: 11.5 }}>
            Prices are pay-per-use API prices from models.dev, from each model's maker. They only sort the list — a
            subscription or plan may not charge this. What it's for comes from openrouter.ai: its tags are words found in
            the model's own description there (not our rating), the line is that description's start — hover for all of
            it, ↗ opens the page. models.dev fills in when OpenRouter does not list a model, and adds context size and
            open weights. A tag every model of an agent has is not repeated on its rows; a model past its retirement day
            is left out. Quoted lines are each agent's own description. claude has no list
            command, so its models are Anthropic's own list on models.dev. A tier an
            agent names for itself (qoder's Auto, codebuddy's fast-model…) is not a public model, so it has no price and
            is listed last.
          </div>
          <div style={{ padding: "10px 20px 14px", display: "flex", justifyContent: "flex-end" }}>
            <button type="button" x-on:click="close()" style={{ ...btn, fontSize: 12, padding: "5px 14px" }}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
