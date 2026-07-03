// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
export interface RouterDecision {
  fire: boolean;
  reason: string;
}

export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

export function shouldFire(
  event: HookEvent,
  env: NodeJS.ProcessEnv = process.env,
): RouterDecision {
  if (env.SILTPOKE_INTERNAL === "1") {
    return { fire: false, reason: "recursion_guard" };
  }
  if (event.hook_event_name && event.hook_event_name !== "Stop") {
    return { fire: false, reason: "wrong_event" };
  }
  if (!event.session_id || !event.transcript_path) {
    return { fire: false, reason: "missing_fields" };
  }
  return { fire: true, reason: "ok" };
}
