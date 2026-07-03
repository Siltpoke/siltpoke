// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// Project-detail panel + its disk readers, peeled from
// src/cli/report-artifacts.ts.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { LearnedRule } from "../memory/memory";
import type { I18nDict } from "./report-i18n";
import { esc, panelWrap } from "./report-dom";
import { readJsonl, type FeedbackRow } from "./report-panels";

interface ProjectMemoryFile {
  learned_rules?: Partial<LearnedRule>[];
}

interface ProjectStateFile {
  mood?: string;
  bubble_short?: string;
  severity?: string;
  confidence?: string;
  last_updated_ms?: number;
  last_session_id?: string;
}

async function readProjectArtifacts(cwd: string): Promise<{
  memory: ProjectMemoryFile | null;
  state: ProjectStateFile | null;
  recentFeedback: FeedbackRow[];
}> {
  const base = join(cwd, ".siltpoke");
  let memory: ProjectMemoryFile | null = null;
  let state: ProjectStateFile | null = null;
  const memPath = join(base, "memory.json");
  if (existsSync(memPath)) {
    try {
      memory = JSON.parse(await readFile(memPath, "utf8")) as ProjectMemoryFile;
    } catch {
      // ignore
    }
  }
  const statePath = join(base, "state.json");
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(await readFile(statePath, "utf8")) as ProjectStateFile;
    } catch {
      // ignore
    }
  }
  const recentFeedback = await readJsonl<FeedbackRow>(
    join(base, "recent_feedback.jsonl"),
  );
  return { memory, state, recentFeedback };
}

export async function renderProjectDetail(
  cwds: Set<string>,
  t: I18nDict,
): Promise<string> {
  if (cwds.size === 0) {
    return panelWrap(t.project_detail, `<p class="muted">${esc(t.no_projects_detail)}</p>`, false);
  }
  const blocks: string[] = [];
  for (const cwd of cwds) {
    const { memory, state, recentFeedback } = await readProjectArtifacts(cwd);
    if (!memory && !state && recentFeedback.length === 0) continue;
    const rules = memory?.learned_rules ?? [];
    const rulesBlock = rules.length
      ? `<table class="dense">
           <thead><tr><th>id</th><th>${esc(t.dial_col)}</th><th>${esc(t.why_col)}</th></tr></thead>
           <tbody>${rules
             .map(
               (r) =>
                 `<tr><td><code>${esc(r.id ?? "")}</code></td><td>${esc(r.category ?? "")}</td><td>${esc(r.rule ?? "")}</td></tr>`,
             )
             .join("")}</tbody>
         </table>`
      : `<p class="muted small">${esc(t.no_learned_rules)}</p>`;

    const stateBlock = state
      ? `<pre><code>${esc(JSON.stringify(state, null, 2))}</code></pre>`
      : `<p class="muted small">—</p>`;

    const feedbackBlock = recentFeedback.length
      ? `<table class="dense">
           <thead><tr><th>${esc(t.time_col)}</th><th>${esc(t.critique_col)}</th><th>${esc(t.verdict_col)}</th><th>${esc(t.reason_col)}</th></tr></thead>
           <tbody>${recentFeedback
             .slice(-20)
             .reverse()
             .map(
               (r) =>
                 `<tr><td>${esc((r.ts ?? "").slice(0, 19))}</td><td><code>${esc(r.critique_id ?? "")}</code></td><td>${esc(r.verdict ?? "")}</td><td>${esc(r.reason ?? "")}</td></tr>`,
             )
             .join("")}</tbody>
         </table>`
      : `<p class="muted small">—</p>`;

    blocks.push(`
<details class="inbox">
  <summary>
    <span class="inbox-name">${esc(basename(cwd))}</span>
    <span class="muted small inbox-path"><code>${esc(cwd)}</code></span>
  </summary>
  <div class="kv-k" style="margin-top:0.5rem">${esc(t.learned_rules)}</div>
  ${rulesBlock}
  <div class="kv-k" style="margin-top:0.75rem">${esc(t.project_state_label)}</div>
  ${stateBlock}
  <div class="kv-k" style="margin-top:0.75rem">${esc(t.project_recent_feedback)}</div>
  ${feedbackBlock}
</details>`);
  }
  if (blocks.length === 0) {
    return panelWrap(t.project_detail, `<p class="muted">${esc(t.no_projects_detail)}</p>`, false);
  }
  return panelWrap(t.project_detail, blocks.join(""), false);
}

