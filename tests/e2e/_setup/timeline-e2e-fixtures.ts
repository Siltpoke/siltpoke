/**
 * timeline-e2e-fixtures — seed/restore helpers for the /timeline screenshot
 * spec (trace-history-merge-screenshots.spec.ts).
 *
 * Seeds everything an HONEST full-tab capture needs into the shared e2e
 * SILTPOKE_HOME (`./.playwright-tmp/siltpoke`, read per-request by the
 * playwright webServer daemon — no restart needed):
 *
 *   - brain-calls.jsonl   → 3 turns (2 fired + 1 skipped for rail texture),
 *                           newest carries critique_id + diff_summary +
 *                           diff_snapshot_id (row shape reused from the
 *                           /timeline unit fixtures via `fixtureLines`)
 *   - critiques/archive/  → v2 sidecar for the newest turn (Critic tab's
 *                           Block A: user_raw_query + agent_reply)
 *   - critic-snapshots/   → real multi-file git diff (Diff tab on-demand load)
 *   - traces/             → sqlite index + JSONL spans linked via critique_id
 *                           (Trace tab fragment) — written by a spawned bun
 *                           subprocess (seed-timeline-trace.ts) because
 *                           TraceStore needs bun:sqlite, which the Node
 *                           Playwright runner can't import.
 *
 * Restore puts brain-calls.jsonl back exactly as found and removes every
 * file/dir this module created (verification-repo cleanup discipline —
 * existing specs and later runs must see the home exactly as before).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureLines } from "../../web/routes/timeline-fixture-lines";
import { E2E_HOME, type RestoreFn, swapInFile } from "./honesty-e2e-fixtures";

/** Newest turn — the one every tab screenshot inspects. */
export const TL_CRITIQUE_ID = "cq-e2e-timeline-01";
export const TL_TRACE_ID = "e2e70ace0000000000000001";
export const TL_SNAPSHOT_ID = "snap-e2e-timeline-01.diff";

/** Anti-vacuous markers asserted before each capture. */
export const TL_BUBBLE = "E2E-TL: retry loop swallows the abort signal";
export const TL_USER_QUERY = "please make the cache retry survive daemon restarts";
export const TL_AGENT_REPLY =
  "Wrapped the cache write in withTimeout and moved retry state into the daemon store.";
export const TL_CRITIQUE_TEXT =
  "retry() rebuilds the AbortController per attempt — pass the caller's signal through instead.";
export const TL_DIFF_INTENT = "make the cache retry loop restart-safe";
/** Citations the evidence check dropped on the newest turn (drives the unconfirmed mark). */
export const TL_UNVERIFIED_COUNT = 2;
export const TL_DIFF_FILE = "src/cache/retry.ts";

const DIFF_BODY = `diff --git a/${TL_DIFF_FILE} b/${TL_DIFF_FILE}
index 1111111..2222222 100644
--- a/${TL_DIFF_FILE}
+++ b/${TL_DIFF_FILE}
@@ -10,7 +10,9 @@ export async function retry(task: Task, signal: AbortSignal) {
-  const controller = new AbortController();
-  return runWithRetries(task, controller.signal);
+  // pass the caller's signal through — a fresh controller per attempt
+  // orphaned in-flight work on daemon restart
+  return runWithRetries(task, signal, { backoffMs: 250 });
 }
diff --git a/src/cache/store.ts b/src/cache/store.ts
index 3333333..4444444 100644
--- a/src/cache/store.ts
+++ b/src/cache/store.ts
@@ -3,4 +3,5 @@ export interface CacheStore {
   get(key: string): Promise<string | null>;
+  putWithRetry(key: string, value: string): Promise<void>;
 }
`;

function isoMinutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

