// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { tokens } from "../tokens/tokens";

export function Chat() {
  return (
    <Dashboard activeSection="chat" navSections={CANONICAL_NAV}>
      <div
        x-data="chatStream"
        class="chat-pane"
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          padding: "16px",
          gap: "12px",
          boxSizing: "border-box",
        }}
      >
        <div
          class="chat-history"
          role="log"
          aria-label="Chat history"
          x-ref="history"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.paper,
            padding: "16px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            fontFamily: tokens.font.body,
            fontSize: 13,
            color: tokens.color.ink,
          }}
        >
          <div
            x-show="messages.length === 0 && !streaming"
            style={{
              color: tokens.color.ink3,
              textAlign: "center",
              padding: "32px 16px",
              fontFamily: tokens.font.mono,
              fontSize: 12,
            }}
          >
            start chatting with siltpoke
          </div>
          {/* Entry kinds: normal user/assistant bubble · failed → full-width
              muted error card (visually distinct from bubbles) · cancelled →
              quiet centered marker. The islands store FIXED display copy in
              msg.text for failed/cancelled entries, so this template renders
              plain text for all kinds (x-text — no HTML injection path). */}
          <template x-for="(msg, idx) in messages" x-bind:key="idx + '-' + msg.role">
            <div
              style={{
                padding: "8px 12px",
                borderRadius: tokens.radius.md,
                maxWidth: "70%",
                whiteSpace: "pre-wrap",
              }}
              x-bind:style="msg.status === 'failed' ? { background: '#f7ede4', border: '1px solid #dcb49e', alignSelf: 'stretch', maxWidth: '100%', color: '#1f1b16' } : msg.status === 'cancelled' ? { alignSelf: 'center', color: '#8a7c64', fontSize: '11px', padding: '2px 0' } : msg.role === 'user' ? { background: '#e8dec7', alignSelf: 'flex-end', color: '#1f1b16' } : { background: '#faf6ec', alignSelf: 'flex-start', color: '#1f1b16', border: '1px solid #d8cbab' }"
            >
              <span
                x-show="msg.status === 'failed'"
                aria-hidden="true"
                style={{ color: tokens.color.terra, marginRight: "6px" }}
              >
                ⚠
              </span>
              <span x-text="msg.text" />
            </div>
          </template>
          <div
            x-show="streaming"
            x-text="buffer"
            class="chat-streaming"
            aria-live="polite"
            style={{
              alignSelf: "flex-start",
              padding: "8px 12px",
              borderRadius: tokens.radius.md,
              background: tokens.color.cream,
              border: `1px solid ${tokens.color.edge}`,
              color: tokens.color.ink2,
              fontStyle: "italic",
              maxWidth: "70%",
              whiteSpace: "pre-wrap",
            }}
          />
          <div
            x-show="error"
            x-text="error"
            class="chat-error"
            aria-live="assertive"
            style={{
              color: tokens.color.terra,
              padding: "8px 12px",
              fontFamily: tokens.font.mono,
              fontSize: 12,
            }}
          />
        </div>
        <form
          class="chat-composer"
          hx-boost="false"
          x-on:submit="$event.preventDefault(); send()"
          style={{
            display: "flex",
            gap: "8px",
            alignItems: "flex-end",
          }}
        >
          <textarea
            x-model="input"
            rows={2}
            placeholder="Type a message"
            aria-label="Message to send"
            style={{
              flex: 1,
              padding: "8px 10px",
              border: `1px solid ${tokens.color.edge}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.cream,
              fontFamily: tokens.font.mono,
              fontSize: 12,
              color: tokens.color.ink,
              resize: "vertical",
            }}
          />
          {/* Visible Stop control while a turn is streaming — a
              plain button (never submits the form) that aborts the stream.
              Quiet, non-error affordance. */}
          <button
            type="button"
            x-show="streaming"
            x-on:click="stop()"
            style={{
              padding: "8px 16px",
              border: `1px solid ${tokens.color.edge}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.cream,
              color: tokens.color.ink,
              fontFamily: tokens.font.mono,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            ■ Stop
          </button>
          <button
            type="submit"
            x-bind:disabled="streaming || !input.trim()"
            style={{
              padding: "8px 16px",
              border: `1px solid ${tokens.color.edge}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.paperD,
              color: tokens.color.ink,
              fontFamily: tokens.font.mono,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Send
          </button>
        </form>
      </div>
    </Dashboard>
  );
}
