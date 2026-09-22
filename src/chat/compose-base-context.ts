// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Chat base-context composition — extracted from `src/daemon/routes/chat.ts`
 * (Task 2 follow-up: bring chat.ts back under the 800-LOC hard cap) so the
 * node > page > none precedence logic lives in one testable, reusable place,
 * following the repo's established precedent (`anchor-context.ts`,
 * `page-context.ts`, `chat-capture-runner.ts` all pull logic out of chat.ts).
 *
 * Behavior is unchanged from the inline version it replaces: a resolved node
 * anchor always wins; otherwise a valid page id assembles page context
 * (fail-open — try/catch, additive only, never blocks the reply); otherwise
 * "".
 */
import type { CoreMemory } from "../memory/memory";
import { assemblePageContext, type PageContext } from "./page-context";

export interface ComposeBaseContextInput {
  /**
   * The frozen anchor context (if this conversation is pinned to a node).
   * Only the two fields actually used here are required — callers may pass
   * the full `AnchorContext` (structural typing).
   */
  anchorCtx: { systemPrompt: string; contextBundle: string } | null;
  /** Validated page id (empty string = no page — see `parsePageId`). */
  pageId: string;
  homeBase: string;
  readMemory?: (homeBase: string) => Promise<CoreMemory | null>;
  /**
   * Test seam — mirrors the chat route's `assemblePageContext` dep. Defaults
   * to the real `assemblePageContext` when absent.
   */
  assemblePage?: (
    pageId: string,
    pageDeps: { homeBase: string; readMemory?: (homeBase: string) => Promise<CoreMemory | null> },
  ) => Promise<PageContext | null>;
}

/**
 * Precedence: node > page > none. Node context wins whenever `anchorCtx` is
 * present (a pinned conversation always discusses the node, not the page).
 * Page assembly is wrapped in try/catch — it is additive context only and
 * must never block the reply.
 */
export async function composeBaseSystemPrompt(input: ComposeBaseContextInput): Promise<string> {
  const { anchorCtx, pageId, homeBase, readMemory, assemblePage } = input;

  if (anchorCtx) {
    return `${anchorCtx.systemPrompt}\n\n--- Context for the node being discussed ---\n${anchorCtx.contextBundle}`;
  }

  if (!pageId) return "";

  const assemble = assemblePage ?? assemblePageContext;
  try {
    const pageCtx = await assemble(pageId, { homeBase, readMemory });
    if (!pageCtx) return "";
    return pageCtx.contextBundle
      ? `${pageCtx.systemPrompt}\n\n--- Page context ---\n${pageCtx.contextBundle}`
      : pageCtx.systemPrompt;
  } catch {
    // page context is additive — never block the reply
    return "";
  }
}
