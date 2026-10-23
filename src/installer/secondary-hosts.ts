// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateSecret } from "../daemon/auth";
import { atomicWrite } from "../utils/atomic-write";
import type { AgentTarget } from "./agent-types";
import { symlinkCommands } from "./command-links";
import { type HostWireContext, secondaryHostAdapters } from "./host-adapter";
import type { WizardIO } from "./wizard";

// Moved out of cli/install.ts (length-pinned) unchanged; install.ts imports them.

export function readSecretIfPresent(home: string): string | null {
  const secretPath = join(home, "secret");
  if (!existsSync(secretPath)) return null;
  const value = readFileSync(secretPath, "utf8").trim();
  return value.length > 0 ? value : null;
}

export function loadOrCreateSecret(home: string): string {
  const existing = readSecretIfPresent(home);
  if (existing !== null) return existing;
  const s = generateSecret();
  atomicWrite(join(home, "secret"), s, { mode: 0o600 });
  return s;
}

interface WireSecondaryHostsOpts {
  env: NodeJS.ProcessEnv;
  home: string;
  repoRoot: string;
  selectedAgents: AgentTarget[];
  pluginCommandsDir: string;
  platform: NodeJS.Platform;
  io: WizardIO;
  /** Called with each host's id as it is actually wired (the install ending names these). */
  onWired?: (id: string) => void;
}

/**
 * Secondary hosts (codex + codebuddy + qoder): wire each selected host's hooks
 * via its HostAdapter. codex writes ~/.codex/hooks.json (no command symlinks);
 * CC-fork hosts write settings.json + symlink slash-commands. Each host is
 * independent — one failure never blocks the others. Returns the count wired
 * (feeds the already_installed early-returns). Secret loaded once.
 *
 * Extracted out of runInstall (rather than inlined) to keep runInstall's
 * cognitive-complexity flat — this loop's branching lives here instead.
 */
export async function wireSecondaryHosts(opts: WireSecondaryHostsOpts): Promise<number> {
  // secondaryHostAdapters' id is SupportedAgent; selectedAgents is
  // AgentTarget[] — the two unions now mirror each other exactly (agy
  // track), but comparing as strings avoids re-coupling this membership
  // check to the two types staying identical forever.
  const selectedAgentIds: readonly string[] = opts.selectedAgents;
  const selected = secondaryHostAdapters.filter((a) =>
    selectedAgentIds.includes(a.id),
  );
  if (selected.length === 0) return 0;
  const ctx: HostWireContext = {
    repoRoot: opts.repoRoot,
    secret: loadOrCreateSecret(opts.home),
  };
  let wired = 0;
  for (const adapter of selected) {
    try {
      const { path, note } = await adapter.writeHooks(opts.env, ctx);
      // codex has no separate commands dir; agy has no slash-command
      // symlink semantics either (its skill surface is agy's own, not
      // markdown commands under a commands/ dir) — both excluded here.
      if (adapter.id !== "codex" && adapter.id !== "antigravity") {
        await symlinkCommands(
          opts.pluginCommandsDir,
          adapter.commandsDir(opts.env),
          opts.platform,
          opts.env,
        );
      }
      opts.io.write(`✓ Registered ${adapter.label} hooks at ${path}\n`);
      if (note) opts.io.write(`  ${note}\n`);
      wired += 1;
      opts.onWired?.(adapter.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.io.write(`⚠ ${adapter.label} host wiring failed: ${msg}\n`);
    }
  }
  return wired;
}
