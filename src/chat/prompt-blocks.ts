// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What one chat call sends, as named blocks (spec 2026-10-13 §10.1 "Sent").
 * The join is moved here from chat.ts unchanged, so the prompt the agent gets
 * is byte-identical; the blocks are the same strings, kept apart for the
 * chat call record.
 */
export interface PromptBlock {
  name: string;
  chars: number;
  text: string;
}

interface ChatPromptParts {
  page: string;
  /** "" unless claude runs in the user's project (src/chat/repo-access.ts). */
  repoAccess?: string;
  /** "" unless a code question meets a turn that cannot open files (src/chat/repo-access.ts). */
  noCodeAccess?: string;
  userFacts: string;
  episodes: string;
  captureHonesty: string;
  captureMarker: string;
  /** Carries its own leading separator (see the recall block in chat.ts). */
  recall: string;
  transcript: string;
}

const NAMES: ReadonlyArray<[keyof ChatPromptParts, string]> = [
  ["page", "page context"],
  ["repoAccess", "reading your project"],
  ["noCodeAccess", "no access to your files"],
  ["userFacts", "what siltpoke knows about you"],
  ["episodes", "past episodes"],
  ["captureHonesty", "memory-save rule"],
  ["captureMarker", "memory-save marker"],
  ["recall", "related past chats"],
];

export function composeChatPrompt(p: ChatPromptParts): {
  systemPrompt: string | undefined;
  blocks: PromptBlock[];
  omitted: string[];
} {
  // All empty → "" || undefined = undefined: nothing injected.
  const systemPrompt =
    ([p.page, p.repoAccess ?? "", p.noCodeAccess ?? "", p.userFacts, p.episodes, p.captureHonesty, p.captureMarker].filter(Boolean).join("\n\n") +
      p.recall) ||
    undefined;
  const blocks: PromptBlock[] = [];
  const omitted: string[] = [];
  for (const [key, name] of NAMES) {
    const text = p[key] ?? "";
    if (text.length > 0) blocks.push({ name, chars: text.length, text });
    // Most turns have no project to read; listing it as "not included" on every one is noise.
    else if (key !== "repoAccess" && key !== "noCodeAccess") omitted.push(name);
  }
  blocks.push({ name: "conversation", chars: p.transcript.length, text: p.transcript });
  return { systemPrompt, blocks, omitted };
}
