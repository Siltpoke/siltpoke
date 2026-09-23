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
 * The two-arm shape is deliberate. A single sanitized-PATH run would be
 * stricter than reality (the host inherits whatever environment it was launched
 * from, which CAN include bun) and would hand a red row to installs that work
 * — trading a false green for a false red. Two arms say which world we are in.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { bunPathPointerPath, resolveBunPath } from "../installer/bun-path";
import { statuslineShimPath } from "../installer/shim";
import type { CheckResult, DoctorOptions } from "./doctor";
import { detectDoctorHost } from "./doctor";

const CHECK_NAME = "statusline renders (real run)";

/**
 * A PATH with the system directories and nothing else. `cat` and `sh` resolve
 * here, so the shim runs for real — only bun is in question.
 */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface StatuslineRunDeps {
  /** Spawn seam. Returns the shim's stdout. Tests stub this. */
  runShim?: (shim: string, path: string, home: string) => string;
}

function defaultRunShim(shim: string, path: string, home: string): string {
  const r = Bun.spawnSync(["/bin/sh", shim], {
    env: { HOME: home, PATH: path },
    stdin: new TextEncoder().encode("{}"),
  });
  return new TextDecoder().decode(r.stdout);
}

/** Did the shim render a pet, as opposed to printing its own failure line? */
function rendered(out: string): boolean {
  if (out.trim().length === 0) return false;
  // The shim's own bun-missing line is output, but it is not a pet.
  return !out.includes("can't find bun");
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
      detail: `skipped — a ${host} install has no Claude Code statusline`,
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

  const run = deps.runShim ?? defaultRunShim;
  const inherited = rendered(run(shim, process.env.PATH ?? SYSTEM_PATH, home));
  const systemOnly = rendered(run(shim, SYSTEM_PATH, home));

  if (inherited && systemOnly) return { name: CHECK_NAME, pass: true, detail: null };

  // Name the mechanism, not just the symptom: the same red means different
  // things depending on whether a PATH-independent route to bun exists at all.
  // This asks the production resolver with PATH switched off, which is exactly
  // what the hook's shell sees.
  const withoutPath = resolveBunPath(home, { pathLookup: () => null });
  const route =
    withoutPath === null
      ? `no PATH-independent route to bun (nothing at ${bunPathPointerPath(home)}, nothing at ~/.bun/bin/bun)`
      : `bun reachable without PATH at ${withoutPath}`;

  if (inherited) {
    return {
      name: CHECK_NAME,
      pass: true,
      status: "warn",
      detail:
        "renders from this shell, but NOT from a shell carrying only the system PATH — " +
        "and that is the shell the host runs the statusline and the Stop hook in, so " +
        `reviews may never fire. ${route}. ` +
        "Re-run `/siltpoke-setup` to record bun's absolute path.",
    };
  }

  return {
    name: CHECK_NAME,
    pass: false,
    detail:
      `${shim} produced no pet on either run (this shell's PATH, and the system PATH alone). ` +
      `${route}. \`/siltpoke-setup\` records bun's absolute path, or install bun so ` +
      "that ~/.bun/bin/bun exists.",
  };
}
