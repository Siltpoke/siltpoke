/**
 * chat-stream-hardening-fixtures — seed/restore helpers for the chat-stream
 * hardening screenshot spec (chat-stream-hardening-screenshots.spec.ts).
 *
 * Seeds everything the captures need into the shared e2e SILTPOKE_HOME
 * (`./.playwright-tmp/siltpoke`, read per-request by the playwright webServer
 * daemon — no restart needed). PURE Node module (fs only, no bun: imports):
 *
 *   - memory.json chat_sessions[] → two seeded conversations so the floating
 *     chat's history dropdown lists them (failed-turn + cancelled-turn)
 *   - chats/<id>.jsonl            → persisted turns incl. a failed row
 *     (status "failed" + error_reason "timeout") and a cancelled row
 *     (status "cancelled" with partial content that must NOT display)
 *   - progression.json            → today's action-XP at the daily cap so the
 *     Home badge renders "+100 today · capped"
 *   - brain-calls.jsonl           → more range-passing rows than the /timeline
 *     window limit (200) inside the last 7 days, so ?range=7d has a further
 *     page and the Load-older control renders
 *
 * Restore puts every swapped file back exactly as found and removes the two
 * session JSONLs (verification-repo cleanup discipline — existing specs and
 * later runs must see the home exactly as before).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyMemory, type CoreMemory } from "../../../src/memory/memory";
import {
  ACTION_XP_DAILY_CAP,
  DEFAULT_PROGRESSION,
  type Progression,
} from "../../../src/state/progression";
import { fixtureLines, type FixtureCall } from "../../web/routes/timeline-fixture-lines";
import { E2E_HOME, type RestoreFn, swapInFile } from "./honesty-e2e-fixtures";

// ── seeded conversations (floating-chat history) ─────────────────────────────

/** Session whose last turn FAILED (timeout) — renders the pet-voice error card. */
export const CSH_FAIL_SESSION_ID = "sess-e2e-csh-failed-turn";
export const CSH_FAIL_TITLE = "E2E-CSH: deep check on the retry helper";
/** The ok assistant turn preceding the failure (bubble/card visual contrast). */
export const CSH_FAIL_OK_REPLY =
  "Sure — the retry helper looks healthy at a glance. Want the deep pass?";

/** Session whose last turn was CANCELLED — renders the quiet stopped marker. */
export const CSH_STOP_SESSION_ID = "sess-e2e-csh-cancelled-turn";
export const CSH_STOP_TITLE = "E2E-CSH: walk me through the cache module";
/**
 * Partial content persisted on the cancelled row. The UI contract is that
 * this text is NEVER displayed — only the quiet marker is. The spec asserts
 * its absence.
 */
export const CSH_STOP_PARTIAL =
  "The cache module starts by hashing the key with sha256, then it";

// ── timeline Load-older fixture ──────────────────────────────────────────────

export const CSH_TIMELINE_BUBBLE_PREFIX = "E2E-CSH timeline row";
/** One full window (limit 200 in the /timeline route) + 5 more → hasMore. */
export const CSH_TIMELINE_ROWS = 205;
const CSH_TIMELINE_CWD = "/tmp/e2e-csh-timeline";

// ── chat message JSONL rows ──────────────────────────────────────────────────

interface SeedMsg {
  role: "user" | "assistant";
  content: string;
  status?: "failed" | "cancelled";
  error_reason?: "timeout" | "spawn_failed" | "empty_exit";
  error_message?: string;
}

function isoMinutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

/** Render rows that satisfy chatMessageSchema (defaults fill the rest). */
function sessionJsonl(sessionId: string, startMinsAgo: number, msgs: SeedMsg[]): string {
  const lines = msgs.map((m, i) =>
    JSON.stringify({
      id: `${sessionId}-m${i + 1}`,
      session_id: sessionId,
      role: m.role,
      content: m.content,
      ts: isoMinutesAgo(startMinsAgo - i),
      ...(m.status !== undefined ? { status: m.status } : {}),
      ...(m.error_reason !== undefined ? { error_reason: m.error_reason } : {}),
      ...(m.error_message !== undefined ? { error_message: m.error_message } : {}),
    }),
  );
  return `${lines.join("\n")}\n`;
}

const FAIL_SESSION_MSGS: SeedMsg[] = [
  { role: "user", content: "can you do a deep check on the retry helper?" },
  { role: "assistant", content: CSH_FAIL_OK_REPLY },
  { role: "user", content: "yes, run the deep check" },
  {
    role: "assistant",
    content: "", // failed turns persist with empty content — copy is client-side
    status: "failed",
    error_reason: "timeout",
    error_message: "chat turn timed out after 60000ms",
  },
];

const STOP_SESSION_MSGS: SeedMsg[] = [
  { role: "user", content: "walk me through the cache module" },
  { role: "assistant", content: CSH_STOP_PARTIAL, status: "cancelled" },
];

// ── memory.json chat_sessions[] entries ──────────────────────────────────────

interface SessionMeta {
  id: string;
  title: string;
  messageCount: number;
  endedMinsAgo: number;
}

function sessionEntry(meta: SessionMeta) {
  return {
    id: meta.id,
    started_at: isoMinutesAgo(meta.endedMinsAgo + 10),
    ended_at: isoMinutesAgo(meta.endedMinsAgo),
    message_count: meta.messageCount,
    summary: meta.title,
    summary_generated_at: null,
    tags: [],
    anchor: null,
  };
}

