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
 * codex and agy read too (2026-10-22, redo of #1070; real runs in
 * an internal design note). What holds each one
 * to the project differs:
 *  - codex runs in the project root under its read-only sandbox. On macOS the
 *    sandbox profile (providers/codex-sandbox.ts) refused a home file outside
 *    the project even with no prompt sentence. Elsewhere plain read-only
 *    reads the whole disk, so codex reads the project on macOS only.
 *  - agy runs in its own empty folder (providers/agy-cwd.ts — a repo cwd runs
 *    the project's hooks) and opens the project by absolute path. Nothing in
 *    agy limits its reads: with the prompt's "do not read outside" sentence
 *    removed it read a home file. The sentence is the only limit — the same
 *    exposure review's agy already has (docs/MANUAL.md says so).
 * qoder and codebuddy chat runs with no tools at all; they do not read.
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

/** The agents that read the project, and so get a project folder. */
export type ReadingFamily = "claude" | "codex" | "agy";

/**
 * The agent answering this turn when it reads the project (no resolver wired
 * = claude); undefined = it does not read. `platform` is a test seam;
 * undefined means the real one.
 */
export function readingFamilyOf(
  res: ChatProviderResolution | undefined,
  platform: NodeJS.Platform = process.platform,
): ReadingFamily | undefined {
  if (res === undefined) return "claude";
  if (res.kind !== "use") return undefined;
  if (res.family === "claude" || res.family === "agy") return res.family;
  if (res.family === "codex" && platform === "darwin") return "codex";
  return undefined;
}

/** True when this turn's agent may read the user's project. */
export function readsProject(res: ChatProviderResolution | undefined, platform?: NodeJS.Platform): boolean {
  return readingFamilyOf(res, platform) !== undefined;
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
 * files? `"agent"` = an agent that does not read answers chat (`readsProject`);
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
  platform?: NodeJS.Platform;
}): Promise<CodeAccess> {
  if (!readsProject(a.resolution, a.platform)) return "agent";
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

/**
 * Where each reading agent finds the project. agy's last sentence is the only
 * thing that keeps its reads inside the project (see the header).
 */
const WHERE: Record<ReadingFamily, (root: string) => string> = {
  claude: (root) => `Your working directory is its root (${root}); the Read, Grep and Glob tools work there and nowhere else.`,
  codex: (root) =>
    `Your working directory is its root (${root}); your read-only tools work there. Do not read anything outside this folder.`,
  agy: (root) =>
    `The project is at ${root}. Your working directory is a different, empty folder: open the project's files by their absolute path under ${root}. Do not read anything outside ${root}.`,
};

/** The prompt block that tells the agent it may read the project. */
export function repoAccessBlock(root: string, family: ReadingFamily = "claude"): string {
  return [
    `You can read the user's project. ${WHERE[family](root)}`,
    "When a question needs code that is not in the context above, read the files you need before you answer, and cite file:line.",
    "Never describe what code does from a name alone. If you did not read it, say that you have not read it.",
  ].join("\n");
}
