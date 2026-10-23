// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Chat Runs window — one run row as HTML (spec 2026-10-13 §10.1; look = the
 * 35th mock). Every string from a record is escaped here: a record holds the
 * agent's raw output, which is untrusted text.
 *
 * Styles: `chat-runs-css.ts` (classes are `cr-*`).
 */
import type { RunStep, RunView, TraceRow } from "./chat-runs-view";

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

const BLOCK_COLORS = [
  "var(--color-sky)",
  "var(--color-moss)",
  "var(--color-violet)",
  "var(--color-amber)",
  "var(--color-tan)",
  "var(--color-terra)",
];

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function prettyJson(line: string): string {
  try {
    return JSON.stringify(JSON.parse(line), null, 2);
  } catch {
    return line;
  }
}

/** `{ }` toggle + the exact lines it shows (hidden until clicked). */
function rawToggle(raw: string[]): string {
  if (raw.length === 0) return "";
  const body = raw.map(prettyJson).join("\n\n");
  return `<button class="cr-rawbtn" type="button" aria-expanded="false" title="Show the exact line${
    raw.length > 1 ? `s (${raw.length})` : ""
  } the CLI printed">{ }</button><pre class="cr-json" hidden>${esc(body)}</pre>`;
}

function sentHtml(step: RunStep): string {
  if (step.body.kind !== "sent") return "";
  const { totalChars, blocks, omitted } = step.body;
  const bar = blocks
    .map(
      (b, i) =>
        `<span style="flex:${Math.max(1, b.chars)};background:${BLOCK_COLORS[i % BLOCK_COLORS.length]}" title="${esc(b.name)} · ${b.chars.toLocaleString("en-US")} chars"></span>`,
    )
    .join("");
  const rows = blocks
    .map(
      (b, i) =>
        `<details class="cr-pc"><summary><i style="background:${BLOCK_COLORS[i % BLOCK_COLORS.length]}"></i><span class="cr-pn">${esc(b.name)}</span><span class="cr-psz">${b.chars.toLocaleString("en-US")}</span></summary><pre>${esc(b.text)}</pre></details>`,
    )
    .join("");
  return (
    `<div class="cr-sent"><div class="cr-senth"><span><b>${totalChars.toLocaleString("en-US")}</b> characters in ${blocks.length} piece${blocks.length === 1 ? "" : "s"}</span>` +
    `<button class="cr-link" data-copy="prompt" type="button" title="The system prompt and the message, as two labelled parts. Each agent receives the two in its own way, so the labels are not part of what it got.">Copy whole prompt</button></div>` +
    `<div class="cr-stack" aria-hidden="true">${bar}</div><div class="cr-plist">${rows}</div>` +
    (omitted.length > 0 ? `<div class="cr-pmissing">Not included: ${esc(omitted.join(" · "))}</div>` : "") +
    `</div>`
  );
}

function bodyHtml(step: RunStep): string {
  const b = step.body;
  switch (b.kind) {
    case "sent":
      return sentHtml(step);
    case "lines":
      return step.kind === "stopped"
        ? `<div class="cr-stopped">${b.lines.map(esc).join("<br>")}</div>`
        : `<div class="cr-meta">${b.lines.map((l) => `<span class="cr-chip">${esc(l)}</span>`).join("")}</div>`;
    case "quote":
      return b.text !== null
        ? `<blockquote>${esc(b.text)}</blockquote>`
        : `<div class="cr-muted">${esc(b.note ?? "The CLI printed only a running count of thinking tokens, not the thought itself.")}</div>`;
    case "tool":
      return (
        `<div class="cr-tool"><div class="cr-toolh"><span class="cr-toolname">${esc(b.name)}</span><code>${esc(b.input)}</code></div>` +
        (b.result !== null
          ? `<div class="cr-toolr"><div class="cr-toolrh">got back at ${secs(b.resultAtMs ?? step.atMs)}</div><pre>${esc(b.result)}</pre></div>`
          : `<div class="cr-toolr cr-pending">nothing came back</div>`) +
        `</div>`
      );
    case "answer":
      return `<div class="cr-answer">${esc(b.text)}</div>`;
    case "text":
      return `<pre class="cr-printed">${esc(b.text)}</pre>`;
  }
}

