// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * consolidate() — batched memory summarizer orchestrator.
 *
 * Design constraints:
 *   PQ1 — Summarizer trigger (hybrid: stop_count >= 10 OR days_since >= 7, cold-start guard)
 *   PQ2 — Summarizer prompt (active facts + recent critiques + recent dismissals)
 *   PQ6 — Pruning policy (active + >90d + conf<0.5 → retired; never hard-delete)
 *
 * IO is contained to buildSummarizerContext (load) and writeMemory (save).
 * Decision logic (trigger gate, minimum-signal guard) is pure.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expandLanguage, loadPersonality } from "../brain/personality";
import { makeRoleRawBrain } from "../brain/role-brain";
import { readSession as readSessionFile } from "../chat/jsonl-store";
import type { ApplyResult } from "./apply-candidates";
import { applyCandidates } from "./apply-candidates";
import { loadRecentChatMessages } from "./chat-signal";
import type { CommitSignal } from "./coding-signal";
import { loadRecentCommits, summarizeCriticEvents } from "./coding-signal";
import type { DecayResult } from "./decay";
import { proposeDecayedFacts } from "./decay";
import { applyEpisodes } from "./episode";
import { applyEventFragments, groundEventDrafts } from "./event-fragment";
import { extractEventFragments } from "./extract-events";
import type { FeedbackArchiveEntry } from "./feedback-archive";
import type { CoreMemory } from "./memory";
import { readMemory, writeMemory } from "./memory";
import type { PruneResult } from "./prune";
import { pruneStaleFacts } from "./prune";
import { isRubricNoiseCritique } from "./rubric-noise";
import { callSummarizerBrain } from "./summarizer";
import { type SynthesizeFn, synthesizeEpisodes } from "./synthesize-episodes";
import { tagUntaggedEntities } from "./tag-entities";

// Re-exported for back-compat: callers/tests import the rubric-noise predicate
// from the consolidate surface. Definition lives in ./rubric-noise.
export { isRubricNoiseCritique };
// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConsolidateResult =
  | { ran: false; reason: string }
  | {
      ran: true;
      candidates: number;
      apply: ApplyResult;
      decay: DecayResult;
      prune: PruneResult;
      // Episodic capture: count of NEW event fragments applied this run
      // (after code-side grounding + dedup). Mirrors `candidates`.
      eventFragments: number;
      // Episode-synthesis: count of clusters actually narrated
      // this run (new day-buckets created + existing day-buckets re-narrated
      // after a member-set change). Zero whenever the cost guard
      // skips every cluster — mirrors `eventFragments`'s "count of what this
      // run actually did" semantics.
      episodesSynthesized: number;
      durationMs: number;
    };

