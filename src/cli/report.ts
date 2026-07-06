// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Dashboard renderer + `bun run report` entrypoint.
 *
 * `renderReport()` stitches together state Siltpoke already keeps on disk into
 * a single self-contained HTML document (no network, no JS framework in the
 * output) and writes it to `~/.siltpoke/report.html` (or `{cwd}/.siltpoke/
 * report.html` in project scope). The daemon uses this renderer to produce
 * the page it serves.
 *
 * The `bun run report` CLI entrypoint (see `import.meta.main` below) does NOT
 * write that file — it ensures the daemon is up and opens the live dashboard
 * at http://127.0.0.1:9876/ in the browser.
 *
 * Aesthetic is Tamagotchi-style: a thick rounded LCD "shell" wraps the pet
 * portrait + stats. Everything else (per-project tables, brain-call log,
 * recent verdicts, embedded docs) lives in a second column on wide screens
 * and stacks below on mobile.
 */
import { readFile } from "node:fs/promises";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { runCard, type CardResult, type ProjectSummary } from "./card";
import { runStats, type StatsResult } from "./stats";
import { readStatus } from "../state/critique-status";
import { getSpecies } from "../face/species";
import { resolveArt } from "../state/pose";
import { loadPersonality } from "../brain/personality";

import { type I18nDict, pickDict, fmt } from "./report-i18n";
import {
  esc,
  jsonForScript,
  severityClass,
  panelWrap,
  moodEmoji,
  renderPetShell,
} from "./report-dom";
import {
  type BrainCallRow,
  type FeedbackRow,
  type ProjectInbox,
  type UsageEventRow,
  readJsonl,
  bucketByDay,
  renderTodayPanel,
  renderChart,
  renderProjects,
  renderBrainCalls,
  renderVerdicts,
  buildProjectInboxes,
  renderInboxes,
  renderFooter,
} from "./report-panels";
import {
  readRawConfig,
  readRawProgression,
  renderGenesis,
  renderProgressionDetail,
  renderConfigPanel,
  renderErrorLog,
  renderProjectDetail,
  renderReferences,
} from "./report-artifacts";
import { buildClientScript } from "./report-client-script";
import { STYLE } from "./report-style";



export interface ReportOptions {
  homeBase?: string;
  /** Per-project mode: cwd of the project. When set, output goes to
   *  {projectCwd}/.siltpoke/report.html and all data is filtered to that
   *  project. When undefined, the report runs in global mode. */
  projectCwd?: string;
  outPath?: string;
  now?: () => Date;
  /** Phase-4 server mode. When true the client wires A/B/C buttons + the
   *  config form to POST endpoints (/api/action, /api/config). Static
   *  snapshots leave serveMode=false and the same UI falls back to
   *  client-only animations + copy-JSON. */
  serveMode?: boolean;
}

export interface ReportResult {
  outPath: string;
  projectsTouched: number;
  pendingTotal: number;
  mode: "project" | "global";
}

function siltpokeHome(envHome: string | undefined): string {
  return join(envHome ?? "", ".siltpoke");
}

/**
 * Resolve project mode: a directory counts as "in a Siltpoke project" iff
 * it has a `.siltpoke/` subdirectory. Caller passes the cwd to consider
 * (typically `process.cwd()` from the CLI). Returns the cwd if it qualifies,
 * else undefined → global mode.
 */
export function detectProjectCwd(cwd: string): string | undefined {
  const base = join(cwd, ".siltpoke");
  return existsSync(base) ? cwd : undefined;
}

