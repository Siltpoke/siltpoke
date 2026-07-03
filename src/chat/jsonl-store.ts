// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { appendFile, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chatMessageSchema, type ChatMessage } from "./schema";

const CHATS_DIRNAME = "chats";

function chatsDir(homeBase: string): string {
  return join(homeBase, CHATS_DIRNAME);
}

function sessionPath(homeBase: string, sessionId: string): string {
  return join(chatsDir(homeBase), `${sessionId}.jsonl`);
}

/**
 * Per-message O_APPEND write. Single-writer invariant: daemon is single writer, so we
 * skip cross-process locking. Line-bounded JSONL entries stay atomic on POSIX
 * for writes < PIPE_BUF; long messages tolerate interleave only with another
 * writer (forbidden by the single-writer invariant).
 */
export async function appendMessage(
  homeBase: string,
  sessionId: string,
  msg: ChatMessage,
): Promise<void> {
  if (msg.session_id !== sessionId) {
    throw new Error(
      `session_id mismatch: msg=${msg.session_id} arg=${sessionId}`,
    );
  }
  await mkdir(chatsDir(homeBase), { recursive: true });
  const line = `${JSON.stringify(msg)}\n`;
  await appendFile(sessionPath(homeBase, sessionId), line, "utf8");
}

export async function readSession(
  homeBase: string,
  sessionId: string,
): Promise<ChatMessage[]> {
  const path = sessionPath(homeBase, sessionId);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const out: ChatMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const result = chatMessageSchema.safeParse(parsed);
    if (result.success) out.push(result.data);
  }
  return out;
}

export async function deleteSessionFile(homeBase: string, sessionId: string): Promise<void> {
  await rm(sessionPath(homeBase, sessionId), { force: true });
}

export interface SessionFile {
  session_id: string;
  path: string;
}

export async function listSessions(homeBase: string): Promise<SessionFile[]> {
  const dir = chatsDir(homeBase);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir);
  const out: SessionFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const session_id = entry.slice(0, -".jsonl".length);
    if (session_id.length === 0) continue;
    out.push({ session_id, path: join(dir, entry) });
  }
  return out;
}
