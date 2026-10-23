// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Prompt-injection alert marks. Re-exported from `./shared`.
 *
 * Every quote, path and reason below came out of a project file or a model
 * reply, i.e. untrusted text. They are only ever passed as JSX text children
 * (Hono escapes those) — never as raw HTML.
 *
 * Plain SSR with no Alpine and no hidden start state, same as `EvidenceMark`:
 * a mark that can start `display:none` is a mark a page can ship invisible.
 */
import type { ToolCallsField } from "../../../brain/tool-calls";
import type { InjectionAlert } from "../../../critic/injection-alert";
import { tokens } from "../../tokens/tokens";

const monoLabel = {
  fontFamily: tokens.font.mono,
  fontSize: 9,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 600,
  flexShrink: 0,
} as const;

const KIND_TAG: Record<InjectionAlert["signals"][number]["kind"], string> = {
  self: "said by the AI",
  tool: "outside read",
  echo: "echo",
  scan: "scan",
};

/** Quiet label by what fired: scan only, tool only, or a mix. */
function quietLabel(alert: InjectionAlert): string {
  const scan = alert.signals.some((s) => s.kind === "scan");
  const other = alert.signals.some((s) => s.kind !== "scan");
  if (scan && other) return "worth a look";
  return scan ? "text that looks like an instruction to the AI" : "outside read, agent's own folder";
}

/**
 * Loud = red bar, one line per signal as `where — "quote" — why`.
 * Quiet = one grey line. `null` = nothing (no claim either way).
 */
export function InjectionMark({ alert }: { alert: InjectionAlert | null }) {
  if (alert === null) return null;
  const loud = alert.level === "loud";
  const accent = loud ? tokens.color.terra : tokens.color.ink3;
  return (
    <div
      data-injection-mark={alert.level}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontFamily: tokens.font.body,
        fontSize: 11,
        lineHeight: 1.5,
        color: tokens.color.ink2,
        background: loud ? `color-mix(in srgb, ${tokens.color.terra} 9%, transparent)` : "transparent",
        border: `1px solid ${accent}`,
        borderRadius: tokens.radius.sm,
        padding: "6px 10px",
      }}
    >
      <span style={{ ...monoLabel, color: accent }}>
        {loud ? "possible prompt injection" : quietLabel(alert)}
      </span>
      {alert.signals.map((s) => (
        <div
          data-injection-signal={s.kind}
          data-injection-level={s.level}
          // In a loud alert a quiet hint is dimmed so it is not read as the loud reason.
          style={{
            minWidth: 0,
            overflowWrap: "anywhere",
            ...(loud && s.level === "quiet" ? { color: tokens.color.ink3, opacity: 0.75 } : {}),
          }}
        >
          <span style={{ ...monoLabel, color: tokens.color.ink3, marginRight: 6 }}>{KIND_TAG[s.kind]}</span>
          <span style={{ fontFamily: tokens.font.mono }}>{s.where}</span>
          {" — "}
          <span>{`"${s.quote}"`}</span>
          {" — "}
          <span>{s.why}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * What the reviewer opened or ran. `"not_recorded"` is NOT "used no tools":
 * this agent's output carries no tool record, so nothing can be said about
 * outside reads. `null` (row predates tool recording) renders nothing.
 */
export function ToolCallsLine({ field }: { field: ToolCallsField | null }) {
  if (field === null) return null;
  const text =
    field === "not_recorded"
      ? "reviewer tools: this agent does not report tool calls, so whether it read anything outside the project cannot be known"
      : field.length === 0
        ? "reviewer tools: used no tools"
        : null;
  return (
    <div
      data-tool-calls={field === "not_recorded" ? "not_recorded" : String(field.length)}
      style={{
        fontFamily: tokens.font.body,
        fontSize: 11,
        lineHeight: 1.5,
        color: tokens.color.ink3,
        overflowWrap: "anywhere",
      }}
    >
      {text ?? (
        <>
          <span>reviewer tools: </span>
          {(field as Exclude<ToolCallsField, "not_recorded">).map((c, i) => (
            <span data-tool-call={c.tool}>
              {i > 0 ? " · " : ""}
              <span style={{ fontFamily: tokens.font.mono }}>{[c.tool, c.target].filter(Boolean).join(" ")}</span>
              {c.failed ? " (failed)" : ""}
            </span>
          ))}
        </>
      )}
    </div>
  );
}