function buildBrainCallLines(): string[] {
  return fixtureLines([
    // Oldest — a skipped turn so the rail shows the muted skip row style.
    {
      ts: isoMinutesAgo(180),
      session: "sess-e2e-tl-skip",
      status: "skipped",
      skip_reason: "quiet_hours",
      cwd: "/tmp/e2e-timeline-proj",
    },
    // A second fired turn (different severity) for rail texture + real sums.
    {
      ts: isoMinutesAgo(95),
      session: "sess-e2e-tl-2",
      status: "fired",
      cwd: "/tmp/e2e-timeline-other",
      bubble_short: "E2E-TL: config verifier misses the new budget keys",
      critique: "config verifier misses the new budget keys — extend the schema.",
      severity: "medium",
      input_tokens: 5200,
      output_tokens: 480,
      cost: 0.0043,
    },
    // Newest — the fully-dressed turn the tab screenshots open.
    {
      ts: isoMinutesAgo(12),
      session: "sess-e2e-tl-1",
      status: "fired",
      cwd: "/tmp/e2e-timeline-proj",
      critique_id: TL_CRITIQUE_ID,
      diff_snapshot_id: TL_SNAPSHOT_ID,
      bubble_short: TL_BUBBLE,
      bubble_long:
        "The retry loop creates a fresh AbortController every attempt, so a daemon restart mid-write orphans the in-flight cache entry.",
      critique: TL_CRITIQUE_TEXT,
      severity: "high",
      // The newest turn is deliberately a PARTLY-UNVERIFIED review: it is the
      // pane every tab spec opens, so seeding the caveat here means the mark
      // is on the pane a real browser renders first — which is the only place
      // `toBeVisible` can catch it going missing. It also puts the mark into
      // the tl-02 screenshot, where the feature is meant to be legible.
      evidence_label: "partly_unverified",
      evidence_unverified: TL_UNVERIFIED_COUNT,
      input_tokens: 12400,
      output_tokens: 810,
      cost: 0.0127,
      diff_summary: {
        intent: TL_DIFF_INTENT,
        key_changes: [
          "pass the caller's AbortSignal through retry()",
          "add putWithRetry to the CacheStore interface",
        ],
        risks: ["callers that relied on per-attempt controllers now share one signal"],
        file_count: 2,
        files_with_purpose: [
          { path: TL_DIFF_FILE, purpose: "signal pass-through + backoff" },
          { path: "src/cache/store.ts", purpose: "interface addition" },
        ],
        source: "haiku",
      },
    },
  ]);
}

async function writeV2Sidecar(archiveDir: string): Promise<void> {
  await writeFile(
    join(archiveDir, `${TL_CRITIQUE_ID}.v2.md`),
    [
      "---",
      "schemaVersion: 2",
      `critique_id: ${TL_CRITIQUE_ID}`,
      "session_id: sess-e2e-tl-1",
      "cwd: /tmp/e2e-timeline-proj",
      "intent_classification: refactor",
      "intent_confidence: 0.9",
      `user_raw_query: "${TL_USER_QUERY}"`,
      `agent_reply: "${TL_AGENT_REPLY}"`,
      "changed_files:",
      `  - ${TL_DIFF_FILE}`,
      "  - src/cache/store.ts",
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * Seed the timeline fixture set. Returns a single restore that undoes
 * everything (safe to call once in afterAll).
 */
export async function seedTimelineFixtures(): Promise<RestoreFn> {
  const restores: RestoreFn[] = [];

  // 1. brain-calls.jsonl — swap-in with restore of the original content.
  restores.push(
    await swapInFile(
      join(E2E_HOME, "brain-calls.jsonl"),
      `${buildBrainCallLines().join("\n")}\n`,
    ),
  );

  // 2. v2 sidecar under critiques/archive/<today>/ (loadV2Sidecar scans
  //    day dirs). Track whether the tree pre-existed so restore only
  //    removes what this module added.
  const day = new Date().toISOString().slice(0, 10);
  const critiquesRoot = join(E2E_HOME, "critiques");
  const archiveDir = join(critiquesRoot, "archive", day);
  const hadCritiquesRoot = existsSync(critiquesRoot);
  await mkdir(archiveDir, { recursive: true });
  await writeV2Sidecar(archiveDir);
  restores.push(async () => {
    if (hadCritiquesRoot) {
      await rm(join(archiveDir, `${TL_CRITIQUE_ID}.v2.md`), { force: true });
    } else {
      await rm(critiquesRoot, { recursive: true, force: true });
    }
  });

  // 3. Diff snapshot for the on-demand Diff-tab load.
  const snapshotsDir = join(E2E_HOME, "critic-snapshots");
  const hadSnapshotsDir = existsSync(snapshotsDir);
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(join(snapshotsDir, TL_SNAPSHOT_ID), DIFF_BODY, "utf8");
  restores.push(async () => {
    if (hadSnapshotsDir) {
      await rm(join(snapshotsDir, TL_SNAPSHOT_ID), { force: true });
    } else {
      await rm(snapshotsDir, { recursive: true, force: true });
    }
  });

  // 4. Linked trace — sqlite index + day-partition JSONL, written by the
  //    same seeder the /timeline unit tests use, run under bun (TraceStore
  //    needs bun:sqlite; this fixture runs under Node inside Playwright).
  const tracesDir = join(E2E_HOME, "traces");
  const hadTracesDir = existsSync(tracesDir);
  const seeded = spawnSync(
    "bun",
    [join(process.cwd(), "tests", "e2e", "_setup", "seed-timeline-trace.ts")],
    { stdio: "inherit" },
  );
  if (seeded.status !== 0) {
    throw new Error(`seed-timeline-trace.ts failed (exit ${seeded.status})`);
  }
  restores.push(async () => {
    if (!hadTracesDir) await rm(tracesDir, { recursive: true, force: true });
    // If a traces dir pre-existed we leave it: the spec's trace id is
    // namespaced (e2e70ace…) and harmless to later specs.
  });

  return async () => {
    // Undo in reverse creation order.
    for (const restore of restores.reverse()) await restore();
  };
}
