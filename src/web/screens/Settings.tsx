// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Settings screen — /settings
 *
 * The dashboard half of the review-brain select surface. Renders the resolved
 * brain per role (builder + family·model + source), then a PER-BUILDER table
 * (Brain select v2): one row per builder family, each choosing the reviewer
 * (and, only when the reviewer is claude, the model) for code built by that
 * family. Each row is a `builderRow` Alpine island that POSTs to
 * /api/brain/review-by-builder/<builder> — the SAME route+config the
 * `siltpoke brain set-builder` command writes, so command and dashboard are one
 * source of truth.
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { tokens } from "../tokens/tokens";
import type { BrainView } from "../../cli/brain-cli";

export interface SettingsScreenProps {
  view: BrainView;
  /** Daemon secret — rendered as data-secret on the island container so the
   * Save POST (secret-gated) can read it via closest("[data-secret]"). */
  secret: string;
}

export function SettingsScreen({ view, secret }: SettingsScreenProps) {

  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="settings">
      <div style={{ padding: 16, maxWidth: 640 }}>
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
            SETTINGS · REVIEW BRAIN
          </span>
          <h1 style={{ fontFamily: tokens.font.body, fontSize: 20, color: tokens.color.ink, margin: 0 }}>
            Which brain reviews your code
          </h1>
          <p style={{ fontFamily: tokens.font.body, fontSize: 13, color: tokens.color.ink3, marginTop: 6 }}>
            The code was authored by <strong>{view.authorFamily}</strong>. By default the review
            follows the building host; pin a different CLI family (and optionally a model) below.
            Changes take effect on the next review. The <code>/siltpoke-brain</code> command writes
            the same setting.
          </p>
        </div>

        {/* Resolved brain per role */}
        <div
          style={{
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: tokens.radius.sm,
            marginBottom: 20,
          }}
        >
          {view.roles.map((r, i) => {
            // chat auto-detects (read-only); review + extract are directly selectable.
            const selectable = r.role === "review" || r.role === "extract";
            const rowStyle = {
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 12px",
              borderTop: i === 0 ? "none" : `1px solid ${tokens.color.edge}`,
              flexWrap: "wrap" as const,
            };
            const label = (
              <div style={{ flex: 1, minWidth: 90, fontFamily: tokens.font.body, fontSize: 13, color: tokens.color.ink }}>
                {r.role}
                {r.role === "review" && (
                  <span style={{ color: tokens.color.ink3, marginLeft: 6, fontSize: 11 }}>←</span>
                )}
                {r.role === "chat" && (
                  <span style={{ color: tokens.color.ink3, marginLeft: 6, fontSize: 10.5 }}>auto</span>
                )}
              </div>
            );
            const sourceTag = (
              <span
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink3,
                  minWidth: 72,
                  textAlign: "right" as const,
                }}
              >
                [{r.source}]
              </span>
            );
            if (!selectable) {
              return (
                <div style={rowStyle}>
                  {label}
                  <span style={{ fontFamily: tokens.font.mono, fontSize: 12, color: tokens.color.ink }}>
                    {r.family} · {r.model ?? "(CLI default)"}
                  </span>
                  {sourceTag}
                </div>
              );
            }
            const selStyle = {
              fontFamily: tokens.font.mono,
              fontSize: 13,
              color: tokens.color.ink,
              background: tokens.color.paperD,
              border: `1px solid ${tokens.color.edge}`,
              borderRadius: tokens.radius.sm,
              padding: "5px 8px",
            };
            return (
              <div
                x-data="roleRow"
                x-init="init()"
                data-secret={secret}
                data-role={r.role}
                data-family={r.family}
                data-model={r.model ?? ""}
                style={rowStyle}
              >
                {label}
                <select x-model="family" style={selStyle}>
                  {view.families.map((f) => (
                    <option value={f}>{f}</option>
                  ))}
                </select>
                <select x-show="family === 'claude'" x-model="model" style={selStyle}>
                  <option value="">(CLI default)</option>
                  {view.claudeModels.map((m) => (
                    <option value={m}>{m}</option>
                  ))}
                </select>
                <span
                  x-show="family !== 'claude'"
                  x-text="'model · set in ' + family + '’s own config'"
                  style={{ fontFamily: tokens.font.mono, fontSize: 10.5, color: tokens.color.ink3 }}
                >
                  model · set in this CLI’s own config
                </span>
                <button
                  type="button"
                  x-on:click="save()"
                  x-bind:disabled="saving"
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    color: tokens.color.paper,
                    background: tokens.color.ink2,
                    border: "none",
                    borderRadius: tokens.radius.sm,
                    padding: "5px 12px",
                    cursor: "pointer",
                  }}
                >
                  <span x-text="saving ? 'Saving…' : (saved ? 'Saved ✓' : 'Save')">Save</span>
                </button>
                {sourceTag}
                <span
                  x-show="error"
                  x-text="error"
                  style={{ fontFamily: tokens.font.mono, fontSize: 10.5, color: tokens.color.terra, width: "100%" }}
                />
              </div>
            );
          })}
        </div>

        {/* Per-builder review overrides (Brain select v2) */}
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.ink3,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: 500,
            marginBottom: 8,
          }}
        >
          Set review brain — per builder
        </div>
        <p style={{ fontFamily: tokens.font.body, fontSize: 12, color: tokens.color.ink3, marginTop: 0 }}>
          When code built by a given CLI is reviewed, pick the reviewer below — it can be <strong>any
          family</strong>, and choosing a different one than the builder is a cross-family review (each
          concurrent window resolves its own row by its building host). The review model is chosen here
          only for <strong>claude</strong> (siltpoke runs it directly); every other family reviews with
          the model set in <em>its own CLI config</em>, so it isn't duplicated here.
        </p>

        <div style={{ border: `1px solid ${tokens.color.edge}`, borderRadius: tokens.radius.sm }}>
          {view.reviewByBuilder.map((row, i) => (
            <div
              x-data="builderRow"
              x-init="init()"
              data-secret={secret}
              data-builder={row.builder}
              data-reviewer={row.reviewer}
              data-model={row.model ?? ""}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                borderTop: i === 0 ? "none" : `1px solid ${tokens.color.edge}`,
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 12,
                  color: tokens.color.ink,
                  minWidth: 96,
                }}
              >
                built · {row.builder}
              </span>
              <span style={{ fontFamily: tokens.font.body, fontSize: 12, color: tokens.color.ink3 }}>→</span>

              <select
                x-model="reviewer"
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 13,
                  color: tokens.color.ink,
                  background: tokens.color.paperD,
                  border: `1px solid ${tokens.color.edge}`,
                  borderRadius: tokens.radius.sm,
                  padding: "5px 8px",
                }}
              >
                {view.families.map((f) => (
                  <option value={f}>{f}</option>
                ))}
              </select>

              {/* model select — only when the reviewer is claude */}
              <select
                x-show="reviewer === 'claude'"
                x-model="model"
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 13,
                  color: tokens.color.ink,
                  background: tokens.color.paperD,
                  border: `1px solid ${tokens.color.edge}`,
                  borderRadius: tokens.radius.sm,
                  padding: "5px 8px",
                }}
              >
                <option value="">(CLI default)</option>
                {view.claudeModels.map((m) => (
                  <option value={m}>{m}</option>
                ))}
              </select>
              <span
                x-show="reviewer !== 'claude'"
                x-text="'model · set in ' + reviewer + '’s own config'"
                style={{ fontFamily: tokens.font.mono, fontSize: 10.5, color: tokens.color.ink3 }}
              >
                model · set in this CLI’s own config
              </span>
              {/* cross-family cue: reviewer differs from the builder */}
              <span
                x-show={`reviewer !== '${row.builder}'`}
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 9,
                  color: tokens.color.sky,
                  border: `1px solid ${tokens.color.sky}`,
                  borderRadius: 3,
                  padding: "0 3px",
                }}
              >
                cross-family
              </span>

              <button
                type="button"
                x-on:click="save()"
                x-bind:disabled="saving"
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.paper,
                  background: tokens.color.ink2,
                  border: "none",
                  borderRadius: tokens.radius.sm,
                  padding: "5px 12px",
                  cursor: "pointer",
                  marginLeft: "auto",
                }}
              >
                <span x-text="saving ? 'Saving…' : (saved ? 'Saved ✓' : 'Save')">Save</span>
              </button>
              <span
                x-show="error"
                x-text="error"
                style={{ fontFamily: tokens.font.mono, fontSize: 10.5, color: tokens.color.terra, width: "100%" }}
              />
            </div>
          ))}
        </div>
      </div>
    </Dashboard>
  );
}