export type ConsolidateOpts = {
  homeBase: string;
  // Repo-local `.siltpoke` dir ({cwd}/.siltpoke). The critic writes critiques
  // project-local, so the critique loader must read from here. When absent,
  // critiques fall back to homeBase (preserves back-compat + existing tests).
  // homeBase still drives usage-events counting + memory resolution.
  projectBase?: string;
  // HIGH-finding fix: the repo that fired the Stop event whose consolidate
  // cycle this is. Threaded into readMemory/writeMemory so consolidate keys
  // the SAME V3 project slice the critic just read from — the daemon's own
  // process.cwd() (frozen at launch) is never the right key for a specific
  // event's repo. Omitted = process.cwd() (today's behavior, unchanged).
  projectCwd?: string;
  now?: Date;
  triggerThresholds?: {
    minStopCountSinceLast?: number;
    minDaysSinceLast?: number;
  };
  deps?: {
    callSummarizerBrain?: typeof callSummarizerBrain;
    readMemory?: (homeBase: string, projectCwd?: string) => Promise<CoreMemory | null>;
    writeMemory?: (homeBase: string, m: CoreMemory, projectCwd?: string) => Promise<void>;
    loadRecentCritiques?: (homeBase: string, sinceTime: Date) => Promise<string[]>;
    loadRecentDismissals?: (homeBase: string, sinceTime: Date) =>
      Promise<Array<{ rule_category: string; reason: string; date: string }>>;
    loadRecentChatMessages?: typeof loadRecentChatMessages;
    // Chat-recall:
    readSession?: typeof readSessionFile;
    // Coding-activity:
    loadRecentCommits?: typeof loadRecentCommits;
    loadAllCritiqueEntries?: typeof loadAllCritiqueEntries;
    // Unfiltered variant used for critic-category counts (includes rubric-noise entries).
    loadAllCritiqueEntriesUnfiltered?: typeof loadAllCritiqueEntriesUnfiltered;
    // Entity-model janitor that batch-tags untagged active facts.
    // Mirrors the `callSummarizerBrain` injection seam (consolidate.ts ~line 504)
    // so consolidate tests can inject a stub and assert it's invoked.
    tagEntities?: typeof tagUntaggedEntities;
    // Episodic extractor. Mirrors the `callSummarizerBrain` injection
    // seam so tests can stub the LLM event extractor. Never-throws by contract.
    extractEventFragments?: typeof extractEventFragments;
    // Episode-synthesis: injectable episode-narrator Haiku call.
    // Mirrors the `extractEventFragments` injection seam (consolidate tests
    // stub the model call, no live Haiku). Deliberately the RAW model-call dep
    // (`SynthesizeFn`, one level below the `synthesizeEpisodes` orchestrator)
    // rather than the whole orchestrator — `synthesizeEpisodes` still owns
    // clustering + the skip-if-unchanged cost guard, so injecting only the
    // model call lets consolidate tests exercise the REAL clustering/cost-guard
    // logic end-to-end, not a mocked whole-function bypass.
    synthesizeFn?: SynthesizeFn;
    // Injectable personality/config loader (episode narrative follows
    // `config.language`, matching chat/critique). consolidate does not
    // otherwise thread language today; this reuses the SAME config source the
    // rest of the pass already reads from (`../brain/personality`'s
    // `loadPersonality(homeBase)`, see `handle-stop.ts`) rather than inventing
    // a new config read. Defaults to the real loader.
    loadPersonality?: typeof loadPersonality;
  };
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MIN_STOP_COUNT = 10;
const DEFAULT_MIN_DAYS = 7;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CRITIQUES_CAP = 20;
const DISMISSALS_CAP = 20;

// ---------------------------------------------------------------------------
// Trigger gate — pure
// ---------------------------------------------------------------------------

type TriggerInput = {
  stopCountSinceLast: number;
  daysSinceLast: number;
  minStopCount: number;
  minDays: number;
};

function triggerGateSatisfied(input: TriggerInput): boolean {
  const { stopCountSinceLast, daysSinceLast, minStopCount, minDays } = input;
  // Cold-start guard: skip if less than 1 full day since last consolidation
  // (prevents tight loops if consolidate fires rapidly back-to-back).
  // The `<= 0` check never fired for normal fractional values; `< 1` is
  // the intended boundary.
  if (daysSinceLast < 1) return false;
  return stopCountSinceLast >= minStopCount || daysSinceLast >= minDays;
}

// ---------------------------------------------------------------------------
// Count brain_calls in usage-events.jsonl since a given timestamp
// ---------------------------------------------------------------------------

async function countBrainCallsSince(
  homeBase: string,
  since: Date,
): Promise<number> {
  const eventsPath = join(homeBase, "usage-events.jsonl");
  if (!existsSync(eventsPath)) return 0;

  let count = 0;
  try {
    const raw = await readFile(eventsPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as { ts?: string; kind?: string };
        if (
          ev.kind === "main" &&
          typeof ev.ts === "string" &&
          new Date(ev.ts) > since
        ) {
          count++;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // unreadable → count as 0
  }
  return count;
}

// ---------------------------------------------------------------------------
// Critique loader — reads <base>/critiques/archive/**/*.md
// The base is the CALLER's choice, not necessarily the home base: the critic
// writes critiques project-local, so consolidate() and the Memory Book routes
// pass a project base here. See an internal design note
// wrong-base.md — a stale "~/.siltpoke" comment plus a homeBase parameter name
// on this very function sent one audit to the wrong conclusion.
// Parses YAML frontmatter for `timestamp` and extracts `critique_for_claude`
// body. Returns up to CRITIQUES_CAP strings, sorted newest-first.
// ---------------------------------------------------------------------------

type CritiqueEntry = { ts: Date; body: string };

function parseCritiqueFile(content: string): CritiqueEntry | null {
  // Frontmatter: ---\nkey: value\n---
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;
  const frontmatterStr = frontmatterMatch[1] ?? "";

  const tsMatch = frontmatterStr.match(/^timestamp:\s*(.+)$/m);
  if (!tsMatch) return null;
  const ts = new Date(tsMatch[1]?.trim());
  if (Number.isNaN(ts.getTime())) return null;

  // Extract critique_for_claude body between the fence markers after the heading
  const bodyMatch = content.match(
    /## Critique \(for Claude[^\n]*\)\n\n(`{3,})\n([\s\S]*?)\n\1/,
  );
  if (!bodyMatch) return null;
  const body = bodyMatch[2]?.trim() ?? "";
  if (!body) return null;

  return { ts, body };
}

type RawCritiqueEntry = { id: string; ts: Date; body: string };

/**
 * Walk `base/critiques/archive/<date>/*.md`, parse each critique file,
 * and collect entries passing `predicate` — the shared file-walking core for
 * loadRecentCritiques / loadAllCritiqueEntries /
 * loadAllCritiqueEntriesUnfiltered, which differ only in which entries pass
 * (time-gate + rubric-noise filter, rubric-noise filter only, or no filter)
 * and how the result is shaped. Returns entries newest-first (by ts, desc);
 * unreadable files/dirs are skipped, a missing/unreadable archive → [].
 */
async function walkCritiqueArchive(
  base: string,
  predicate: (entry: CritiqueEntry) => boolean,
): Promise<RawCritiqueEntry[]> {
  const archiveRoot = join(base, "critiques", "archive");
  if (!existsSync(archiveRoot)) return [];

  const entries: RawCritiqueEntry[] = [];

  try {
    const dateDirs = await readdir(archiveRoot);
    for (const dateDir of dateDirs) {
      const dayPath = join(archiveRoot, dateDir);
      let files: string[];
      try {
        files = await readdir(dayPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const id = file.slice(0, -3); // strip ".md" extension to get the id
        try {
          const content = await readFile(join(dayPath, file), "utf8");
          const entry = parseCritiqueFile(content);
          if (entry && predicate(entry)) {
            entries.push({ id, ts: entry.ts, body: entry.body });
          }
        } catch {
          // skip unreadable file
        }
      }
    }
  } catch {
    return [];
  }

  entries.sort((a, b) => b.ts.getTime() - a.ts.getTime());
  return entries;
}

export async function loadRecentCritiques(
  base: string,
  sinceTime: Date,
): Promise<string[]> {
  // Bug#4-C: skip deterministic rubric-noise fallbacks — they are not
  // episodic user-state signal and produce junk facts downstream.
  const entries = await walkCritiqueArchive(
    base,
    (e) => e.ts > sinceTime && !isRubricNoiseCritique(e.body),
  );
  return entries.slice(0, CRITIQUES_CAP).map((e) => e.body);
}

// ---------------------------------------------------------------------------
// All-critiques loader for the Memory Book
//
// Reads every critique file from the archive, extracts (id, ts, body), and
// returns them newest-first with no time-gate and no cap.
// rubric-noise entries are excluded (same filter as loadRecentCritiques).
// ---------------------------------------------------------------------------

export type CritiqueLogEntry = {
  id: string;   // critique id — filename without ".md"
  ts: string;   // ISO timestamp from frontmatter
  body: string; // critique_for_claude body
};

export async function loadAllCritiqueEntries(
  base: string,
): Promise<CritiqueLogEntry[]> {
  const entries = await walkCritiqueArchive(base, (e) => !isRubricNoiseCritique(e.body));
  return entries.map((e) => ({
    id: e.id,
    ts: e.ts.toISOString(),
    body: e.body,
  }));
}

// ---------------------------------------------------------------------------
// Unfiltered all-critiques loader for critic-category COUNTS.
//
// Same structure as loadAllCritiqueEntries but WITHOUT the isRubricNoiseCritique
// filter. Rubric-flag entries (god-file/long-function/…) start with the fixed
// "Rubric flagged concerns..." prefix, which is exactly what RULE_MARKERS inside
// summarizeCriticEvents targets. The filtered loader excluded them → byCategory≈{}
// in production. This unfiltered variant keeps them so the counts are real.
// Bodies never reach the summarizer prompt (recentCritiques stays noise-filtered);
// only the category tallies are forwarded.
// ---------------------------------------------------------------------------

export async function loadAllCritiqueEntriesUnfiltered(
  base: string,
): Promise<CritiqueLogEntry[]> {
  // no rubric-noise filter — include all for category counts
  const entries = await walkCritiqueArchive(base, () => true);
  return entries.map((e) => ({
    id: e.id,
    ts: e.ts.toISOString(),
    body: e.body,
  }));
}

// ---------------------------------------------------------------------------
// Dismissal loader — reads ~/.siltpoke/feedback-archive.jsonl
// Returns up to DISMISSALS_CAP entries where verdict === "dismissed" and
// ts > sinceTime, sorted newest-first.
// ---------------------------------------------------------------------------

export async function loadRecentDismissals(
  homeBase: string,
  sinceTime: Date,
): Promise<Array<{ rule_category: string; reason: string; date: string }>> {
  const archivePath = join(homeBase, "feedback-archive.jsonl");
  if (!existsSync(archivePath)) return [];

  const results: Array<{
    ts: Date;
    rule_category: string;
    reason: string;
    date: string;
  }> = [];

  try {
    const raw = await readFile(archivePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as FeedbackArchiveEntry;
        if (
          ev.verdict === "dismissed" &&
          typeof ev.ts === "string" &&
          new Date(ev.ts) > sinceTime
        ) {
          const rule_category = ev.reflection?.rule_category ?? "unknown";
          const reason = ev.reason ?? "";
          const date = ev.ts.slice(0, 10);
          results.push({ ts: new Date(ev.ts), rule_category, reason, date });
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    return [];
  }

  results.sort((a, b) => b.ts.getTime() - a.ts.getTime());
  return results.slice(0, DISMISSALS_CAP).map(({ rule_category, reason, date }) => ({
    rule_category,
    reason,
    date,
  }));
}

// ---------------------------------------------------------------------------
// buildSummarizerContext — IO layer; loads data from disk
// ---------------------------------------------------------------------------

export async function buildSummarizerContext(
  homeBase: string,
  memory: CoreMemory,
  lastConsolidatedAt: Date,
  opts?: {
    // Critiques base: repo-local `.siltpoke`; when absent falls back to homeBase.
    critiquesBase?: string;
    loadRecentCritiques?: typeof loadRecentCritiques;
    loadRecentDismissals?: typeof loadRecentDismissals;
    loadRecentChatMessages?: typeof loadRecentChatMessages;
    // Chat-recall: injectable JSONL reader for unit tests.
    readSession?: typeof readSessionFile;
    // Coding-activity loaders (injectable for tests).
    projectRoot?: string;
    loadRecentCommits?: typeof loadRecentCommits;
    loadAllCritiqueEntries?: typeof loadAllCritiqueEntries;
    // Unfiltered loader for critic-category counts (includes rubric-noise entries).
    // Falls back to loadAllCritiqueEntries if not provided (backward compat with
    // tests written before this loader was added).
    loadAllCritiqueEntriesUnfiltered?: typeof loadAllCritiqueEntriesUnfiltered;
  },
) {
  const critiquesLoader = opts?.loadRecentCritiques ?? loadRecentCritiques;
  const dismissalsLoader = opts?.loadRecentDismissals ?? loadRecentDismissals;
  const chatLoader = opts?.loadRecentChatMessages ?? loadRecentChatMessages;
  const readSessionFn = opts?.readSession ?? readSessionFile;
  const critiquesBase = opts?.critiquesBase ?? homeBase;
  const activeFacts = memory.facts
    .filter((f) => f.status === "active")
    .map((f) => ({ id: f.id, claim: f.text, confidence: f.confidence }));

  const [recentCritiques, recentDismissals, recentChat] = await Promise.all([
    critiquesLoader(critiquesBase, lastConsolidatedAt),
    // Reading <homeBase>/feedback-archive.jsonl is CORRECT and stays. An earlier
    // TODO here claimed the opposite — that the archive was "absent in practice"
    // and dismissals really landed in preference-log.jsonl — and had the direction
    // exactly backwards. Measured 2026-08-19: feedback-archive.jsonl holds the only
    // genuine dismissals on disk (two, with reflexion rules attached), while
    // preference-log.jsonl held zero real entries because the dismiss/ack/forward
    // CLIs dropped their append at process.exit. That is fixed at the write side
    // (src/cli/{dismiss,ack,mark-forwarded}.ts) rather than by re-pointing this
    // loader: the two files are different records, not duplicates — the archive is
    // the durable verdict store, preference-log is the raw signal stream.
    dismissalsLoader(homeBase, lastConsolidatedAt),
    chatLoader(homeBase, lastConsolidatedAt),
  ]);

  // Populate sessionsNeedingSummary from the JSONL
  // store. Rule: active sessions (ended_at === null) OR sessions that ended after
  // the last consolidation run. Capped at 20 to match the prompt section slice.
  const lastConsolidatedAtStr = lastConsolidatedAt.toISOString();
  const sessionsToSummarize = memory.chat_sessions
    .filter((s) => s.ended_at === null || s.ended_at > lastConsolidatedAtStr)
    .slice(0, 20);

  const sessionsNeedingSummary = await Promise.all(
    sessionsToSummarize.map(async (s) => {
      const messages = await readSessionFn(homeBase, s.id);
      // Bounded excerpt: first 2 + last 2 turns (no duplicates when ≤ 4 messages).
      const excerptMsgs = messages.length <= 4
        ? messages
        : [...messages.slice(0, 2), ...messages.slice(-2)];
      const excerpt = excerptMsgs
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
        .slice(0, 400);
      return { id: s.id, started_at: s.started_at, message_count: s.message_count, excerpt };
    }),
  );

  // Populate codingActivity from injectable loaders.
  // commits: only when projectRoot is supplied; degrades to [] otherwise.
  // criticSummary: summary of all rubric-category counts since lastConsolidatedAt.
  const commitsLoader = opts?.loadRecentCommits ?? loadRecentCommits;
  // Use the unfiltered loader for critic-event counts — rubric-noise bodies (those
  // starting with "Rubric flagged concerns the model didn't surface:") ARE the
  // rubric-flag entries that RULE_MARKERS targets (god-file/long-function/…).
  // The filtered loader (loadAllCritiqueEntries) excluded them → byCategory≈{} in
  // production. Fall back to the filterd injectable for backward compat with tests
  // written before the unfiltered loader was added.
  const critiqueEntriesUnfilteredLoader =
    opts?.loadAllCritiqueEntriesUnfiltered ??
    opts?.loadAllCritiqueEntries ??
    loadAllCritiqueEntriesUnfiltered;
  const commits: CommitSignal[] = opts?.projectRoot
    ? await commitsLoader(opts.projectRoot, lastConsolidatedAt)
    : [];
  const allCritiques = await critiqueEntriesUnfilteredLoader(critiquesBase);
  const criticSummary = summarizeCriticEvents(allCritiques, lastConsolidatedAt);

  return {
    activeFacts,
    recentCritiques,
    recentDismissals,
    recentChat,
    sessionsNeedingSummary,
    codingActivity: { commits, criticSummary },
  };
}

// ---------------------------------------------------------------------------
// consolidate — main orchestrator
// ---------------------------------------------------------------------------

export async function consolidate(opts: ConsolidateOpts): Promise<ConsolidateResult> {
  const {
    homeBase,
    projectBase,
    projectCwd,
    now = new Date(),
    triggerThresholds,
    deps,
  } = opts;

  const minStopCount =
    triggerThresholds?.minStopCountSinceLast ?? DEFAULT_MIN_STOP_COUNT;
  const minDays = triggerThresholds?.minDaysSinceLast ?? DEFAULT_MIN_DAYS;

  const readMemoryFn = deps?.readMemory ?? readMemory;
  const writeMemoryFn = deps?.writeMemory ?? writeMemory;
  const summarizerFn = deps?.callSummarizerBrain ?? callSummarizerBrain;
  const tagEntitiesFn = deps?.tagEntities ?? tagUntaggedEntities;
  const extractEventsFn = deps?.extractEventFragments ?? extractEventFragments;
  // Undefined (not defaulted here) is intentional: `synthesizeEpisodes`
  // owns the real/default Haiku wiring internally (`opts.synthesizeFn ??
  // defaultSynthesizeFn`) — defaulting it here too would just duplicate that.
  const synthesizeFnDep = deps?.synthesizeFn;
  const loadPersonalityFn = deps?.loadPersonality ?? loadPersonality;
  // Step 1: load memory
  const memory = await readMemoryFn(homeBase, projectCwd);
  if (!memory) {
    return { ran: false, reason: "memory not found" };
  }

  // Step 2: trigger gate
  const lastConsolidatedAt = new Date(memory.last_consolidated_at);
  const daysSinceLast =
    (now.getTime() - lastConsolidatedAt.getTime()) / (24 * 3600 * 1000);

  const stopCountSinceLast = await countBrainCallsSince(homeBase, lastConsolidatedAt);

  const gateOk = triggerGateSatisfied({
    stopCountSinceLast,
    daysSinceLast,
    minStopCount,
    minDays,
  });

  if (!gateOk) {
    return { ran: false, reason: "trigger gate not satisfied" };
  }

  // Step 3: build context
  // Commits are project-local signal; only populate when projectBase
  // is provided (indicating a real project context). Derive project root from
  // projectBase's parent directory (.siltpoke lives at project root).
  const projectRoot = projectBase ? dirname(projectBase) : undefined;
  const context = await buildSummarizerContext(homeBase, memory, lastConsolidatedAt, {
    // Critiques are written project-local; read them from projectBase when given.
    critiquesBase: projectBase ?? homeBase,
    loadRecentCritiques: deps?.loadRecentCritiques ?? loadRecentCritiques,
    loadRecentDismissals: deps?.loadRecentDismissals ?? loadRecentDismissals,
    loadRecentChatMessages: deps?.loadRecentChatMessages ?? loadRecentChatMessages,
    readSession: deps?.readSession ?? readSessionFile,
    // Pass project root so loadRecentCommits can query git log.
    projectRoot,
    loadRecentCommits: deps?.loadRecentCommits ?? loadRecentCommits,
    loadAllCritiqueEntries: deps?.loadAllCritiqueEntries ?? loadAllCritiqueEntries,
    loadAllCritiqueEntriesUnfiltered: deps?.loadAllCritiqueEntriesUnfiltered ?? loadAllCritiqueEntriesUnfiltered,
  });

  // Step 4: minimum-signal guard — also passes when coding-activity has signal.
  // codingActivity is optional on the type; access defensively in case a future
  // SummarizerContext path omits it (buildSummarizerContext always populates it).
  if (
    context.recentCritiques.length === 0 &&
    context.recentDismissals.length === 0 &&
    context.recentChat.length === 0 &&
    (context.codingActivity?.commits.length ?? 0) === 0 &&
    (context.codingActivity?.criticSummary.total ?? 0) === 0
  ) {
    return { ran: false, reason: "no new signal to consolidate" };
  }

  // Step 5: run summarizer → apply → prune → write
  const t0 = Date.now();
  try {
    // Single shared extract-role seam (single-brain S2, task 8): both the
    // summarizer and the event extractor are leaf functions that don't
    // receive `homeBase` themselves — consolidate builds ONE role-routed
    // brainFn here and injects it into both, so a family selected for the
    // `extract` role (config.json) reaches both consumers identically. Under
    // the default (no config.json → claude) this resolves to the SAME pinned
    // model both leaves hardcoded before this change, so the migration is
    // byte-identical for existing installs.
    const rawExtract = makeRoleRawBrain(homeBase, "extract");
    const summaryOutput = await summarizerFn(context, { brainFn: rawExtract });

    // Episodic capture: ground extracted drafts against verifiable real
    // ids. knownRefs = the commit shas from this run's coding activity — the ONLY
    // reliably-citable real id today (critique/chat lines arrive id-less, so
    // their model-emitted refs cannot be verified yet; grounding for them lands
    // once those refs are made verifiable). COST GUARD: with zero commits every
    // extracted draft would be dropped as unverifiable, so skip the extractor
    // brain call entirely — on-spec for coding-event capture.
    // extractEventFragments never throws (degrades to []); the whole body
    // below is try/wrapped regardless.
    const knownRefs = new Set(
      (context.codingActivity?.commits ?? []).map((c) => c.sha),
    );
    // ⚠️ MUST BROADEN THIS GATE when critique/session ids join
    // knownRefs. Today `knownRefs.size > 0` == "has commits", which is correct
    // (no commits ⇒ every draft drops as unverifiable ⇒ skip the wasted brain
    // call). But once chat/critique refs become verifiable, a chat/critique-only
    // run (0 commits but real activity) would still short-circuit here and
    // silently skip extraction — resurrecting the exact ungrounded-capture bug
    // groundEventDrafts exists to prevent. Broaden the condition alongside the
    // knownRefs set and the groundEventDrafts predicate in lockstep.
    const eventDrafts =
      knownRefs.size > 0 ? await extractEventsFn(context, { brainFn: rawExtract }) : [];

    const { memory: m1, result: applyResult } = applyCandidates(
      memory,
      summaryOutput.candidates,
      now,
    );

    const { memory: m1b, result: decayResult } = proposeDecayedFacts(m1, now);

    const { memory: m2, result: pruneResult } = pruneStaleFacts(m1b, now);

    // Apply LLM session summaries back to chat_sessions.
    const sessionSummaries = summaryOutput.session_summaries ?? [];
    const byId = new Map(sessionSummaries.map((s) => [s.session_id, s.summary]));
    const chatSessionsWithSummaries = byId.size === 0
      ? m2.chat_sessions
      : m2.chat_sessions.map((s) =>
          byId.has(s.id)
            ? { ...s, summary: byId.get(s.id)!, summary_generated_at: now.toISOString() }
            : s,
        );

    const nextDue = new Date(now.getTime() + SEVEN_DAYS_MS);
    const preTagMemory: CoreMemory = {
      ...m2,
      chat_sessions: chatSessionsWithSummaries,
      last_consolidated_at: now.toISOString(),
      consolidation_due_at: nextDue.toISOString(),
    };

    // Entity-model janitor batch-tags any active facts with no
    // entities (legacy facts + `/remember` facts that never threaded entities
    // through extraction). Runs inside the same cycle so the tagged result
    // lands in the SAME final write — never a separate write pass. Idempotent
    // + throw-safe (see tag-entities.ts): no untagged facts or a failed/
    // malformed call both degrade to returning the memory unchanged.
    const taggedMemory = await tagEntitiesFn(preTagMemory, { homeBase });

    // Ground the extracted drafts against the verifiable ids built above
    // (untrusted-LLM fix): drop any draft with no source ref in knownRefs,
    // and strip individual fabricated refs from otherwise-grounded drafts.
    const groundedDrafts = groundEventDrafts(eventDrafts, knownRefs);
    const droppedUnverifiable = eventDrafts.length - groundedDrafts.length;
    if (droppedUnverifiable > 0) {
      console.error(
        `[siltpoke memory] event grounding dropped ${droppedUnverifiable} unverifiable draft(s); kept ${groundedDrafts.length}`,
      );
    }
    // Apply AFTER tagEntities (which only touches facts) so event capture can
    // never perturb the fact path, and thread into the SAME memory that
    // gets the single write below — no second write pass. applyEventFragments
    // dedups by normalized text, so the applied count is the real delta.
    const finalMemory = applyEventFragments(taggedMemory, groundedDrafts, now);
    const eventFragmentsApplied =
      finalMemory.event_fragments.length - taggedMemory.event_fragments.length;

    // Episode-synthesis: cluster the just-applied
    // active event fragments into day-bucketed episode narratives. Runs AFTER
    // applyEventFragments so episodes read the freshest fragment set, and
    // threads into the SAME memory that gets the single write below — no
    // second write pass. No outer cost guard is added here (unlike the
    // `knownRefs.size > 0` gate above the event extractor): `synthesizeEpisodes`
    // already applies its own EPISODE_MIN_MEMBERS floor + skip-if-
    // unchanged diff internally, so an empty or all-unchanged fragment set
    // makes zero Haiku calls with no extra guard needed here — an outer
    // pre-check would just duplicate that logic as dead code. `synthesizeFn`
    // undefined (not overridden by a test) falls through to the real Haiku
    // wiring inside `synthesizeEpisodes` itself.
    const personality = await loadPersonalityFn(homeBase);
    const episodeDrafts = await synthesizeEpisodes(finalMemory, {
      synthesizeFn: synthesizeFnDep,
      now,
      language: expandLanguage(personality.language),
    });
    const memoryWithEpisodes = applyEpisodes(finalMemory, episodeDrafts, now);

    await writeMemoryFn(homeBase, memoryWithEpisodes, projectCwd);

    // Re-embed on summary change is self-healing: recallRelatedChats →
    // refreshSummaryIndex compares summary hashes and re-embeds any changed
    // session automatically. No consolidate dirty-flag needed. See
    // tests/chat/recall-index.test.ts for coverage.

    return {
      ran: true,
      candidates: summaryOutput.candidates.length,
      apply: applyResult,
      decay: decayResult,
      prune: pruneResult,
      eventFragments: eventFragmentsApplied,
      episodesSynthesized: episodeDrafts.length,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[siltpoke memory] consolidate failed:", err);
    return { ran: false, reason: `consolidate error: ${message}` };
  }
}
