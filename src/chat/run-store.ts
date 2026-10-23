// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * One record per dashboard chat call (spec 2026-10-13-agent-in-use-truth §10.2).
 *
 * Its own folder, NOT brain-calls.jsonl: that file has two dozen readers that
 * take every line as a review. One file per conversation so the Runs window
 * reads one small file, and deleting a conversation deletes its records.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** A records file not written to for this long is deleted at daemon start. */
const RUN_RETENTION_DAYS = 30;
/** Raw CLI output kept per call; the rest is cut and the record says so. */
export const RUN_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const family = z.enum(["claude", "codex", "agy", "qoder", "codebuddy"]);

const chatRunSchema = z.object({
  v: z.literal(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  /** The stored assistant message this call produced — the link to the chat bubble. */
  message_id: z.string().min(1),
  started_at: z.string(),
  total_ms: z.number().int().nonnegative(),
  /** claude only (spec §10.2); null for every other agent. */
  first_token_ms: z.number().int().nonnegative().nullable(),
  /** null = no agent was decided (none installed / user must choose). */
  family: family.nullable(),
  /** How the agent was decided. `default` = a mount with no resolver (claude). */
  source: z.enum(["chosen", "recent", "installed", "default"]).nullable(),
  model_requested: z.string().nullable(),
  model_reported: z.string().nullable(),
  outcome: z.enum(["ok", "failed", "cancelled"]),
  failure_reason: z.string().nullable(),
  failure_message: z.string().max(300).nullable(),
  tokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().nullable(),
      cache_write: z.number().int().nonnegative().nullable(),
      thinking: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  cost: z.union([
    z.object({ kind: z.literal("usd"), usd: z.number().nonnegative() }),
    z.object({ kind: z.literal("quota") }),
    z.null(),
  ]),
  /** argv as launched. The system prompt never travels here (it is in prompt_blocks). */
  command: z.array(z.string()),
  cli_version: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  /** Tools the CLI said it was allowed to use (claude init event); null = not reported. */
  permitted_tools: z.array(z.string()).nullable(),
  prompt_blocks: z.array(z.object({ name: z.string(), chars: z.number().int().nonnegative(), text: z.string() })),
  /** Blocks that exist in the prompt layout but were empty / switched off this call. */
  prompt_omitted: z.array(z.string()),
  /** Every stdout line the CLI printed, with ms since the call started. */
  output: z.array(z.object({ t_ms: z.number().int().nonnegative(), line: z.string() })),
  output_truncated: z.boolean(),
});

export type ChatRun = z.infer<typeof chatRunSchema>;

function runsDir(homeBase: string): string {
  return join(homeBase, "chat-runs");
}

function runsPath(homeBase: string, sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`invalid session id for chat-runs: ${sessionId.slice(0, 40)}`);
  return join(runsDir(homeBase), `${sessionId}.jsonl`);
}

async function appendRun(homeBase: string, run: ChatRun): Promise<void> {
  const path = runsPath(homeBase, run.session_id);
  await mkdir(runsDir(homeBase), { recursive: true });
  await appendFile(path, `${JSON.stringify(chatRunSchema.parse(run))}\n`, "utf8");
}

async function readRuns(homeBase: string, sessionId: string): Promise<ChatRun[]> {
  const path = runsPath(homeBase, sessionId);
  if (!existsSync(path)) return [];
  const out: ChatRun[] = [];
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = chatRunSchema.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // a torn or hand-edited line — skip it, keep the rest
    }
  }
  return out;
}

async function deleteRuns(homeBase: string, sessionId: string): Promise<void> {
  try {
    await unlink(runsPath(homeBase, sessionId));
  } catch {
    // absent already
  }
}

async function pruneRuns(homeBase: string, now: Date): Promise<number> {
  const dir = runsDir(homeBase);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - RUN_RETENTION_DAYS * 86_400_000;
  let deleted = 0;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      const st = await stat(join(dir, name));
      if (st.mtimeMs < cutoff) {
        await unlink(join(dir, name));
        deleted++;
      }
    } catch {
      // vanished mid-sweep — best effort
    }
  }
  return deleted;
}

/**
 * Where chat call records live. Local files today; a cloud or sync backend
 * (the maintainer 2026-10-14: wanted later, as an option) is another implementation
 * of this, so nothing that writes or reads records knows which one it has.
 */
export interface ChatRunStore {
  append(run: ChatRun): Promise<void>;
  read(sessionId: string): Promise<ChatRun[]>;
  delete(sessionId: string): Promise<void>;
  prune(now: Date): Promise<number>;
  /** The newest record across all conversations; null when there is none. */
  latest(): Promise<ChatRun | null>;
}

/** Newest file by mtime (records are append-only, so it holds the newest
 * call), then its last parseable record. */
async function latestRun(homeBase: string): Promise<ChatRun | null> {
  let names: string[];
  try {
    names = (await readdir(runsDir(homeBase))).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let newest: { id: string; mtime: number } | null = null;
  for (const name of names) {
    try {
      const st = await stat(join(runsDir(homeBase), name));
      if (newest === null || st.mtimeMs > newest.mtime) newest = { id: name.slice(0, -".jsonl".length), mtime: st.mtimeMs };
    } catch {
      // vanished — skip
    }
  }
  if (newest === null || !SAFE_ID.test(newest.id)) return null;
  return (await readRuns(homeBase, newest.id)).at(-1) ?? null;
}

export function localRunStore(homeBase: string): ChatRunStore {
  return {
    append: (run) => appendRun(homeBase, run),
    read: (sessionId) => readRuns(homeBase, sessionId),
    delete: (sessionId) => deleteRuns(homeBase, sessionId),
    prune: (now) => pruneRuns(homeBase, now),
    latest: () => latestRun(homeBase),
  };
}
