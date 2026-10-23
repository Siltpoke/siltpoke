// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Plugin-path setup's agy half — defect `[35]`.
 *
 * `dist/siltpoke-configure.js` used to wire only Claude Code's statusline. The
 * source install writes agy's (`cleanAgyOrphanSettings`); the plugin path
 * never did, so an agy user who ran setup saw no pet in agy (install audit
 * §50.4). This fills that gap for a user who installed the plugin INTO agy.
 *
 * Rules:
 *   - Only when agy has this plugin installed. No agy plugin ⇒ nothing.
 *   - Replace only a slot that is empty or already ours (the `[34]` setup hint,
 *     or a siltpoke pet). A statusline that belongs to the user or to another
 *     tool is left alone, and the setup summary says so. Chaining to it the way
 *     Claude Code does (inner.txt) is not built: inner.txt is Claude's alone,
 *     and the card deliberately skips it for any other host.
 *   - "Ours" is decided by the command's whole SHAPE, not by a word in it: a
 *     substring test called `/opt/interface/wrapper.sh` ours and overwrote it.
 *   - The same protections `[34]` earned in review: a symlinked file is not
 *     written · file mode is kept · re-read after writing · the command always
 *     exits 0 and sends the card's stderr nowhere.
 *
 * UNMEASURED: whether agy on Windows runs statusLine commands through `sh`. The
 * command is POSIX, same as the `[34]` hint.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { hintCommand, isSymlink, readSettings, shQuote } from "../hooks/agy-setup-hint";
import { atomicWrite } from "../utils/atomic-write";
import { resolveAgyPluginRoot, resolveAntigravityHome } from "./paths";
import { markDone, recordBefore } from "./receipt";
import { agyStatuslineEntry } from "./receipt-sites";

export type AgyStatuslineOutcome =
  | "no-agy" // agy has no siltpoke plugin — nothing to do, nothing to say
  | "installed"
  | "occupied" // someone else's statusline — left alone
  | "unwritable"; // symlinked / unreadable settings, or the write did not stick

const AGY_NO_BUN_TEXT = "siltpoke: can't find bun (not on PATH)";

/**
 * The pet command. The bun path setup ran under comes first, but bun gets
 * upgraded and moved, so it falls back the way the Claude Code shim does
 * (src/installer/shim.ts): PATH → ~/.siltpoke/bun-path → ~/.bun/bin/bun. With
 * no bun anywhere it says so on the statusline — the one surface agy shows —
 * instead of going blank (defects [20]/[21]: "installed", and nothing appears).
 */
function agyPetCommand(bunPath: string, card: string): string {
  return [
    `B=${shQuote(bunPath)}`,
    `[ -f "$B" ] && [ -x "$B" ] || B="$(command -v bun 2>/dev/null)"`,
    `[ -n "$B" ] || B="$(cat "$HOME/.siltpoke/bun-path" 2>/dev/null)"`,
    `[ -f "$B" ] && [ -x "$B" ] || B="$HOME/.bun/bin/bun"`,
    `if [ -x "$B" ]; then "$B" ${shQuote(card)} --agent antigravity 2>/dev/null; else cat >/dev/null; printf '%s' ${shQuote(AGY_NO_BUN_TEXT)}; fi`,
    "true",
  ].join("; ");
}

/** Every single-quoted token folded to one placeholder, so only the shape is left. */
const QUOTED = /'[^']*'(?:\\''[^']*')*/g;
function shape(command: string): string {
  return command.replace(QUOTED, "Q");
}

// The source install's command (host-adapter.ts): `<bun> <repo>/src/face/wrapper.ts --agent antigravity`,
// unquoted. `.+` rather than `\S+`: a bun or repo path with a space (`C:\Users\First Last\…`)
// is still ours, and the source install must refresh it rather than report it as the
// user's (defect [65] review). The anchored tail keeps the match to this exact shape.
const SOURCE_PET = /^.+ .+[/\\]src[/\\]face[/\\]wrapper\.ts --agent antigravity$/;

/**
 * A statusline we may replace: our `[34]` hint, our pet, or the source install's
 * pet. Shared with the source install's `cleanAgyOrphanSettings` (defect [65]).
 */
export function isOurAgyStatusLine(command: unknown): boolean {
  if (typeof command !== "string") return false;
  if (shape(command) === shape(hintCommand("a", "b"))) return true;
  if (shape(command) === shape(agyPetCommand("a", "b"))) {
    const card = command.match(QUOTED)?.[1] ?? "";
    // join() writes backslashes on Windows; compare with forward slashes.
    return card.replace(/\\/g, "/").endsWith("/dist/siltpoke-card.js'");
  }
  return SOURCE_PET.test(command);
}

export type AgyUnwireOutcome =
  | "no-agy" // agy has no settings file — nothing of ours can be in it
  | "removed"
  | "not-ours" // no statusline, or someone else's — left alone
  | "unwritable";

/**
 * Uninstall's half of `wireAgyStatusline` (defect [61]). Wiring only ever
 * writes into an empty slot or over our own command, so there is no earlier
 * command to put back: removing the key IS the restore.
 */
export function unwireAgyStatusline(env: NodeJS.ProcessEnv): AgyUnwireOutcome {
  const settingsPath = join(resolveAntigravityHome(env), "settings.json");
  if (!existsSync(settingsPath)) return "no-agy";
  if (isSymlink(settingsPath)) return "unwritable";
  const settings = readSettings(settingsPath);
  if (settings === null) return "unwritable";

  const current = settings.statusLine as { command?: unknown } | undefined;
  if (!isOurAgyStatusLine(current?.command)) return "not-ours";

  const { statusLine: _ours, ...rest } = settings;
  atomicWrite(settingsPath, `${JSON.stringify(rest, null, 2)}\n`, { mode: statSync(settingsPath).mode & 0o777 });
  return readSettings(settingsPath)?.statusLine === undefined ? "removed" : "unwritable";
}

export function wireAgyStatusline(
  env: NodeJS.ProcessEnv,
  bunPath: string,
  pluginRoot: string = resolveAgyPluginRoot(env),
): AgyStatuslineOutcome {
  const card = join(pluginRoot, "dist", "siltpoke-card.js");
  if (!existsSync(card)) return "no-agy";

  const settingsPath = join(resolveAntigravityHome(env), "settings.json");
  if (isSymlink(settingsPath)) return "unwritable";
  const settings = readSettings(settingsPath);
  if (settings === null) return "unwritable";

  const current = settings.statusLine as { command?: unknown } | undefined;
  if (current !== undefined && !isOurAgyStatusLine(current?.command)) return "occupied";

  const command = agyPetCommand(bunPath, card);
  // Receipt (spec §2.1): pending before the write, done once the file reads back
  // as ours. Already ours (an install from before receipts) is recorded too.
  const entry = agyStatuslineEntry(settingsPath);
  recordBefore(entry, env);
  if (current?.command === command) {
    markDone(entry.id, env);
    return "installed";
  }

  const next = { ...settings, statusLine: { type: "command", command } };
  const mode = existsSync(settingsPath) ? statSync(settingsPath).mode & 0o777 : undefined;
  atomicWrite(settingsPath, `${JSON.stringify(next, null, 2)}\n`, mode === undefined ? undefined : { mode });
  // agy rewrites this file while it runs; report what is on disk, not what we sent.
  const after = readSettings(settingsPath);
  const written = (after?.statusLine as { command?: unknown } | undefined)?.command;
  if (written !== command) return "unwritable";
  markDone(entry.id, env);
  return "installed";
}
