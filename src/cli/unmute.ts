// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * v1.1-I — `/siltpoke-unmute` CLI.
 *
 * Deletes `~/.siltpoke/mute.json`, restoring normal critic gates.
 * Idempotent — running unmute on an un-muted Siltpoke is a no-op (exit
 * 0, output says "wasn't muted").
 */
import { siltpokeRoot } from "../installer/paths";
import { clearMute } from "../state/mute";

export interface UnmuteResult {
  muted: false;
  was_muted: boolean;
}

export interface UnmuteOptions {
  homeBase?: string;
}

export function runUnmute(opts: UnmuteOptions = {}): UnmuteResult {
  const homeBase = opts.homeBase ?? siltpokeRoot();
  const was_muted = clearMute(homeBase);
  return { muted: false, was_muted };
}

export function formatUnmuteHuman(result: UnmuteResult): string {
  if (result.was_muted) {
    return "Siltpoke unmuted. Code Review will fire again on next Stop hook.\n";
  }
  return "Siltpoke wasn't muted. No change.\n";
}

export function formatUnmuteJson(result: UnmuteResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

if (import.meta.main) {
  const jsonFlag = process.argv.includes("--json");
  const result = runUnmute();
  if (jsonFlag) {
    process.stdout.write(formatUnmuteJson(result));
  } else {
    process.stdout.write(formatUnmuteHuman(result));
  }
  process.exit(0);
}
