// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { HOST_BINARY, readLastHost } from "../installer/last-host";
import { explicitRoleSync, FAMILIES, type ProviderFamily } from "./brain-config";
import { familyModelDefault, familySupportsModelChoice } from "./registry";

/**
 * Which coding agent one dashboard chat message goes to (defect `[49]`, spec
 * an internal design note §3).
 *
 * Chat used to launch `claude` whatever was configured. The order here:
 *
 *   1. the user chose one for chat (`brain.roles.chat`)     → `chosen`
 *   2. what is installed: exactly one                       → `installed`
 *                         two or more                       → `choose` (ask)
 *                         none                              → `none`
 *
 * There was a step between them — "the agent they worked in last" — and spec
 * 2026-10-13-agent-in-use-truth §11.1 removed it:
 * `last-host` is one global, time-ordered record, so with two agents open in two
 * projects chat could answer with the one you were not looking at. `last-host`
 * now counts only as an install record: the autostarted daemon has a short
 * PATH, and the hook that wrote it saw the user's real one, so a command it
 * recorded that still exists is installed, and its folder goes in front of the
 * child's PATH.
 *
 * ONE function answers this for the chat route, the Settings row and
 * `/siltpoke:siltpoke-brain`, so what the page says it will use is what chat uses.
 * It is cheap (one or two small file reads and PATH lookups) and is called per
 * message, uncached, so a change on the Settings page applies to the next one.
 */
export type ChatProviderSource = "chosen" | "installed";

export type ChatProviderResolution =
  | {
      kind: "use";
      family: ProviderFamily;
      source: ChatProviderSource;
      /** Absent = the family's CLI picks its own model. */
      model?: string;
      /**
       * Set only when the command is NOT on this process's PATH but the path a
       * hook recorded still exists: the folder to add to the child's PATH. The
       * autostarted daemon gets a short PATH; the hook saw the user's real one.
       */
      commandDir?: string;
    }
  | { kind: "choose"; found: ProviderFamily[] }
  | { kind: "none" };

export interface ChatProviderDeps {
  which?: (bin: string) => string | null;
  fileExists?: (path: string) => boolean;
}

function chatModel(family: ProviderFamily, configured?: string): string | undefined {
  // A model the family's argv cannot carry is dropped, as resolveRole does.
  return (familySupportsModelChoice(family) ? configured : undefined) ?? familyModelDefault(family, "chat");
}

function use(
  family: ProviderFamily,
  source: ChatProviderSource,
  configuredModel?: string,
  commandDir?: string,
): ChatProviderResolution {
  const model = chatModel(family, configuredModel);
  return {
    kind: "use",
    family,
    source,
    ...(model !== undefined ? { model } : {}),
    ...(commandDir !== undefined ? { commandDir } : {}),
  };
}

/** A recorded command path counts only when it is a file: its FOLDER goes on a
 * child's PATH, and a record naming a directory would put that directory's
 * parent there. */
function isCommandFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** How "installed" is told: the command on PATH, or the path a hook recorded. */
function probeInstalled(homeBase: string, deps: ChatProviderDeps) {
  // PATH is passed explicitly: with no options `Bun.which` reads the PATH this
  // process STARTED with, while a spawn is handed `process.env` as it is now.
  // "Found" must mean "a spawn from here will find it" — one PATH for both.
  const rawWhich = deps.which ?? ((bin: string) => Bun.which(bin, { PATH: process.env.PATH ?? "" }));
  const fileExists = deps.fileExists ?? isCommandFile;
  const onPath = (family: ProviderFamily): boolean => {
    try {
      return rawWhich(HOST_BINARY[family]) !== null;
    } catch {
      return false;
    }
  };

  // What last-host recorded, as an install record only (see the header): the
  // family, and the folder of its command when that command is off PATH but
  // still a file.
  const last = readLastHost(homeBase);
  const recordedDir = (family: ProviderFamily): string | undefined =>
    last !== null && last.family === family && last.commandPath !== null && fileExists(last.commandPath)
      ? dirname(last.commandPath)
      : undefined;
  const installed = (f: ProviderFamily): boolean => onPath(f) || recordedDir(f) !== undefined;
  return { onPath, recordedDir, installed };
}

/**
 * The families this machine has, by the same rule chat uses to pick one: the
 * command is on PATH, or a hook recorded a path to it that is still a file.
 * The Settings page shows it (spec §12.1 — "installed" / "not installed").
 */
export function installedFamilies(homeBase: string, deps: ChatProviderDeps = {}): ProviderFamily[] {
  const { installed } = probeInstalled(homeBase, deps);
  return FAMILIES.filter(installed);
}

export function resolveChatProvider(homeBase: string, deps: ChatProviderDeps = {}): ChatProviderResolution {
  const { onPath, recordedDir, installed } = probeInstalled(homeBase, deps);
  const commandDirFor = (family: ProviderFamily): string | undefined => (onPath(family) ? undefined : recordedDir(family));

  // 1. A choice is used as it stands, even when its command is missing: the
  // failure then names this family. Falling through to another agent would
  // leave the user not knowing who answered.
  const chosen = explicitRoleSync(homeBase, "chat");
  if (chosen !== undefined) return use(chosen.provider, "chosen", chosen.model, commandDirFor(chosen.provider));

  // 2. What is installed. Two or more is the user's call, not ours — and claude
  // gets no priority, or a machine with a logged-out claude breaks again.
  const found = FAMILIES.filter(installed);
  if (found.length === 1) {
    const only = found[0] as ProviderFamily;
    return use(only, "installed", undefined, commandDirFor(only));
  }
  return found.length === 0 ? { kind: "none" } : { kind: "choose", found };
}
