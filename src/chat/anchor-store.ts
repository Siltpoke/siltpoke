// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Sidecar store for a conversation's FROZEN anchor context.
 *
 * The anchor metadata (node id, fingerprint, pinned_at) lives on the
 * ChatSession record (memory.json). The Brain-ready context bundle is bigger
 * and per-conversation, so it lives next to the conversation transcript:
 * `<homeBase>/chats/<sessionId>.anchor.json`.
 *
 * Written ONCE at pin time (conversation creation) — this is what makes the
 * answer reproducible at the pinned version: sends read this frozen bundle
 * rather than re-deriving from the live graph (which would silently answer
 * the new code after a re-index).
 */

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import type { AnchorContext } from "./anchor-context";

const CHATS_DIRNAME = "chats";

function anchorPath(homeBase: string, sessionId: string): string {
  return join(homeBase, CHATS_DIRNAME, `${sessionId}.anchor.json`);
}

/**
 * Freeze the resolved anchor context for a conversation (pin time).
 * NOTE: `atomicWrite` is SYNCHRONOUS by design (writeFileSync + renameSync), so
 * the sidecar is durably on disk before this async fn resolves — the same-request
 * `readAnchorContext` that follows is guaranteed to see it. If atomicWrite is ever
 * made async, this MUST become `await atomicWrite(...)` or the read races.
 */
export async function writeAnchorContext(
  homeBase: string,
  sessionId: string,
  ctx: AnchorContext,
): Promise<void> {
  atomicWrite(anchorPath(homeBase, sessionId), JSON.stringify(ctx));
}

/** Idempotent delete of the frozen anchor context sidecar. */
export async function deleteAnchorContext(homeBase: string, sessionId: string): Promise<void> {
  await rm(anchorPath(homeBase, sessionId), { force: true });
}

/** Read a conversation's frozen anchor context; null when not pinned. */
export async function readAnchorContext(
  homeBase: string,
  sessionId: string,
): Promise<AnchorContext | null> {
  const path = anchorPath(homeBase, sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as AnchorContext;
  } catch {
    return null;
  }
}