function stepHtml(step: RunStep, slowest: boolean, failed: boolean): string {
  const took =
    step.tookMs !== null && step.tookMs >= 50
      ? `<span class="cr-took${slowest ? " cr-slow" : ""}">took ${secs(step.tookMs)}${slowest ? " · slowest step" : ""}</span>`
      : "";
  const tk = step.tokens ? `<span class="cr-tk">${esc(step.tokens)}</span>` : "";
  // collapsed by default; a failed call opens the step left hanging and the stop
  const open =
    failed && (step.kind === "stopped" || (step.body.kind === "tool" && step.body.result === null)) ? " open" : "";
  const raw = step.raw.length > 0 ? `<div class="cr-rawrow">${rawToggle(step.raw)}</div>` : "";
  return (
    `<li class="cr-ev cr-ev-${step.kind}"><span class="cr-dot"></span><details class="cr-evd"${open}>` +
    `<summary class="cr-evh"><span class="cr-evk">${esc(step.label)}</span><span class="cr-evt">at ${secs(step.atMs)}</span>${took}${tk}</summary>` +
    `${bodyHtml(step)}${raw}</details></li>`
  );
}

function traceHtml(view: RunView): string {
  const { totalMs, rows } = view.trace;
  if (rows.length === 0) return "";
  const total = Math.max(1, totalMs);
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => `<span style="left:${f * 100}%">${((f * total) / 1000).toFixed(f * total < 10_000 ? 1 : 0)}s</span>`)
    .join("");
  const row = (r: TraceRow): string =>
    `<div class="cr-trr${r.slowest ? " cr-slow" : ""}"><span class="cr-trn">${esc(r.name)}</span>` +
    `<span class="cr-trk"><span class="cr-trb cr-tr-${r.kind}" style="left:${(r.startMs / total) * 100}%;width:${Math.max(0.8, (r.durMs / total) * 100)}%"></span></span>` +
    `<span class="cr-trd">${secs(r.durMs)}</span><span class="cr-trt">${esc(r.tokens)}</span></div>`;
  return (
    `<div class="cr-trace" data-span="0 – ${secs(totalMs)}, bars to scale"><div class="cr-trh"><span>Trace</span><span class="cr-trax">${ticks}</span><span>Time</span><span>Tokens</span></div>` +
    rows.map(row).join("") +
    `</div>`
  );
}

function stepsHtml(view: RunView): string {
  const failed = view.outcome !== "ok";
  const slowKinds = new Set(view.trace.rows.filter((r) => r.slowest).map((r) => `${r.startMs}:${r.kind}`));
  return `<ol class="cr-evs">${view.steps
    .map((s) => stepHtml(s, slowKinds.has(`${s.atMs}:${s.kind}`), failed))
    .join("")}</ol>`;
}

const STATUS: Record<RunView["outcome"], { glyph: string; cls: string; label: string }> = {
  ok: { glyph: "✓", cls: "cr-ok", label: "answered" },
  failed: { glyph: "✗", cls: "cr-bad", label: "failed" },
  cancelled: { glyph: "■", cls: "cr-stop", label: "stopped" },
};

export function runRowHtml(view: RunView): string {
  const st = STATUS[view.outcome];
  const pick = view.pick
    ? `<span class="cr-pick${view.pick.chosen ? " cr-pick-user" : ""}" title="${esc(view.pick.long)}">${esc(view.pick.tag)}</span>`
    : "";
  const failed = view.outcome !== "ok";
  return (
    `<div class="cr-l1"><span class="cr-n">#${view.n}</span><span class="cr-st ${st.cls}" title="${st.label}">${st.glyph}</span>` +
    `<span class="cr-time">${esc(view.time)}</span><span class="cr-fm">${esc(view.agent)} · ${esc(view.modelShort)}</span>${pick}</div>` +
    (view.modelNote ? `<div class="cr-note">${esc(view.modelNote)}</div>` : "") +
    `<dl class="cr-sum"><dt>Total runtime</dt><dd>${esc(view.runtime)}</dd>` +
    (view.result
      ? `<dt>Result</dt><dd class="cr-err">${esc(view.result.message)}${view.result.stuck ? `<br><span class="cr-plain">${esc(view.result.stuck)}</span>` : ""}</dd>`
      : "") +
    `<dt>Why this answer</dt><dd>${esc(view.why)}</dd></dl>` +
    `<details class="cr-what"${failed ? " open" : ""}><summary class="cr-whsum"><span>What happened · from what was sent to the answer</span>` +
    `<span class="cr-evtools"><button class="cr-link" data-steps="open" type="button">Open all steps</button><button class="cr-link" data-steps="close" type="button">Close all</button></span></summary>` +
    `${traceHtml(view)}${stepsHtml(view)}</details>` +
    `<details class="cr-what"><summary class="cr-whsum"><span>Raw record</span></summary>` +
    `<pre class="cr-rawpre">${esc(prettyJson(view.rawRecord))}</pre>` +
    `<div class="cr-copyrow"><button class="cr-copy" data-copy="record" type="button">Copy the record line</button>` +
    `<button class="cr-copy" data-copy="output" type="button">Copy everything the CLI printed</button></div></details>`
  );
}