export async function buildReport(opts: ReportOptions = {}): Promise<ReportResult> {
  const homeBase = opts.homeBase ?? siltpokeHome(process.env.HOME);
  const now = (opts.now ?? (() => new Date()))();
  const projectCwd = opts.projectCwd;
  const inProject = typeof projectCwd === "string" && projectCwd.length > 0;
  const outPath =
    opts.outPath ??
    (inProject
      ? join(projectCwd!, ".siltpoke", "report.html")
      : join(homeBase, "report.html"));

  const personality = await loadPersonality(homeBase);
  const language = personality.language || "en";
  const t = pickDict(language);
  const langIsEn = language.startsWith("en");

  const [
    card,
    stats,
    brainCallsAll,
    feedbackGlobal,
    usageEventsAll,
    rawCfg,
    rawProg,
    referencesHtml,
    errorLogHtml,
  ] = await Promise.all([
    runCard({ homeBase, now: () => now }),
    runStats({ homeBase, now: () => now }),
    readJsonl<BrainCallRow>(join(homeBase, "brain-calls.jsonl")),
    readJsonl<FeedbackRow>(join(homeBase, "feedback-archive.jsonl")),
    readJsonl<UsageEventRow>(join(homeBase, "usage-events.jsonl")),
    readRawConfig(homeBase),
    readRawProgression(homeBase),
    renderReferences(t, langIsEn),
    renderErrorLog(homeBase, t),
  ]);

  // Project scope: filter brain-calls, feedback, usage, inboxes, etc. to the
  // current project. Global scope: pass through.
  const brainCalls = inProject
    ? brainCallsAll.filter((r) => r.cwd === projectCwd)
    : brainCallsAll;

  // usage-events.jsonl rows don't carry cwd; we map via session_id from the
  // brain-call log. (A reflection call's session_id is the critique_id, not
  // the project session — those won't match. That's fine: refl entries land
  // in the global Today panel only, which is what we want.)
  const sessionIds = inProject
    ? new Set(brainCalls.map((r) => r.session_id).filter((s): s is string => !!s))
    : null;
  const usageEvents =
    sessionIds === null
      ? usageEventsAll
      : usageEventsAll.filter((u) => u.session_id && sessionIds.has(u.session_id));

  // Per-project feedback comes from {projectCwd}/.siltpoke/recent_feedback.jsonl
  // (already FIFO of last 20). Global mode falls back to the cross-project
  // feedback-archive.
  const feedback = inProject
    ? await readJsonl<FeedbackRow>(
        join(projectCwd!, ".siltpoke", "recent_feedback.jsonl"),
      )
    : feedbackGlobal;

  const cwds = inProject ? new Set<string>([projectCwd!]) : new Set<string>();
  if (!inProject) {
    for (const row of brainCallsAll) {
      if (row.cwd) cwds.add(row.cwd);
    }
  }
  const inboxes = await buildProjectInboxes(cwds);
  const pendingTotal = inboxes.reduce((s, b) => s + b.pending.length, 0);
  const projectDetailHtml = await renderProjectDetail(cwds, t);

  const buckets = bucketByDay(
    brainCalls.filter((r) => !r.skipped && r.timestamp).map((r) => r.timestamp!),
    now,
    7,
  );

  // Project-scoped Today metrics: filter brain-calls + usage by project.
  // The original card/stats are global; we overlay project values when in
  // project mode so the Today panel matches the rest of the page.
  if (inProject) {
    const todayKey = now.toISOString().slice(0, 10);
    const projectCallsToday = brainCalls.filter(
      (r) => !r.skipped && r.timestamp?.startsWith(todayKey),
    ).length;
    const projectUsageToday = usageEvents.filter((u) =>
      u.ts?.startsWith(todayKey),
    );
    const projectCostToday = projectUsageToday.reduce(
      (s, u) => s + (u.total_cost_usd ?? 0),
      0,
    );
    const projectReflectionsToday = projectUsageToday.filter(
      (u) => u.kind === "reflection",
    ).length;
    card.brain_calls_today = projectCallsToday;
    card.reflections_today = projectReflectionsToday;
    card.cost_today_usd = projectCostToday;
    stats.brain_calls = projectCallsToday;
    stats.reflections = projectReflectionsToday;
    stats.total_cost_usd = projectCostToday;
  }

  // Recent unique bubbles, newest first, capped at 20. Powers the B button.
  const seenBubbles = new Set<string>();
  const recentBubbles: string[] = [];
  for (let i = brainCalls.length - 1; i >= 0 && recentBubbles.length < 20; i--) {
    const b = brainCalls[i]?.brain_output?.bubble_short;
    if (!b || seenBubbles.has(b)) continue;
    seenBubbles.add(b);
    recentBubbles.push(b);
  }
  if (card.bubble && !seenBubbles.has(card.bubble)) {
    recentBubbles.unshift(card.bubble);
  }

  const projectName = inProject ? basename(projectCwd!) : "";
  const modeBadge = inProject
    ? `<span class="mode-badge mode-project" title="${esc(fmt(t.mode_project_note, { project: projectName }))}">${esc(t.mode_project)} · ${esc(projectName)}</span>`
    : `<span class="mode-badge mode-global" title="${esc(t.mode_global_note)}">${esc(t.mode_global)}</span>`;

  // In project mode the multi-project table is meaningless (only one
  // project). Hide it.
  const projectsHtml = inProject ? "" : renderProjects(card.projects, t);

  // Right column splits into 5 horizontal tabs. Following dashboard UX
  // research (3–6 categories ideal; sidebar for 7+), this keeps the
  // common stuff in Overview and groups related drill-downs together
  // so a click jumps you there without a half-mile scroll.
  const tabNav = `
  <nav class="tab-nav" role="tablist">
    <button class="tab-btn" data-tab="overview" role="tab" aria-selected="true">${esc(t.tab_overview)}</button>
    <button class="tab-btn" data-tab="tasks" role="tab" aria-selected="false">${esc(t.tab_tasks)} ${pendingTotal > 0 ? `<span class="pill">${pendingTotal}</span>` : ""}</button>
    <button class="tab-btn" data-tab="growth" role="tab" aria-selected="false">${esc(t.tab_growth)}</button>
    <button class="tab-btn" data-tab="diagnostics" role="tab" aria-selected="false">${esc(t.tab_diagnostics)}</button>
    <button class="tab-btn" data-tab="reference" role="tab" aria-selected="false">${esc(t.tab_reference)}</button>
  </nav>`;

  const overviewBody = `${renderTodayPanel(card, stats, t)}${renderChart(buckets, t)}${projectsHtml}`;
  const tasksBody = `${renderInboxes(inboxes, t)}${renderBrainCalls(brainCalls, usageEvents, t)}${renderVerdicts(feedback, t)}`;
  const growthBody = `${renderGenesis(rawCfg, t)}${renderProgressionDetail(rawProg, t)}${projectDetailHtml}`;
  const diagnosticsBody = errorLogHtml;
  const referenceBody = referencesHtml;

  const html = `<!doctype html>
<html lang="${esc(language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Siltpoke · ${esc(card.name)}${inProject ? ` · ${esc(projectName)}` : ""}</title>
  <style>${STYLE}</style>
</head>
<body>
  <div class="wrap">
    <div class="left-col">
      ${renderPetShell(card, t)}
      <div class="mode-strip">${modeBadge}</div>
      ${renderConfigPanel(rawCfg, t)}
    </div>
    <main class="panels">
      ${tabNav}
      <section class="tab-content" data-tab="overview">${overviewBody}</section>
      <section class="tab-content" data-tab="tasks" hidden>${tasksBody}</section>
      <section class="tab-content" data-tab="growth" hidden>${growthBody}</section>
      <section class="tab-content" data-tab="diagnostics" hidden>${diagnosticsBody}</section>
      <section class="tab-content" data-tab="reference" hidden>${referenceBody}</section>
    </main>
  </div>
  ${renderFooter(now, t)}
  <div id="xp-toast" class="xp-toast" hidden></div>
  ${buildClientScript({ species: card.species, rawCfg, t })}
</body>
</html>`;

  // Ensure the parent directory exists. In project mode that's
  // {projectCwd}/.siltpoke/, which already exists by definition (the
  // detector required it), but we still mkdir -p for safety in tests
  // that pass outPath directly.
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, html, "utf8");

  return {
    outPath,
    projectsTouched: inboxes.length,
    pendingTotal,
    mode: inProject ? "project" : "global",
  };
}

