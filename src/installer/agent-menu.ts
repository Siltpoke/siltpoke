// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { AgentTarget, SupportedAgent } from "./agent-types";

export type { SupportedAgent } from "./agent-types";

import type { AgentPresence } from "./agent-detect";
import { installClaude, installCodex } from "./agent-offer";
import { secondaryHostAdapters } from "./host-adapter";
import { type Locale, t } from "./i18n";
import { askMultiSelectTTY } from "./multiselect-tty";
import type { Exec } from "./prereq";
import { askYesNo, type LabeledChoice, type WizardIO } from "./wizard";

const AGENT_ALIASES: Readonly<Record<string, SupportedAgent>> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  codex: "codex",
  codebuddy: "codebuddy",
  qoder: "qodercli",
  qodercli: "qodercli",
  agy: "antigravity",
  antigravity: "antigravity",
};

export type AgentFlagResult =
  | { ok: true; agents: SupportedAgent[] }
  | { ok: false; error: string };

export function resolveAgentFlag(csv: string): AgentFlagResult {
  const tokens = csv.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: "no agent named. valid: claude, codex, codebuddy, qoder, agy" };
  }
  const agents: SupportedAgent[] = [];
  for (const tok of tokens) {
    const canonical = AGENT_ALIASES[tok];
    if (!canonical) {
      return {
        ok: false,
        error: `unknown agent '${tok}'. valid: claude, codex, codebuddy, qoder, agy`,
      };
    }
    if (!agents.includes(canonical)) agents.push(canonical);
  }
  return { ok: true, agents };
}

export interface AgentMenuItem extends LabeledChoice<SupportedAgent> {
  supported: boolean;
}

interface AgentSpec {
  value: SupportedAgent;
  name: string;
  supported: boolean;
  presentKey: keyof AgentPresence;
}

const CLAUDE_SPEC: AgentSpec = { value: "claude-code", name: "Claude Code", supported: true, presentKey: "claude" };
// claude = mandatory anchor (not a registry entry); every other agent is
// derived from the single secondaryHostAdapters registry so menu + dispatch
// never drift. antigravity joined this registry in the agy-statusline-host
// track (previously a detect-only ANTIGRAVITY_SPEC placeholder here).
const SPECS: readonly AgentSpec[] = [
  CLAUDE_SPEC,
  ...secondaryHostAdapters.map((a): AgentSpec => ({ value: a.id, name: a.label, supported: true, presentKey: a.presenceKey })),
];

export function buildAgentChoices(presence: AgentPresence): {
  items: AgentMenuItem[];
  defaults: SupportedAgent[];
} {
  const items: AgentMenuItem[] = SPECS.map((s) => ({
    value: s.value,
    supported: s.supported,
    label: `${s.name}  ${s.supported ? "✅ siltpoke supported" : "🔜 support coming"}`,
  }));
  const defaults = SPECS.filter((s) => s.supported && presence[s.presentKey]).map((s) => s.value);
  return { items, defaults };
}

export interface AgentSelectionResult {
  exit: boolean;
  presetAgents: AgentTarget[];
}

const NO_HOST_MSG =
  "siltpoke has no coding-agent host to attach to — nothing to install. Exiting cleanly.\n";

export function labelFor(value: SupportedAgent): string {
  return SPECS.find((s) => s.value === value)?.name ?? value;
}

/**
 * `--agent` flag gate (final-branch review Fix 1): a named-but-absent
 * SECONDARY host (codex/codebuddy/qodercli/antigravity) must be dropped, not
 * wired blind — siltpoke wires existing installs, it never installs a CLI on
 * the user's behalf via this flag. claude-code is the mandatory anchor and is
 * always kept regardless of presence (its own install-if-absent path runs
 * separately in runInstall). Pure + exported so it's unit-testable without
 * driving the full runInstall flow.
 */
