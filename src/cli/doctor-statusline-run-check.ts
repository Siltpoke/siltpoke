// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Doctor row: does the statusline actually render — including from a shell that
 * has nothing but the system PATH?
 *
 * Defect [23]: `✓ statusline interpreter runnable` passed while the statusline
 * did not work at all. That row only asks whether the interpreter named in
 * `statusLine.command` resolves; it never asks whether the shim, once started,
 * can find bun. On a machine where bun's PATH line lives only in
 * ~/.bash_profile (defect [21]) the interpreter resolves, the shim starts, and
 * it exits without printing a thing.
 *
 * So this row RUNS the shim, twice, and the second run is the point:
 *
 *   1. with the environment doctor itself has — an interactive shell, usually
 *      with bun on PATH. This is the arm that matches what the user sees when
 *      they try it by hand.
 *   2. with PATH reduced to the system directories — a stand-in for the
 *      non-login shell the host gives its statusline and hooks, which is the
 *      environment the bug actually lives in.
 *
 * Both render ⇒ ✓. Only the first ⇒ ⚠, and the advice is the fix that makes it
 * survive: re-run setup so the absolute bun path is recorded. Neither ⇒ ✗.
 *
 * Windows runs the first arm only (install audit §110 W3, Windows Run 4,
 * 2026-10-14). There is no login/non-login split there — the host's statusline
 * and hooks inherit the user's PATH (the same reasoning as
 * doctor-hook-start-check.ts) — so a "system PATH only" run stands in for no
 * real environment. On the Windows box it warned "reviews may never fire" while
 * reviews fired and the statusline rendered.
 *
 * The two-arm shape is deliberate. A single sanitized-PATH run would be
 * stricter than reality (the host inherits whatever environment it was launched
 * from, which CAN include bun) and would hand a red row to installs that work
 * — trading a false green for a false red. Two arms say which world we are in.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { bunPathPointerPath, resolveBunPath } from "../installer/bun-path";
import { statuslineShimPath } from "../installer/shim";
import { buildStatuslineCommand } from "../installer/statusline-interpreter";
import type { CheckResult, DoctorOptions } from "./doctor";
import { detectDoctorHost } from "./doctor";
import { aHost } from "./doctor-agy-plugin-host";

const CHECK_NAME = "statusline renders (real run)";

/**
 * A PATH with the system directories and nothing else, so the shim runs for
 * real and only bun is in question.
 *
 * Platform-dependent because the whole point of this arm is to imitate the
 * non-login shell the HOST hands the statusline, and that shell's idea of "the
 * system directories" is not the same on Windows — different directories, and
 * `;` rather than `:` between them. The Unix string used to be a module
 * constant (defect `[29]`, audit §36.5).
 */
function systemPath(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (platform !== "win32") return "/usr/bin:/bin:/usr/sbin:/sbin";
  // Git Bash reads a Windows-shaped PATH here; `SystemRoot` is set on every
  // Windows install, and the literal is the documented default when it is not.
  const root = env.SystemRoot ?? "C:\\Windows";
  return `${root}\\system32;${root}`;
}

export interface StatuslineRunDeps {
  /** Spawn seam. Returns the shim's stdout. Tests stub this. */
  runShim?: (shim: string, path: string, home: string) => string;
  /** Defaults to `process.platform`. Injected in tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. Injected in tests. */
  env?: Record<string, string | undefined>;
  /** Forwarded to the interpreter resolver. Defaults to `Bun.which`. */
  which?: (bin: string) => string | null;
  /** Forwarded to the interpreter resolver. Defaults to `existsSync`. */
  exists?: (path: string) => boolean;
}

/**
 * Which interpreter to run the shim with on this platform.
 *
 * Its own function, and exported, because defect `[29]` was a hardcoded
 * `/bin/sh` here and "we no longer hardcode it" is only checkable if the
 * choice can be observed without spawning anything. It delegates to the same
 * resolver the installer used to WRITE `statusLine.command`, so this row asks
 * about the shell the user's statusline is actually launched with.
 */
export function statuslineRunInterpreter(
  shim: string,
  deps: StatuslineRunDeps = {},
): string {
  return buildStatuslineCommand(shim, {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    ...(deps.which ? { which: deps.which } : {}),
    ...(deps.exists ? { exists: deps.exists } : {}),
  }).interpreter;
}

/**
 * Run the shim through the interpreter THIS platform's statusline actually
 * uses.
 *
 * Defect `[29]`: this hardcoded `/bin/sh`, which does not exist on Windows, so
 * `Bun.spawnSync` threw `ENOENT … uv_spawn '/bin/sh'`. Two separate faults
 * followed from that one line — the row could never be right on Windows, and
 * (before `runAllChecks` was guarded) the throw took the entire checklist with
 * it. The interpreter now comes from the same resolver the installer used to
 * write `statusLine.command`, so this row asks about the shell the user's
 * statusline is really launched with.
 *
 * A spawn that cannot start is reported as "rendered nothing" plus the reason,
 * never as a throw: this function is called from a health check, and a health
 * check that dies is the defect.
 */
