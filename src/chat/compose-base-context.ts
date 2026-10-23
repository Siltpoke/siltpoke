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
import { type CodeMapView, codeMapViewContext } from "./page-view";

export interface ComposeBaseContextInput {
  /**
   * The frozen anchor context (if this conversation is pinned to a node).
   * Only the two fields actually used here are required — callers may pass
   * the full `AnchorContext` (structural typing).
   */
  anchorCtx: { systemPrompt: string; contextBundle: string } | null;
  /** Validated page id (empty string = no page — see `parsePageId`). */
  pageId: string;
  /**
   * What the Code Map page says is open (repository + selected component),
   * already validated by `parseCodeMapView`. Used only for an unpinned chat
   * on `/repo-graph`; a pinned chat and every other page ignore it.
   */
  view?: CodeMapView | null;
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
 * Precedence: node > Code Map view > page > none. Node context wins whenever
 * `anchorCtx` is present (a pinned conversation always discusses the node, not
 * the page). On the Code Map, a view beats the bare page label: the label
 * alone made "what does this do?" get an answer about the page (defect [44]).
 * Page assembly is wrapped in try/catch — it is additive context only and
 * must never block the reply.
 */
export async function composeBaseSystemPrompt(input: ComposeBaseContextInput): Promise<string> {
  const { anchorCtx, pageId, homeBase, readMemory, assemblePage, view } = input;

  if (anchorCtx) {
    return `${anchorCtx.systemPrompt}\n\n--- Context for the node being discussed ---\n${anchorCtx.contextBundle}`;
  }

  if (!pageId) return "";

  if (view && pageId === "/repo-graph") {
    const ctx = codeMapViewContext(view);
    return `${ctx.systemPrompt}\n\n--- What the user has open on the Code Map ---\n${ctx.contextBundle}`;
  }

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