export function filterPresetByPresence(
  agents: readonly AgentTarget[],
  presence: AgentPresence,
): { kept: AgentTarget[]; dropped: AgentTarget[] } {
  const kept: AgentTarget[] = [];
  const dropped: AgentTarget[] = [];
  for (const a of agents) {
    if (a === "claude-code") {
      kept.push(a);
      continue;
    }
    const spec = SPECS.find((s) => s.value === a);
    const present = spec ? presence[spec.presentKey] : true;
    if (present) kept.push(a);
    else dropped.push(a);
  }
  return { kept, dropped };
}

/**
 * Claude-code host resolution (AC14 no-host gate) — one place, four cases:
 *   claude-code selected + present     → nothing to do
 *   claude-code selected + absent      → install (non-fatal)
 *   claude-code not selected + absent  → offer install; decline → exit
 *   claude-code not selected + present → confirm keep; decline → exit
 *
 * Extracted from `selectAndInstallAgents` to keep that function's cognitive
 * complexity under the lint ceiling; behavior is identical to having the
 * four branches inline.
 */
async function resolveClaudeHost(opts: {
  claudeSelected: boolean;
  presence: AgentPresence;
  io: WizardIO;
  exec: Exec;
}): Promise<{ exit: boolean }> {
  const { claudeSelected, presence, io, exec } = opts;
  if (claudeSelected) {
    if (!presence.claude) installClaude(exec, io);
    return { exit: false };
  }
  if (!presence.claude) {
    const wantsClaude = await askYesNo(
      io,
      "No Claude Code selected. siltpoke needs a coding-agent host — install Claude Code now?",
      { default: "yes" },
    );
    if (!wantsClaude) {
      io.write(NO_HOST_MSG);
      return { exit: true };
    }
    installClaude(exec, io);
    return { exit: false };
  }
  const keep = await askYesNo(io, "siltpoke needs Claude Code as its host — keep it?", {
    default: "yes",
  });
  if (!keep) {
    io.write(NO_HOST_MSG);
    return { exit: true };
  }
  return { exit: false };
}

/**
 * Single agent-install path — the multi-agent picker wired
 * into `runBootstrap`, replacing the old single-claude/single-codex prompt flow.
 */
export async function selectAndInstallAgents(opts: {
  presence: AgentPresence;
  io: WizardIO;
  exec: Exec;
  platform?: NodeJS.Platform;
  locale: Locale;
}): Promise<AgentSelectionResult> {
  const { presence, io, exec, platform, locale } = opts;
  const { items, defaults } = buildAgentChoices(presence);
  const picked = await askMultiSelectTTY(io, t("agents.pick", locale), items, defaults);

  // Drop 🔜 unsupported picks with a note (support lands later).
  const supported = new Set(items.filter((i) => i.supported).map((i) => i.value));
  const survivors: SupportedAgent[] = [];
  for (const v of picked) {
    if (supported.has(v)) survivors.push(v);
    else io.write(`${labelFor(v)} support is coming — skipping for now.\n`);
  }

  const claudeGate = await resolveClaudeHost({
    claudeSelected: survivors.includes("claude-code"),
    presence,
    io,
    exec,
  });
  if (claudeGate.exit) return { exit: true, presetAgents: [] };

  // Codex: install if selected + absent.
  let codexOk = survivors.includes("codex");
  if (codexOk && !presence.codex) codexOk = installCodex(exec, io, platform);

  // Non-Claude hosts wired only if already present — siltpoke does not
  // install codebuddy/qoder/agy binaries for the user: codebuddy/qoder are
  // Claude-Code forks, antigravity has its own hooks.json mechanism
  // (agyHostAdapter), but the "wire-only-if-present" gate is identical for
  // all three.
  const wireOnlyIfPresentTargets: AgentTarget[] = [];
  if (survivors.includes("codebuddy") && presence.codebuddy) wireOnlyIfPresentTargets.push("codebuddy");
  if (survivors.includes("qodercli") && presence.qodercli) wireOnlyIfPresentTargets.push("qodercli");
  if (survivors.includes("antigravity") && presence.antigravity) wireOnlyIfPresentTargets.push("antigravity");

  const presetAgents: AgentTarget[] = [
    "claude-code",
    ...(codexOk ? (["codex"] as const) : []),
    ...wireOnlyIfPresentTargets,
  ];
  return { exit: false, presetAgents };
}
