// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Dashboard chat reading the user's code.
 *
 * Chat's `claude` may only Read / Grep / Glob (#1053), but it ran from the
 * daemon's working directory — `/` under launchd — and was told to answer
 * from the page's context only. On a Code Map component it saw names and
 * links, no code, and guessed from the names.
 *
 * A turn that belongs to a project now runs with that project's root as its
 * working directory, and is told it may read the files there. With default
 * claude settings its own permission check refuses a read outside the working
 * directory in `-p` mode (measured 2026-10-17: an absolute path outside the
 * project came back "Claude requested permissions to read …" and the value
 * was not returned), so the folder is also the limit. A user's own claude
 * settings (allowed paths, extra directories, a bypass mode) can widen it;
 * the argv does not override them.
 *
 * Claude only: the other chat agents have their own tool rules.
 */
import { statSync } from "node:fs";
import type { ChatProviderResolution } from "../brain/chat-provider";
import { GLOBAL_ONLY } from "../memory/memory";

/**
 * The folder a turn runs in: the project a pinned conversation belongs to
 * (`scope`, already resolved for memory), else the project the Code Map page
 * has open. `undefined` = no project; the turn runs where it always did.
 */
export async function chatProjectRoot(
  scope: string | symbol,
  viewProjHash: string | undefined,
  resolve: ((projHash: string) => Promise<string | null>) | undefined,
): Promise<string | undefined> {
  if (typeof scope === "string") return isDir(scope) ? scope : undefined;
  if (!viewProjHash || !resolve) return undefined;
  try {
    const root = await resolve(viewProjHash);
    return root && isDir(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The registry returns a project's root as it was stored when indexed. A
 * project moved or deleted since would make the spawn fail and kill the turn;
 * the turn runs where it always did instead (review, 2026-10-18).
 */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when this turn will be answered by claude (no resolver wired = claude). */
export function answersWithClaude(res: ChatProviderResolution | undefined): boolean {
  return res === undefined || (res.kind === "use" && res.family === "claude");
}

/**
 * The prompt block for a turn about code that cannot open files: another
 * agent answers chat, or there is no project folder. Without it chat guessed
 * what a file does from its name on a broad question (A2 before/after,
 * 2026-10-18: "Walk me through how the Critic works" described two files it
 * never saw, 2 runs of 2). Sent on the Code Map, unpinned (`noCodeAccessFor`).
 */
export const NO_CODE_ACCESS_BLOCK = [
  "You cannot open the user's files in this chat, and you have no tool that reads them. You see only the context above. Do not offer to read a file.",
  "When a question is about how code works and that code is not in the context, your first sentence says that you have not seen the code, even when the context describes it. Then answer only from what the context shows.",
  "Never say what a file or function does, or probably does, from its name or path. When you mention a file you have not seen, give its path only. A name is not evidence of behaviour.",
].join("\n");

/**
 * The no-access block for a turn, or "": only an UNPINNED turn on the Code Map
 * that cannot open files — it sees names and paths, not code. A pinned turn
 * already carries its code (a node's source, a review's diff), and telling it
 * "you have not seen the code" would be false there (review, 2026-10-18).
 * Home and Settings questions are not about code; the block would be noise.
 */
export function noCodeAccessFor(cwd: string | undefined, pinned: boolean, pageId: string): string {
  return !cwd && !pinned && pageId === "/repo-graph" ? NO_CODE_ACCESS_BLOCK : "";
}

/**
 * What the chat's context bar says before a turn: can chat open the user's
 * files? `"agent"` = another agent answers chat (only claude reads);
 * `"no_project"` = no project folder for this conversation.
 */
export type CodeAccess = "reads" | "agent" | "no_project";

const HASH_RE = /^[0-9a-f]{6,64}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The same decision the send path makes (`chat.ts`: the conversation's
 * project, from its stored anchor or the anchor about to be sent, wins; else
 * the Code Map's open project), made without sending anything. Inputs come
 * from a query string, so each is checked before it is used.
 */
export async function previewCodeAccess(a: {
  resolution: ChatProviderResolution | undefined;
  session?: string;
  anchorHash?: string;
  viewHash?: string;
  listSessions: () => Promise<Array<{ id: string; anchor?: { proj_hash?: string } | null }>>;
  resolve: ((projHash: string) => Promise<string | null>) | undefined;
}): Promise<CodeAccess> {
  if (!answersWithClaude(a.resolution)) return "agent";
  let stored: string | undefined;
  if (a.session && SESSION_RE.test(a.session)) {
    try {
      stored = (await a.listSessions()).find((s) => s.id === a.session)?.anchor?.proj_hash;
    } catch {
      stored = undefined;
    }
  }
  const hash = stored ?? (a.anchorHash && HASH_RE.test(a.anchorHash) ? a.anchorHash : undefined);
  let scope: string | symbol = GLOBAL_ONLY;
  if (hash && a.resolve) {
    try {
      scope = (await a.resolve(hash)) ?? GLOBAL_ONLY;
    } catch {
      scope = GLOBAL_ONLY;
    }
  }
  const view = a.viewHash && HASH_RE.test(a.viewHash) ? a.viewHash : undefined;
  return (await chatProjectRoot(scope, view, a.resolve)) ? "reads" : "no_project";
}

/** The prompt block that tells claude it may read the project. */
export function repoAccessBlock(root: string): string {
  return [
    `You can read the user's project. Your working directory is its root (${root}); the Read, Grep and Glob tools work there and nowhere else.`,
    "When a question needs code that is not in the context above, read the files you need before you answer, and cite file:line.",
    "Never describe what code does from a name alone. If you did not read it, say that you have not read it.",
  ].join("\n");
}
