// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";

/**
 * NL  composer — docked at the bottom of the by-type view.
 *
 * The matcher (island buildProposal) is deterministic (NO LLM): it can only
 * propose retiring an EXISTING semantic fact. ✓确认 on an actionable proposal
 * performs the real POST /api/facts/:id/retire. A non-actionable proposal
 * (arbitrary NL) renders only a 知道了 dismiss button — never a faked mutation.
 *
 * All interactivity is x-on:* / x-model (morph-safe; no addEventListener).
 */
// Shared button styles for the proposal action rows (deterministic + NL paths).
const confirmBtnStyle = {
  fontFamily: tokens.font.body,
  fontSize: 12,
  fontWeight: 600,
  color: tokens.color.cream,
  background: tokens.color.moss,
  border: "none",
  borderRadius: "7px",
  padding: "6px 14px",
  cursor: "pointer",
};
const cancelBtnStyle = {
  fontFamily: tokens.font.body,
  fontSize: 12,
  fontWeight: 500,
  color: tokens.color.ink2,
  background: "transparent",
  border: `1px solid ${tokens.color.edge}`,
  borderRadius: "7px",
  padding: "6px 14px",
  cursor: "pointer",
};
// Shared row styles for the proposal header (title + "awaiting" pill) — every
// classification (deterministic retire / add / restate / contradict) renders
// the same header shape, only the title text and pill text change.
const proposalHeaderRowStyle = { display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" };
const proposalTitleStyle = { fontSize: 12.5, fontWeight: 600, color: tokens.color.ink };
const awaitingPillStyle = {
  fontFamily: tokens.font.mono,
  fontSize: 10,
  fontWeight: 600,
  color: tokens.color.memStatusPendingInk,
  // 18% — consolidated with STATUS_META.pending.bg in memory-book-helpers.ts
  // (this site was independently hand-tuned to 20%; same role, one %).
  background: "color-mix(in srgb, var(--color-amber) 18%, transparent)",
  borderRadius: tokens.radius.pill,
  padding: "1px 8px",
};
// Shared style for the body/detail line under a proposal header.
const detailTextStyle = { fontSize: 12.5, color: tokens.color.ink2, lineHeight: 1.5 };

function ProposalHeader({
  title,
  pill,
}: {
  title: import("hono/jsx").Child;
  pill: string;
}) {
  return (
    <div style={proposalHeaderRowStyle}>
      <span style={proposalTitleStyle}>{title}</span>
      <span style={awaitingPillStyle}>{pill}</span>
    </div>
  );
}

// Confirm/Cancel action row shared by the deterministic-retire, add, and
// restate classifications — only the confirm handler differs (cancel is
// always cancelProposal()).
function ConfirmCancelRow({ onConfirm }: { onConfirm: string }) {
  return (
    <div style={{ marginTop: "9px", display: "flex", gap: "8px" }}>
      <button type="button" class="memory-proposal-confirm" x-on:click={onConfirm} style={confirmBtnStyle}>
        ✓ Confirm
      </button>
      <button type="button" class="memory-proposal-cancel" x-on:click="cancelProposal()" style={cancelBtnStyle}>
        ✕ Cancel
      </button>
    </div>
  );
}

export function MemoryComposer() {
  return (
    <div
      class="memory-composer"
      style={{
        borderTop: `1px solid ${tokens.color.edge}`,
        background: tokens.color.paper,
        padding: "14px 0 16px",
      }}
    >
      <div style={{ maxWidth: "1040px", margin: "0 auto" }}>
      {/* proposal card */}
      <div x-show="proposal !== null" x-cloak>
        <div
          class="memory-proposal bk-rise"
          style={{
            marginBottom: "10px",
            background: tokens.color.memProposalBg,
            border: `1px solid ${tokens.color.memProposalBorder}`,
            borderLeft: `3px solid ${tokens.color.amber}`,
            borderRadius: "10px",
            padding: "12px 14px",
            display: "flex",
            alignItems: "flex-start",
            gap: "12px",
          }}
        >
          <span
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "7px",
              background: tokens.color.terra,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: tokens.color.cream,
              fontFamily: tokens.font.display,
              fontSize: 13,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            s
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* deterministic retire proposal (no classification) */}
            <template x-if="proposal && !proposal.classification && proposal.actionable">
              <div>
                <ProposalHeader
                  title={
                    <>
                      siltpoke proposes to <span x-text="proposal.verb" /> a memory
                    </>
                  }
                  pill="Awaiting your confirmation"
                />
                <div style={detailTextStyle}>
                  「<b style={{ color: tokens.color.ink }} x-text="proposal.target" />」——{" "}
                  <span x-text="proposal.detail" />
                </div>
                <ConfirmCancelRow onConfirm="confirmProposal()" />
              </div>
            </template>
            {/* non-actionable proposal — honest, no mutate button */}
            <template x-if="proposal && !proposal.classification && !proposal.actionable">
              <div>
                <div style={{ ...proposalTitleStyle, marginBottom: "4px" }}>
                  siltpoke isn't sure
                </div>
                <div style={detailTextStyle}>
                  <span x-text="proposal.detail" />
                </div>
                <div style={{ marginTop: "9px" }}>
                  <button
                    type="button"
                    class="memory-proposal-dismiss"
                    x-on:click="cancelProposal()"
                    style={cancelBtnStyle}
                  >
                    Got it
                  </button>
                </div>
              </div>
            </template>
            {/* NL add — single 确认 */}
            <template x-if="proposal && proposal.classification === 'add'">
              <div>
                <ProposalHeader title="siltpoke wants to save a new memory" pill="Awaiting your confirmation" />
                <div style={detailTextStyle}>
                  「<b style={{ color: tokens.color.ink }} x-text="proposal.candidate" />」
                </div>
                <ConfirmCancelRow onConfirm="confirmAdd()" />
              </div>
            </template>
            {/* NL restate — single 确认 (reconfirm existing) */}
            <template x-if="proposal && proposal.classification === 'restate'">
              <div>
                <ProposalHeader
                  title="siltpoke wants to reaffirm an existing memory"
                  pill="Awaiting your confirmation"
                />
                <div style={detailTextStyle}>
                  Existing 「<b style={{ color: tokens.color.ink }} x-text="proposal.contradictedText" />」—— confirm it still holds.
                </div>
                <ConfirmCancelRow onConfirm="confirmRestate(proposal.targetFactId)" />
              </div>
            </template>
            {/* NL contradict — 替换 / 两条都留 / 取消 */}
            <template x-if="proposal && proposal.classification === 'contradict'">
              <div>
                <ProposalHeader title="This conflicts with an existing memory" pill="Awaiting your choice" />
                <div style={detailTextStyle}>
                  New: 「<b style={{ color: tokens.color.ink }} x-text="proposal.candidate" />」
                </div>
                <div style={detailTextStyle}>
                  Old: 「<b style={{ color: tokens.color.ink }} x-text="proposal.contradictedText" />」
                </div>
                <div style={{ marginTop: "9px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    class="memory-proposal-replace"
                    x-on:click="confirmReplace(proposal.targetFactId)"
                    style={confirmBtnStyle}
                  >
                    Replace
                  </button>
                  <button
                    type="button"
                    class="memory-proposal-keepboth"
                    x-on:click="keepBoth()"
                    style={cancelBtnStyle}
                  >
                    Keep both
                  </button>
                  <button
                    type="button"
                    class="memory-proposal-cancel"
                    x-on:click="cancelProposal()"
                    style={cancelBtnStyle}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      {/* input row — paddingRight keeps 发送 clear of the floating chat
          bubble (fixed bottom-right) since the docked bar reaches that corner. */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", paddingRight: "60px" }}>
        <span style={{ fontSize: 18, flexShrink: 0 }}>💬</span>
        <input
          class="memory-composer-input"
          type="text"
          x-model="chat"
          {...{ "x-on:keydown.enter": "sendChat()" }}
          placeholder="Tell siltpoke to update a memory… e.g. 「forget that Express thing」"
          style={{
            flex: 1,
            fontFamily: tokens.font.body,
            fontSize: 13,
            color: tokens.color.ink,
            background: tokens.color.cream,
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: "9px",
            padding: "10px 14px",
            outline: "none",
          }}
        />
        <button
          type="button"
          class="memory-composer-send"
          x-on:click="sendChat()"
          x-bind:disabled="parsing"
          x-bind:style="parsing ? { opacity: 0.6, cursor: 'wait' } : { opacity: 1, cursor: 'pointer' }"
          style={{
            fontFamily: tokens.font.body,
            fontSize: 13,
            fontWeight: 600,
            color: tokens.color.cream,
            background: tokens.color.terra,
            border: "none",
            borderRadius: "9px",
            padding: "10px 18px",
            flexShrink: 0,
          }}
        >
          <span x-text="parsing ? 'Thinking…' : 'Send'">Send</span>
        </button>
      </div>
      {/* thinking hint while the parse call is in flight (the LLM hop can take
          a few seconds — without this the user thinks nothing happened). */}
      <div
        class="memory-composer-thinking"
        x-show="parsing"
        x-cloak
        style={{
          marginTop: "7px",
          fontSize: 11,
          color: tokens.color.ink3,
          paddingLeft: "28px",
          fontStyle: "italic",
        }}
      >
        siltpoke is figuring out how to change this memory…
      </div>
      <div style={{ marginTop: "7px", fontSize: 11, color: tokens.color.ink3, paddingLeft: "28px" }}>
        siltpoke can only <b style={{ color: tokens.color.ink3 }}>propose</b> memory changes — nothing takes effect until you confirm.
      </div>
      </div>
    </div>
  );
}