function makeRunShim(deps: StatuslineRunDeps): (shim: string, path: string, home: string) => string {
  return (shim, path, home) => {
    const interpreter = statuslineRunInterpreter(shim, deps);
    try {
      const r = Bun.spawnSync([interpreter, shim], {
        env: { HOME: home, PATH: path },
        stdin: new TextEncoder().encode("{}"),
      });
      return new TextDecoder().decode(r.stdout);
    } catch (err) {
      return `${SPAWN_FAILED} ${interpreter}: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

/** Marker for "the interpreter itself would not start" — not shim output. */
const SPAWN_FAILED = "[siltpoke] could not start";

/** Did the shim render a pet, as opposed to printing its own failure line? */
function rendered(out: string): boolean {
  if (out.trim().length === 0) return false;
  // The shim's own bun-missing line is output, but it is not a pet. Neither
  // is our own "the interpreter would not start" line.
  return !out.includes("can't find bun") && !out.startsWith(SPAWN_FAILED);
}

export function checkStatuslineRenders(
  opts: DoctorOptions = {},
  deps: StatuslineRunDeps = {},
): CheckResult {
  const host = detectDoctorHost(opts);
  if (host !== "claude-code") {
    return {
      name: CHECK_NAME,
      pass: true,
      status: "info",
      detail: `skipped — ${aHost(host)} install has no Claude Code statusline`,
    };
  }

  const home = opts.home ?? homedir();
  const shim = statuslineShimPath(home);
  if (!existsSync(shim)) {
    return {
      name: CHECK_NAME,
      pass: true,
      status: "info",
      detail: "no statusline shim on disk — the pet's statusline is opt-in",
    };
  }

  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const clean = systemPath(platform, env);
  const run = deps.runShim ?? makeRunShim(deps);
  const inherited = rendered(run(shim, env.PATH ?? clean, home));
  if (platform === "win32") {
    return inherited ? { name: CHECK_NAME, pass: true, detail: null } : notRendering(home, shim, false, "", true);
  }
  const systemOut = run(shim, clean, home);

  if (inherited && rendered(systemOut)) return { name: CHECK_NAME, pass: true, detail: null };
  return notRendering(home, shim, inherited, systemOut);
}

/**
 * The warn / fail rows, and the one sentence that tells them apart.
 *
 * Name the mechanism, not just the symptom: the same red means different
 * things depending on whether a PATH-independent route to bun exists at all.
 * That asks the production resolver with PATH switched off, which is exactly
 * what the hook's shell sees.
 */
function notRendering(home: string, shim: string, inherited: boolean, systemOut = "", oneRun = false): CheckResult {
  const withoutPath = resolveBunPath(home, { pathLookup: () => null });
  const route =
    withoutPath === null
      ? `no PATH-independent route to bun (nothing at ${bunPathPointerPath(home)}, nothing at ~/.bun/bin/bun)`
      : `bun reachable without PATH at ${withoutPath}`;

  // A shim that itself said it cannot find bun overrules the TS resolver (a CRLF pointer reads
  // differently in the two), so only then is bun ruled out.
  if (inherited && withoutPath !== null && !systemOut.includes("can't find bun")) {
    // bun IS reachable without PATH, so recording its path again changes
    // nothing — the advice used to say "re-run setup" here anyway (§110 W3).
    const said = systemOut.trim().split(/\r?\n/)[0] ?? "";
    return {
      name: CHECK_NAME,
      pass: true,
      status: "warn",
      detail:
        "renders from this shell, but NOT from a shell carrying only the system PATH, " +
        `and bun is not the reason: ${route}. ` +
        (said ? `With the system PATH alone it printed: "${said}".` : "With the system PATH alone it printed nothing.") +
        " Reviews use the Stop hook, not this shim, so this row alone does not mean they are silent.",
    };
  }

  if (inherited) {
    return {
      name: CHECK_NAME,
      pass: true,
      status: "warn",
      detail:
        "renders from this shell, but NOT from a shell carrying only the system PATH — " +
        "and that is the shell the host runs the statusline and the Stop hook in, so " +
        `reviews may never fire. ${route}. ` +
        "Re-run `/siltpoke:siltpoke-setup` to record bun's absolute path.",
    };
  }

  return {
    name: CHECK_NAME,
    pass: false,
    detail:
      (oneRun
        ? `${shim} produced no pet with this shell's PATH. `
        : `${shim} produced no pet on either run (this shell's PATH, and the system PATH alone). `) +
      `${route}. \`/siltpoke:siltpoke-setup\` records bun's absolute path, or install bun so ` +
      "that ~/.bun/bin/bun exists.",
  };
}
