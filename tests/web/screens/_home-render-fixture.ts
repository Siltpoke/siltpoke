/**
 * Shared minimal HomeData render fixture — extracted from Home.test.tsx
 * (400-LOC ratchet split). Real-data shapes: stats real, vitals [],
 * critiques [], navMeta real.
 */
import type { HomeData } from "../../../src/web/screens/Home";

export const HOME_RENDER_FIXTURE: HomeData = {
  pet: {
    name: "Bangbang",
    species: "cat",
    mood: "happy",
    level: 12,
  },
  progression: {
    xp: 1284,
    xp_to_next: 2000,
    streak_days: 3,
    together_time: "3d 04h",
  },
  statusline: [
    "siltpoke · cat",
    "mood:   happy",
    "level:  12 · 1284 / 2000 XP",
    "streak: 3 days",
  ].join("\n"),
  statuslinePreview: [
    "  ___",
    " /o o\\",
    "`-----'",
    "siltpoke",
    "Sentinel",
    "L12 1284/2000",
  ].join("\n"),
  vitals: {
    mood:   [],
    hunger: [],
    energy: [],
    bond:   [],
  },
  vitalsValues: {
    mood:   "happy",
    hunger: "fed",
    energy: "—",
    bond:   "—",
  },
  stats: { hp: 10, hunger: 5, energy: 8, mood: 6, bond: 0 },
  xp: {
    level:    12,
    nextLevel: 13,
    xp:       1284,
    xpToNext: 2000,
    xpToday:  10,
    xpTodayCapped: false,
  },
  xpAwardedSeries: [0, 0, 0, 0, 0, 0, 0],
  facts: [
    {
      id: "fact-001",
      text: "User prefers TypeScript.",
      source_session_id: null,
      confidence: 0.95,
      status: "active",
      created_at: "2026-05-18T10:00:00Z",
      last_seen_at: "2026-05-18T10:00:00Z",
      supersedes: null,
      superseded_by: null,
      pinned: false,
      recall_count: 0,
      retired_reason: null,
      stability: "durable",
      learned_from: null,
      last_confirmed_at: null,
      expires_at: null,
    save_reason: null,
    invalid_at: null,
    events: [],
    },
  ],
  topbarBadges: {
    wellFed: true,
    sinceDressed: "22 hrs",
    todayCount: 1,
  },
  meta: {
    snarkPercent: 78,
    lastPokeAt: "2m ago",
  },
  together: "3d 04h",
  petTitle: "marshlump",
  startDate: "may 14",
  navMeta: {
    memory: "1 fact",
  },
  // Minimal telemetry shape — empty data keeps the Gate / Budget /
  // SkipHistogram cards in their zero-state fallback rendering. Cast through
  // unknown so we don't have to mirror every nested config field a real
  // readCriticTelemetry() call returns.
  telemetry: {
    recent: [],
    breakdown: { total: 0, counts: {} },
    budget: {
      stage: "ok",
      used_pct: 0,
      remaining_tokens: 1_000_000,
      config: {
        dailyTokenLimit: 1_000_000,
        perCallMaxInputTokens: 100_000,
        softWarnAtPercent: 80,
        hardStopAtPercent: 100,
        softModeOverride: "on_demand",
        resetAtMinutes: 0,
      },
      rollup: null,
    },
    quietConfig: { startMinutes: null, endMinutes: null },
    gateState: {
      blocking: null,
      detail: "All gates open — critic should fire on next Stop hook.",
      checks: [
        { name: "quiet_hours", pass: true, detail: "Not configured (always pass)" },
        { name: "budget", pass: true, detail: "0% used" },
      ],
    },
    projects: [],
    activeProject: null,
    activeStatus: null,
    activeKind: null,
    activeRange: "all",
    activeQuery: null,
    actionStats: { dismissed: 0, acked: 0, total: 0 },
    homeBasename: "user",
  } as unknown as HomeData["telemetry"],
  biasAuditConfig: { enabled: false },
  biasAuditDelta: {
    sampleSize: 0,
    severityDisagreementPct: 0,
    categoryDisagreementPct: 0,
    alert: false,
  },
  rubricSummary: {
    totalRules: 13,
    topByTriggers: [
      { rule_id: "magic-number", count: 1607 },
      { rule_id: "god-function", count: 105 },
      { rule_id: "deep-nesting", count: 73 },
    ],
  },
  fewShotStats: {
    entries: 4,
    dim: 384,
    embedder: "stub",
  },
  repoMemoryStats: {
    files: 42,
    topConvention: { id: "naming-kebab-case-files", confidence: 0.92 },
  },
  modelsInfo: {
    primary: { name: "Claude Haiku 4.5", provider: "Anthropic" },
    biasAudit: { name: "Qwen2.5-Coder-7B-Q4", provider: "Local Ollama", enabled: false },
    verifierMode: "conditional",
  },
  brainHealth: { show: false, line: "", detail: "" },
};