async function seedChatSessionsMeta(): Promise<RestoreFn> {
  const memoryPath = join(E2E_HOME, "memory.json");
  const base: CoreMemory = existsSync(memoryPath)
    ? (JSON.parse(await readFile(memoryPath, "utf8")) as CoreMemory)
    : emptyMemory();
  const seededIds = new Set([CSH_FAIL_SESSION_ID, CSH_STOP_SESSION_ID]);
  const next = {
    ...base,
    chat_sessions: [
      // Idempotence: drop stale copies of our ids from a crashed prior run.
      ...(base.chat_sessions ?? []).filter((s) => !seededIds.has(s.id)),
      // Recent ended_at → both sort to the top of the history dropdown.
      sessionEntry({
        id: CSH_FAIL_SESSION_ID,
        title: CSH_FAIL_TITLE,
        messageCount: FAIL_SESSION_MSGS.length,
        endedMinsAgo: 20,
      }),
      sessionEntry({
        id: CSH_STOP_SESSION_ID,
        title: CSH_STOP_TITLE,
        messageCount: STOP_SESSION_MSGS.length,
        endedMinsAgo: 8,
      }),
    ],
  };
  return swapInFile(memoryPath, `${JSON.stringify(next, null, 2)}\n`);
}

async function seedSessionFiles(): Promise<RestoreFn> {
  const chatsDir = join(E2E_HOME, "chats");
  const hadChatsDir = existsSync(chatsDir);
  await mkdir(chatsDir, { recursive: true });
  const failPath = join(chatsDir, `${CSH_FAIL_SESSION_ID}.jsonl`);
  const stopPath = join(chatsDir, `${CSH_STOP_SESSION_ID}.jsonl`);
  await writeFile(failPath, sessionJsonl(CSH_FAIL_SESSION_ID, 25, FAIL_SESSION_MSGS), "utf8");
  await writeFile(stopPath, sessionJsonl(CSH_STOP_SESSION_ID, 10, STOP_SESSION_MSGS), "utf8");
  return async () => {
    if (hadChatsDir) {
      await rm(failPath, { force: true });
      await rm(stopPath, { force: true });
    } else {
      await rm(chatsDir, { recursive: true, force: true });
    }
  };
}

// ── progression.json at the daily action-XP cap ──────────────────────────────

async function seedProgressionAtCap(): Promise<RestoreFn> {
  const progressionPath = join(E2E_HOME, "progression.json");
  const base: Progression = existsSync(progressionPath)
    ? (JSON.parse(await readFile(progressionPath, "utf8")) as Progression)
    : { ...DEFAULT_PROGRESSION, stats_last_tick_at: new Date().toISOString() };
  // Same UTC day-key derivation as xpPanelData / recordAction.
  const today = new Date().toISOString().slice(0, 10);
  const next: Progression = {
    ...base,
    action_xp: [
      ...(base.action_xp ?? []).filter((e) => e.day !== today),
      { day: today, xp: ACTION_XP_DAILY_CAP },
    ],
  };
  return swapInFile(progressionPath, `${JSON.stringify(next, null, 2)}\n`);
}

// ── brain-calls.jsonl overflowing the 7d window ──────────────────────────────

function buildTimelineOverflowLines(): string[] {
  const calls: FixtureCall[] = [];
  const severities = ["info", "low", "medium", "high"] as const;
  // Oldest → newest (chronological append order, matching the real log).
  // Even 30-min spacing puts the whole set well inside the 7d range
  // (205 × 30min ≈ 4.3 days), so every row is range-passing and the
  // window (limit 200) provably has 5 more rows behind it → hasMore.
  for (let i = 0; i < CSH_TIMELINE_ROWS; i++) {
    const n = i + 1;
    const minsAgo = (CSH_TIMELINE_ROWS - i) * 30;
    if (n % 40 === 0) {
      calls.push({
        ts: isoMinutesAgo(minsAgo),
        session: `sess-e2e-csh-tl-${n}`,
        status: "skipped",
        skip_reason: "quiet_hours",
        cwd: CSH_TIMELINE_CWD,
      });
      continue;
    }
    calls.push({
      ts: isoMinutesAgo(minsAgo),
      session: `sess-e2e-csh-tl-${n}`,
      status: "fired",
      cwd: CSH_TIMELINE_CWD,
      bubble_short: `${CSH_TIMELINE_BUBBLE_PREFIX} ${n} — retry budget check`,
      critique: `row ${n}: the retry budget accounting drifts on restart.`,
      severity: severities[n % severities.length],
      input_tokens: 4000 + n,
      output_tokens: 300 + n,
      cost: 0.003,
    });
  }
  return fixtureLines(calls);
}

async function seedTimelineOverflow(): Promise<RestoreFn> {
  return swapInFile(
    join(E2E_HOME, "brain-calls.jsonl"),
    `${buildTimelineOverflowLines().join("\n")}\n`,
  );
}

// ── composite seed ───────────────────────────────────────────────────────────

/**
 * Seed the full fixture set. Returns a single restore that undoes everything
 * (safe to call once in afterAll).
 */
export async function seedChatStreamHardeningFixtures(): Promise<RestoreFn> {
  const restores: RestoreFn[] = [];
  restores.push(await seedChatSessionsMeta());
  restores.push(await seedSessionFiles());
  restores.push(await seedProgressionAtCap());
  restores.push(await seedTimelineOverflow());
  return async () => {
    for (const restore of restores.reverse()) await restore();
  };
}
