// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Per-critique feedback box with append-only edit history. Each instance
 * owns its own Alpine x-data so save/load state doesn't leak between cards.
 *
 * Extracted from src/web/screens/Critic.tsx.
 */
import { tokens } from "../../tokens/tokens";
import { Section } from "./section";
import type { CriticCall } from "../../../state/api";

export function feedbackKey(c: CriticCall): string {
  if (c.critique_id) return c.critique_id;
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "-");
  return `legacy-${safe(c.session_id)}-${safe(c.timestamp)}`.slice(0, 128);
}


/**
 * Per-critique feedback box with append-only edit history.
 * Each instance owns its own Alpine `x-data` scope so save/load state
 * does not leak between cards.
 */
export function FeedbackSection({ critiqueId }: { critiqueId: string }) {
  const endpoint = `/api/critique/${critiqueId}/feedback`;
  // Single-quoted JS embedded in the x-data attribute. Endpoint is
  // interpolated at render time so each row hits its own ID.
  // Alpine state machine:
  //   - editing=false (default after load when a saved note exists): show
  //     the saved text + 'edit' button. Empty saved note also lands here
  //     but with placeholder copy.
  //   - editing=true: textarea visible + 'save' button. After save, flip
  //     back to editing=false and refresh history.
  //   - First-time card with no saved note opens in editing=true so the
  //     user can type immediately.
  const alpine = `{
    draft: '',
    saved: '',
    history: [],
    loaded: false,
    loading: false,
    saving: false,
    err: '',
    showHistory: false,
    editing: false,
    fmtTs(ts) {
      try {
        const d = new Date(ts);
        if (isNaN(d.getTime())) return ts;
        return d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      } catch { return ts; }
    },
    async load() {
      this.loading = true; this.err = '';
      try {
        const r = await fetch('${endpoint}');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        this.history = Array.isArray(j.history) ? j.history : [];
        this.saved = this.history.length ? this.history[this.history.length - 1].text : '';
        this.draft = this.saved;
        // Open in edit mode when there is nothing saved yet.
        this.editing = this.history.length === 0;
        this.loaded = true;
      } catch (e) { this.err = String(e); }
      this.loading = false;
    },
    startEdit() { this.draft = this.saved; this.editing = true; this.err = ''; },
    cancelEdit() { this.draft = this.saved; this.editing = false; this.err = ''; },
    async save() {
      if (this.saving) return;
      this.saving = true; this.err = '';
      try {
        const r = await fetch('${endpoint}', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ text: this.draft, action: 'edit' })
        });
        if (!r.ok) {
          const t = await r.text();
          throw new Error(t || ('HTTP ' + r.status));
        }
        await this.load();
        this.editing = false;
      } catch (e) { this.err = String(e); }
      this.saving = false;
    }
  }`;

  return (
    <div x-data={alpine} x-init="load()">
      <Section title="feedback · your note (saved to siltpoke memory)">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* View mode: render the saved text inline as plain prose,
              no box / border. Matches a reviewer's marginalia, not an
              editable field. Edit button is the affordance. */}
          <div
            x-show="!editing"
            x-cloak
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 11,
              color: tokens.color.ink,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              padding: "2px 0",
            }}
          >
            <span x-show="saved" x-text="saved" />
            <span
              x-show="!saved"
              style={{ color: tokens.color.ink3, fontStyle: "italic" }}
            >
              (no note yet — click edit to add one)
            </span>
          </div>

          {/* Edit mode: textarea + cancel/save. */}
          <textarea
            x-show="editing"
            x-cloak
            x-model="draft"
            rows={3}
            data-feedback-textarea={critiqueId}
            placeholder="optional note — what was useful, wrong, or missing. Empty = no note. Brain reads recent entries to learn your preferences."
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 11,
              color: tokens.color.ink,
              background: tokens.color.cream,
              border: `1px solid ${tokens.color.edge}`,
              borderRadius: tokens.radius.sm,
              padding: "6px 8px",
              lineHeight: 1.45,
              resize: "vertical",
              minHeight: 60,
            }}
          />

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {/* SAVE — shown only in edit mode */}
            <button
              type="button"
              x-show="editing"
              x-on:click="save()"
              x-bind:disabled="saving"
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.cream,
                background: tokens.color.moss,
                border: `1px solid ${tokens.color.moss}`,
                borderRadius: tokens.radius.pill,
                padding: "3px 12px",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 700,
              }}
            >
              save
            </button>
            {/* CANCEL — only when there's a saved note to revert to */}
            <button
              type="button"
              x-show="editing && history.length > 0"
              x-on:click="cancelEdit()"
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                background: "transparent",
                border: `1px solid ${tokens.color.edge}`,
                borderRadius: tokens.radius.pill,
                padding: "3px 12px",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              cancel
            </button>
            {/* EDIT — view mode, when there is something to edit OR clear */}
            <button
              type="button"
              x-show="!editing"
              x-on:click="startEdit()"
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink,
                background: "transparent",
                border: `1px solid ${tokens.color.ink2}`,
                borderRadius: tokens.radius.pill,
                padding: "3px 12px",
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                fontWeight: 600,
              }}
            >
              edit
            </button>
            <span x-show="saving" style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3 }}>
              saving…
            </span>
            <span x-show="loading" style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3 }}>
              loading…
            </span>
            <span
              x-show="err"
              x-text="err"
              style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.terra }}
            />
            <button
              type="button"
              x-show="history.length > 0"
              x-on:click="showHistory = !showHistory"
              x-text="showHistory ? '— hide history (' + history.length + ')' : '+ show history (' + history.length + ')'"
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                background: "transparent",
                border: `1px dashed ${tokens.color.edge}`,
                borderRadius: tokens.radius.sm,
                padding: "2px 8px",
                cursor: "pointer",
                marginLeft: "auto",
              }}
            >
              + show history
            </button>
          </div>
          <div
            x-show="showHistory && history.length > 0"
            x-cloak
            style={{
              borderTop: `1px dashed ${tokens.color.edge}`,
              paddingTop: 6,
              marginTop: 4,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <template x-for="(h, idx) in [...history].reverse()" x-bind:key="idx">
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink2,
                  borderLeft: `2px solid ${tokens.color.edge}`,
                  paddingLeft: 8,
                }}
              >
                <div style={{ color: tokens.color.ink3, marginBottom: 2 }}>
                  <span x-text="fmtTs(h.ts)" />
                  <span> · </span>
                  <span x-text="h.action" />
                </div>
                <div
                  x-text="h.text || '(empty — cleared)'"
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: tokens.color.ink }}
                />
              </div>
            </template>
          </div>
        </div>
      </Section>
    </div>
  );
}