if (import.meta.main) {
  const noOpen = process.argv.includes("--no-open");
  const homeBase = join(process.env.HOME ?? "", ".siltpoke");

  // The daemon owns the dashboard. Ensure daemon is up, then open browser.
  async function ensureDaemonUp(): Promise<void> {
    const pidPath = join(homeBase, "siltpoked.pid");
    let alive = false;
    if (existsSync(pidPath)) {
      try {
        const r = await fetch("http://127.0.0.1:9876/api/ping", {
          signal: AbortSignal.timeout(250),
        });
        alive = r.ok;
      } catch {
        alive = false;
      }
    }
    if (!alive) {
      // Lazy-spawn detached daemon.
      const daemonScript = new URL("./daemon.ts", import.meta.url).pathname;
      const proc = Bun.spawn(["bun", daemonScript, "start"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      proc.unref();
      // Poll up to 3s.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          const r = await fetch("http://127.0.0.1:9876/api/ping", {
            signal: AbortSignal.timeout(100),
          });
          if (r.ok) return;
        } catch {
          /* keep polling */
        }
      }
      throw new Error("siltpoked failed to start within 3s");
    }
  }

  await ensureDaemonUp();
  // "/" serves Wave 1 Home — the only surface now. The legacy tamagotchi
  // report (formerly "/dashboard") is retired.
  const url = "http://127.0.0.1:9876/";
  process.stdout.write(`Siltpoke: ${url}\n`);
  if (!noOpen) {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] });
  }
  process.exit(0);
}
