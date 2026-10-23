// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The two codex rows: is Siltpoke's codex hook declared where codex reads it,
 * and has any codex hook actually run.
 *
 * WHY — Windows Run 4 (install audit §110 W2, 2026-10-14): from the codex copy,
 * doctor printed "All 24 checks passed. Install healthy." while codex had never
 * started Siltpoke's Stop hook on that machine. The Stop row did not check
 * anything under codex — it printed "skipped — … its Stop hook lives in
 * <root>\hooks.json" — so it could not go red. Two things were wrong that day,
 * and either one silences every review:
 *   - the codex manifest named no `hooks` file, so codex read `hooks/hooks.json`,
 *     which is Claude Code's (fixed in #976 — this row catches an older copy);
 *   - there was no `commandWindows`, and Windows has no `sh` to run `command`.
 * A third cause leaves no trace in any file this row can read: codex does not
 * run a plugin hook the user has not trusted. Only the run record answers that,
 * so it is the second row.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostsSeen } from "../installer/last-host";
import { siltpokeRoot } from "../installer/paths";
import { type CheckResult, type DoctorOptions, defaultRepoRoot } from "./doctor";
import { hostOfRunningCopy } from "./doctor-agy-plugin-host";

export const CODEX_STOP_ROW = "Stop hook registered (codex plugin)";
export const CODEX_RAN_ROW = "codex hooks have run";

const UPDATE = "Update the plugin: `codex plugin remove` it, then `codex plugin add` it again.";

interface Handler {
  type?: unknown;
  command?: unknown;
  commandWindows?: unknown;
}

/** The handlers under `hooks.Stop[*].hooks[*]`, or null when the file cannot be read as that shape. */
function stopHandlers(file: string): Handler[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const stop = (parsed as { hooks?: { Stop?: unknown } } | null)?.hooks?.Stop;
  if (!Array.isArray(stop)) return null;
  return stop.flatMap((g) => {
    const inner = (g as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(inner) ? (inner as Handler[]) : [];
  });
}

/**
 * Read the running copy's codex manifest and the hooks file it names, the way
 * codex does: the manifest's `hooks` path, relative to the plugin root.
 */
export function checkCodexStopHook(opts: DoctorOptions, root: string): CheckResult {
  const fail = (detail: string): CheckResult => ({ name: CODEX_STOP_ROW, pass: false, detail });
  const manifestPath = join(root, ".codex-plugin", "plugin.json");
  let declared: unknown;
  try {
    declared = (JSON.parse(readFileSync(manifestPath, "utf8")) as { hooks?: unknown } | null)?.hooks;
  } catch {
    return fail(`${manifestPath} is missing or not valid JSON, so codex cannot load this plugin's hooks. ${UPDATE}`);
  }
  if (typeof declared !== "string" || declared === "") {
    return fail(
      `${manifestPath} names no "hooks" file, so codex reads hooks/hooks.json — Claude Code's file — and never runs Siltpoke's codex hook. ${UPDATE}`,
    );
  }
  const file = resolve(root, declared);
  if (!existsSync(file)) return fail(`the manifest names ${file}, which is not there. ${UPDATE}`);
  const handlers = stopHandlers(file);
  const ours = (handlers ?? []).find(
    (h) => h?.type === "command" && typeof h.command === "string" && h.command.includes("codex-stop"),
  );
  if (!ours) return fail(`${file} has no Stop entry that runs codex-stop. ${UPDATE}`);
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    const win = ours.commandWindows;
    if (typeof win !== "string" || !win.includes("siltpoke-hook.ps1") || !win.includes("codex-stop")) {
      return fail(
        `${file} has no Windows command for the Stop hook. On Windows codex runs only "commandWindows", and there is no \`sh\` for the other one. ${UPDATE}`,
      );
    }
  }
  return { name: CODEX_STOP_ROW, pass: true, detail: `declared in ${file}`, status: "pass" };
}

/**
 * Has codex ever run one of Siltpoke's hooks on this machine? Both codex hooks
 * (session start and Stop) write `<siltpoke home>/hosts-seen/codex` before
 * anything else, so its absence means codex has not started them.
 *
 * Warn, not fail: a user who runs doctor in the same codex session that
 * installed the plugin has not started a session with it yet.
 */
export function checkCodexHooksHaveRun(opts: DoctorOptions): CheckResult[] {
  if (hostOfRunningCopy(opts, opts.repoRoot ?? defaultRepoRoot()) !== "codex") return [];
  const seen = hostsSeen(opts.siltpokeHome ?? siltpokeRoot()).find((s) => s.family === "codex");
  // The record is per agent, not per install: an older ~/.codex/hooks.json
  // source install writes the same file, so green here does not prove the
  // PLUGIN's hook runs (review of this change). The detail says so.
  if (seen) {
    return [
      {
        name: CODEX_RAN_ROW,
        pass: true,
        status: "pass",
        detail: `last at ${seen.seenAt} (any Siltpoke codex hook — plugin or an older ~/.codex/hooks.json install)`,
      },
    ];
  }
  return [
    {
      name: CODEX_RAN_ROW,
      pass: true,
      status: "warn",
      detail:
        "no codex hook has run on this machine yet, so no codex turn has been reviewed. " +
        "If you have started a codex session since installing, codex is not running Siltpoke's hooks: " +
        "type /hooks in codex, trust Siltpoke's, then start a new session.",
    },
  ];
}
