// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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
  /** Stamped by the per-host Stop normalizers (agy-stop / codex-stop); used
   *  to scope host-specific handling like the agy `-p` cwd re-anchor. */
  siltpoke_host?: string;
}

/**
 * The recursion predicate, in ONE place. Every Brain provider spawns its
 * subprocess with `SILTPOKE_INTERNAL: "1"` (brain.ts, codex.ts, agy.ts,
 * ccfork-reviewer.ts, chat-stream.ts, explain/providers.ts), so any siltpoke
 * hook that fires inside that nested host session must early-out.
 *
 * It lives here, exported, because the Stop hook checked it and the
 * SessionStart hook did not — and that asymmetry silently disabled the whole
 * memory write-path (a nested session rewrote `baseline.json` with its
 * throwaway `session_id`, so `resolveSessionHeadSha` stopped matching and every
 * critique enqueued with `created_sha: null`). A single shared predicate is
 * what keeps the two hooks from drifting apart again.
 *
 * Note the guard is ALSO duplicated in shell, per host wrapper
 * (`hooks/codex-stop.sh:13`, `hooks/codex-session-start.sh:6`) — those exit
 * before ever reaching TypeScript. That is why coverage was uneven: codex was
 * guarded at the shell layer while the native-Claude-Code wrapper
 * (`hooks/session-start.sh`) was not. Adding a wrapper for a new host means
 * deciding, explicitly, which layer guards it.
 */
export function isSiltpokeInternal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SILTPOKE_INTERNAL === "1";
}

export function shouldFire(
  event: HookEvent,
  env: NodeJS.ProcessEnv = process.env,
): RouterDecision {
  if (isSiltpokeInternal(env)) {
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
