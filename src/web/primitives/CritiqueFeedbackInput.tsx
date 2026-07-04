// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * CritiqueFeedbackInput
 *
 * A minimal free-text feedback widget embedded at the bottom of a
 * CritiqueAuditCard. Renders a textarea and submit button; calls onSubmit
 * with the trimmed text.
 *
 * SSR note: this component renders to static HTML (Hono JSX). Interactive
 * behaviour (state, events) is handled by the parent via onSubmit prop when
 * used in a React/client context, or wired up via a client-side island in a
 * future phase.
 */
import { tokens } from "../tokens/tokens";

export interface CritiqueFeedbackInputProps {
  critiqueId: string;
  onSubmit: (critiqueId: string, text: string) => void;
}

export function CritiqueFeedbackInput({
  critiqueId,
  onSubmit,
}: CritiqueFeedbackInputProps) {
  return (
    <form
      class="critique-feedback-form"
      data-critique-id={critiqueId}
      onSubmit={(e: Event) => {
        e.preventDefault();
        const form = e.currentTarget as HTMLFormElement;
        const textarea = form.querySelector("textarea") as HTMLTextAreaElement | null;
        const text = textarea?.value.trim() ?? "";
        if (!text) return;
        onSubmit(critiqueId, text);
        if (textarea) textarea.value = "";
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        borderTop: `1px solid ${tokens.color.edge}`,
        paddingTop: 10,
        marginTop: 2,
      }}
    >
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          fontWeight: 500,
        }}
      >
        Feedback
      </div>
      <textarea
        name="feedback-text"
        placeholder="Add free-text feedback…"
        rows={3}
        style={{
          fontFamily: tokens.font.body,
          fontSize: 12,
          color: tokens.color.ink,
          background: tokens.color.paperD,
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.sm,
          padding: "6px 8px",
          resize: "vertical",
          width: "100%",
          boxSizing: "border-box",
          outline: "none",
        }}
      />
      <button
        type="submit"
        style={{
          alignSelf: "flex-end",
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.paper,
          background: tokens.color.ink2,
          border: "none",
          borderRadius: tokens.radius.sm,
          padding: "4px 12px",
          cursor: "pointer",
        }}
      >
        Submit
      </button>
    </form>
  );
}
