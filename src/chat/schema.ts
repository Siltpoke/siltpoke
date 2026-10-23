// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { z } from "zod";

const chatProviderEnum = z.enum(["claude", "codex", "agy", "qoder", "codebuddy"]);

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool_result"]),
  content: z.string(),
  ts: z.string(),
  model: z.string().nullable().default(null),
  tokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  fts_skip: z.boolean().default(false),
  claude_session_id: z.string().nullable().default(null),
  // Turn outcome. Absent = ok (pre-migration rows parse unchanged). Failed and
  // cancelled turns are persisted so history can render them honestly, but the
  // transcript builder excludes them from model context.
  status: z.enum(["ok", "failed", "cancelled"]).optional(),
  // Only meaningful when status is "failed".
  error_reason: z
    .enum([
      "timeout",
      "spawn_failed",
      "empty_exit",
      // Defect [49] — chat can go to any of the five coding agents.
      "no_provider",
      "choose_provider",
      "quota_cap",
      "provider_failed",
    ])
    .optional(),
  // Which agent the failure belongs to, and (choose_provider) which were found.
  // Enums, never free text: the chat UI builds its sentence from these names.
  error_provider: chatProviderEnum.optional(),
  error_found: z.array(chatProviderEnum).max(5).optional(),
  // Short human hint only — raw stderr goes to the daemon log, never the store.
  error_message: z.string().max(300).optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export function parseChatMessage(raw: unknown): ChatMessage {
  return chatMessageSchema.parse(raw);
}
