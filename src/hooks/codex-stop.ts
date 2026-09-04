// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { runHook, type DaemonSpawnFn } from "./on-stop";
import type { CallBrainOptions, BrainCallResult } from "../brain/brain";
import { maybeRecordWhy } from "./why-index-wiring";

async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function normalizeCodexStop(raw: string): string {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    input = {};
  }

  const transcriptPath =
    typeof input.transcript_path === "string"
      ? input.transcript_path
      : typeof input.transcriptPath === "string"
        ? input.transcriptPath
        : undefined;
  const sessionId =
    typeof input.session_id === "string"
      ? input.session_id
      : typeof input.sessionId === "string"
        ? input.sessionId
        : "codex";

  return JSON.stringify({
    ...input,
    hook_event_name: "Stop",
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
    siltpoke_host: "codex",
  });
}

export interface RunCodexStopHookOptions {
  rawJson: string;
  /**
   * Test seam — defaults to `process.env` (real usage). The recursion guard
   * (AC4) rides entirely on this: `SILTPOKE_INTERNAL=1` (set by the codex
   * adapter's spawn env, src/brain/providers/codex.ts) is read here and
   * checked by `shouldFire()` inside `handleStopHook` — the SAME early-return
   * used by the claude Stop path (src/router/router.ts) — before any
   * budget/critic/telemetry side effect.
   */
  env?: NodeJS.ProcessEnv;
  brainFn?: (opts: CallBrainOptions) => Promise<BrainCallResult>;
  spawnFn?: DaemonSpawnFn;
}

/** Testable entry point — the `if (import.meta.main)` block below is the
 * only untestable part (real stdin/process.exit). */
export async function runCodexStopHook(opts: RunCodexStopHookOptions): Promise<void> {
  const normalized = normalizeCodexStop(opts.rawJson);

  // Slice ④ task 3 — record commit→session WHY index. codex-stop.ts already
  // fully awaits the whole review pipeline below (no fast-return constraint
  // like agy's — see agy-stop.ts's file header), so this can safely await.
  // It is redundant with handle-stop.ts's own host-aware maybeRecordWhy call
  // reached via runHook → handleStopHook below (idempotent per session_id —
  // whichever call lands first wins; both agree on host "codex" since
  // event.siltpoke_host is stamped "codex" here), kept as an explicit
  // call-site here so a future change to that shared internal call can't
  // silently drop codex coverage without tripping the wiring-not-forgotten
  // test (tests/hooks/why-index-wiring.test.ts).
  try {
    const parsed = JSON.parse(normalized) as {
      cwd?: string;
      session_id?: string;
      transcript_path?: string;
    };
    if (parsed.cwd && parsed.session_id && parsed.transcript_path) {
      await maybeRecordWhy({
        cwd: parsed.cwd,
        sessionId: parsed.session_id,
        transcriptPath: parsed.transcript_path,
        host: "codex",
        stopTime: new Date().toISOString(),
      });
    }
  } catch {
    // best-effort — never break the Stop path
  }

  await runHook({
    rawJson: normalized,
    env: opts.env,
    brainFn: opts.brainFn,
    spawnFn: opts.spawnFn,
  });
}

if (import.meta.main) {
  try {
    const raw = await readStdinAll();
    await runCodexStopHook({ rawJson: raw });
    process.exit(0);
  } catch {
    process.exit(0);
  }
}
