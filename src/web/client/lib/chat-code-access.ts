// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The "can chat open your files?" chip in the chat's context bar.
 *
 * Since #1058 a claude chat turn that belongs to a project runs in that
 * project's folder and may read it; every other turn sees only what the page
 * sends. The bar did not say which, so a user could not tell an answer read
 * from the code from one guessed from names.
 *
 * The server decides (`previewCodeAccess` in src/chat/repo-access.ts, the
 * same rule the send path uses); this file builds the question and the words.
 */
import { type CodeMapViewPayload, viewField } from "./code-map-view";

export type CodeAccess = "reads" | "agent" | "no_project";

interface ConvLike {
  serverSessionId: string | null;
  anchor: { projHash: string } | null;
  critiqueAnchor?: { proj_hash: string } | null;
  pinSent?: boolean;
}

/**
 * The query-string tail for `/api/chat/context-preview`: the conversation, the
 * project it is about to pin to, and the Code Map's open project — each only
 * when the next message would carry it. The anchor goes once, before the pin
 * is sent (as in `send`); after that the server's stored anchor decides, and a
 * pin the server never stored means no project, here as in the send.
 */
export function codeAccessQuery(conv: ConvLike | null, view: CodeMapViewPayload | null, onGraph: boolean): string {
  if (!conv) return "";
  const p = new URLSearchParams();
  if (conv.serverSessionId) p.set("session", conv.serverSessionId);
  const anchorHash = conv.pinSent ? undefined : (conv.critiqueAnchor?.proj_hash ?? conv.anchor?.projHash);
  if (anchorHash) p.set("anchor_hash", anchorHash);
  const viewHash = viewField(!!(conv.anchor || conv.critiqueAnchor), view, onGraph).view?.proj_hash;
  if (viewHash) p.set("view_hash", viewHash);
  const tail = p.toString();
  return tail ? `&${tail}` : "";
}

/**
 * The chip, or nothing. "Can open" shows on every page. "Can't open" shows
 * only where a user would expect chat to know the code — the Code Map, or a
 * conversation pinned to a node or a review — so Home and Settings stay quiet.
 */
export function codeAccessChip(
  access: CodeAccess | undefined,
  expectsCode: boolean,
): { label: string; title: string } | null {
  if (access === "reads") {
    return { label: "can open your files", title: "Chat may open and search this project's files (read only) before it answers." };
  }
  if (!access || !expectsCode) return null;
  if (access === "agent") {
    return {
      label: "can't open your files",
      title: "Only claude opens your files in chat, and another agent answers here. Chat sees only what this page sends it.",
    };
  }
  return {
    label: "can't open your files",
    title: "This conversation has no project folder, so chat sees only what this page sends it.",
  };
}
