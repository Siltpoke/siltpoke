/**
 * Playwright globalSetup — seed a small fixture repo into the e2e SILTPOKE_HOME
 * so the /repo-graph specs can exercise the real cytoscape render + drill +
 * search against indexed data.
 *
 * The fixture lives under its OWN proj_hash (a11ce0000001), navigated via
 * `/repo-graph?repo=a11ce0000001`. The daemon's cwd repo stays unindexed, so
 * the "no-graph empty state" spec (fresh-install UX) still holds at `/repo-graph`.
 *
 * Degraded mode (no CLAUDE.md at project_root) → projectArchitecture derives one
 * group per subdir; arch still renders cards + aggregated edges.
 *
 * Also seeds memory.json with a semantic fact (for the forget-flow E2E) and a
 * chat session (for the working-memory panel E2E).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  writeFingerprints,
  writeGraph,
  writeMeta,
  writeQueryIndex,
} from "../../../src/repo-graph/store";
import {
  emptyCounters,
  emptyFingerprints,
  emptyQueryIndex,
  type RepoGraph,
  type RepoGraphMeta,
} from "../../../src/repo-graph/types";

export const FIXTURE_HASH = "a11ce0000001";

export default async function seedRepoGraph(): Promise<void> {
  const home = join(process.cwd(), ".playwright-tmp", "siltpoke");
  const storageDir = join(home, "repo-memory", FIXTURE_HASH);
  const projectRoot = join(process.cwd(), ".playwright-tmp", "fixture-repo");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(storageDir, { recursive: true });

  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [
      { id: "file:src/alpha/a.ts:", type: "file", name: "a.ts", path: "src/alpha/a.ts", lineRange: [1, 40] },
      { id: "file:src/alpha/util.ts:", type: "file", name: "util.ts", path: "src/alpha/util.ts", lineRange: [1, 20] },
      { id: "file:src/beta/b.ts:", type: "file", name: "b.ts", path: "src/beta/b.ts", lineRange: [1, 30] },
      { id: "file:src/gamma/g.ts:", type: "file", name: "g.ts", path: "src/gamma/g.ts", lineRange: [1, 25] },
      {
        id: "function:src/alpha/a.ts:runAlpha",
        type: "function",
        name: "runAlpha",
        path: "src/alpha/a.ts",
        lineRange: [5, 18],
        signature: "(x: number) => string",
      },
    ],
    edges: [
      { id: "e1", source: "file:src/alpha/a.ts:", target: "../beta/b", type: "imports", weight: 1 },
      { id: "e2", source: "file:src/alpha/a.ts:", target: "../gamma/g", type: "imports", weight: 1 },
      { id: "e3", source: "file:src/beta/b.ts:", target: "../gamma/g", type: "imports", weight: 1 },
    ],
  };

  const counters = emptyCounters();
  counters.nodes.file = 4;
  counters.nodes.function = 1;
  counters.edges.imports = 3;

  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root: projectRoot,
    proj_hash: FIXTURE_HASH,
    last_indexed_ts: "2026-05-29T10:00:00.000Z",
    build_duration_ms: 50,
    counters,
    building: false,
  };

  const queryIndex = emptyQueryIndex();
  queryIndex.name_to_node_ids.runAlpha = ["function:src/alpha/a.ts:runAlpha"];
  queryIndex.path_to_node_ids["src/alpha/a.ts"] = [
    "file:src/alpha/a.ts:",
    "function:src/alpha/a.ts:runAlpha",
  ];

  await writeGraph(storageDir, graph);
  await writeMeta(storageDir, meta);
  await writeQueryIndex(storageDir, queryIndex);
  await writeFingerprints(storageDir, emptyFingerprints());

  // Seed memory.json — a retirable semantic fact + a chat session for the
  // working-memory panel. Schema v2, no global.json → v2 read path in readMemory.
  const memoryFixture = {
    schemaVersion: 2,
    long_term_summary: "E2E test fixture",
    learned_rules: [],
    personality_drift: { snark: 0, patience: 0, style_strictness: 0, proactivity: 0 },
    last_consolidated_at: "2026-01-01T00:00:00.000Z",
    consolidation_due_at: "2026-01-08T00:00:00.000Z",
    user_profile: { communication_style: "neutral", goals: [], constraints: [], prefs: {} },
    chat_sessions: [
      {
        id: "cs-e2e-001",
        started_at: "2026-06-25T10:00:00.000Z",
        ended_at: "2026-06-25T10:30:00.000Z",
        message_count: 5,
        summary: "Discussed memory book UI implementation",
        tags: ["memory", "ui"],
        anchor: null,
      },
    ],
    facts: [
      {
        id: "fact-e2e-retire-001",
        text: "User prefers dark mode",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "active",
        created_at: "2026-06-25T10:00:00.000Z",
        last_seen_at: "2026-06-25T10:00:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Explicitly mentioned dark mode preference",
      },
      {
        // Second active fact so the retire (composer) and reactivate tests each
        // have their own non-retired target. Distinct last word ("spaces") keeps
        // the composer keyword-matcher unambiguous vs fact-001 ("mode").
        id: "fact-e2e-retire-002",
        text: "User prefers tabs over spaces",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "active",
        created_at: "2026-06-25T10:05:00.000Z",
        last_seen_at: "2026-06-25T10:05:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Explicitly mentioned indentation preference",
      },
      {
        // Pending fact for the 确认 (approve) E2E. Distinct text/last-word
        // ("pink") so it's unambiguous vs the active facts above. created_at is
        // intentionally OLDER than the active facts (10:00 / 10:05) so the
        // composer retire/reactivate tests — which grab the *newest* non-retired
        // semantic fact — never pick these pending fixtures.
        id: "fact-e2e-pending-approve",
        text: "User might prefer pink",
        source_session_id: "cs-e2e-001",
        confidence: 0.6,
        status: "pending",
        created_at: "2026-06-25T08:00:00.000Z",
        last_seen_at: "2026-06-25T08:00:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Mentioned pink once — low confidence, awaiting confirm",
      },
      {
        // Pending fact for the 拒绝 (reject) E2E. Separate target so the
        // approve test (above) doesn't consume the only pending fact.
        id: "fact-e2e-pending-reject",
        text: "User might use vim",
        source_session_id: "cs-e2e-001",
        confidence: 0.6,
        status: "pending",
        created_at: "2026-06-25T08:01:00.000Z",
        last_seen_at: "2026-06-25T08:01:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Mentioned vim once — low confidence, awaiting confirm",
      },
      {
        // Dedicated active target for the contradict → 替换 (replace) E2E.
        // created_at is the OLDEST of all seeded facts (07:00) so the
        // composer-forget / reactivate tests — which grab the *newest*
        // non-retired semantic fact — never consume it; the test references
        // it by explicit id, so cross-test mutation can't steal the target.
        id: "fact-e2e-g2-replace",
        text: "User prefers light theme always",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "active",
        created_at: "2026-06-25T07:00:00.000Z",
        last_seen_at: "2026-06-25T07:00:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Stated a theme preference",
      },
      {
        // Dedicated active target for the contradict → 两条都留 (keep both)
        // E2E. Same oldest-bucket created_at (07:01) + explicit-id reference so
        // no earlier test's newest-non-retired picker can grab it.
        id: "fact-e2e-g2-keepboth",
        text: "User works in timezone UTC",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "active",
        created_at: "2026-06-25T07:01:00.000Z",
        last_seen_at: "2026-06-25T07:01:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Stated a timezone",
      },
      {
        // 删除-button E2E: dedicated active target referenced by explicit id.
        // created_at is the OLDEST of all seeded facts (06:30) so the
        // composer-forget / reactivate tests — which grab the *newest*
        // non-retired semantic fact — never consume it. Distinct last word
        // ("kayaking") keeps it clear of any keyword matcher too.
        id: "fact-e2e-delete",
        text: "User enjoys weekend kayaking",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "active",
        created_at: "2026-06-25T06:30:00.000Z",
        last_seen_at: "2026-06-25T06:30:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Mentioned a weekend hobby",
      },
      {
        // Reaffirm-badge render E2E: a fact reaffirmed once (recall_count >= 1)
        // with last_confirmed_at set, so the timeline row shows the
        // "★ 重申 ×1 · M/D" badge. created_at is the OLDEST of all seeded facts
        // (05:00) so the composer-forget / reactivate tests — which grab the
        // *newest* non-retired semantic fact — never consume it; referenced by
        // explicit id so cross-test mutation can't steal it.
        id: "fact-e2e-reaffirm",
        text: "User commutes by bicycle",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "active",
        created_at: "2026-06-25T05:00:00.000Z",
        last_seen_at: "2026-06-22T09:00:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 1,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: "2026-06-22T09:00:00.000Z",
        expires_at: null,
        save_reason: "Mentioned a commute habit",
      },
      {
        // Action-log stored-events path E2E: a fact with a NON-EMPTY events[]
        // so the SSR→client serialization path is exercised (all other seeded
        // facts have events:[] and fall into the synthesis path). created_at is
        // OLDER than all existing facts (04:00) so the composer-forget /
        // reactivate tests — which grab the *newest* non-retired semantic fact —
        // never pick this one. Referenced by explicit id. Two reaffirms in the
        // stored events[] so buildLogRows folds them into a single ×2 entry,
        // which the E2E asserts in the expanded rail.
        id: "fact-e2e-actionlog",
        text: "User saves frequently while coding",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "active",
        created_at: "2026-06-25T04:00:00.000Z",
        last_seen_at: "2026-06-25T04:30:00.000Z",
        supersedes: null,
        superseded_by: null,
        pinned: false,
        recall_count: 2,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: "2026-06-25T04:30:00.000Z",
        expires_at: null,
        save_reason: "Observed repeated save behaviour",
        events: [
          { action: "created",    at: "2026-06-25T04:00:00.000Z", reason: null },
          { action: "approved",   at: "2026-06-25T04:10:00.000Z", reason: null },
          { action: "reaffirmed", at: "2026-06-25T04:20:00.000Z", reason: null },
          { action: "reaffirmed", at: "2026-06-25T04:30:00.000Z", reason: null },
        ],
      },
      {
        // Supersede-link E2E — OLD/superseded fact (retired). created_at older
        // than all existing facts (02:00) so the composer-forget / reactivate tests
        // — which grab the *newest* non-retired semantic fact — never pick this one.
        // Has superseded_by → the SUPERSEDING fact below. Referenced by explicit id.
        id: "fact-e2e-superseded",
        text: "User prefers Windows for gaming",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "retired",
        created_at: "2026-06-25T02:00:00.000Z",
        last_seen_at: "2026-06-25T02:00:00.000Z",
        supersedes: null,
        superseded_by: "fact-e2e-superseding",
        pinned: false,
        recall_count: 0,
        retired_reason: "superseded",
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Stated a platform preference",
        events: [],
      },
      {
        // Supersede-link E2E — NEW/superseding fact (active). created_at slightly
        // after the superseded one (02:30). Has supersedes → the SUPERSEDED fact above.
        // Referenced by explicit id; distinct text ("macOS") keeps it clear of keyword
        // matchers in forget tests. Both facts are semantic so the memory-log passes
        // supersedes/superseded_by through to the client island.
        id: "fact-e2e-superseding",
        text: "User prefers macOS for development and gaming",
        source_session_id: "cs-e2e-001",
        confidence: 0.9,
        status: "active",
        created_at: "2026-06-25T02:30:00.000Z",
        last_seen_at: "2026-06-25T02:30:00.000Z",
        supersedes: "fact-e2e-superseded",
        superseded_by: null,
        pinned: false,
        recall_count: 0,
        retired_reason: null,
        stability: "durable",
        learned_from: { stream: "chat", session_id: "cs-e2e-001" },
        last_confirmed_at: null,
        expires_at: null,
        save_reason: "Stated a platform preference update",
        events: [],
      },
    ],
  };
  await writeFile(
    join(home, "memory.json"),
    JSON.stringify(memoryFixture, null, 2),
  );
}
