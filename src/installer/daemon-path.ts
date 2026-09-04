// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { daemonShimPath, resolvePluginRoot } from "./shim";

/**
 * Resolve a binary to its absolute path (or null when not on PATH).
 * Injectable so tests never touch the real `which`.
 */
export type WhichFn = (bin: string) => string | null;

export interface ResolveDaemonPathDeps {
  /** Defaults to a real `spawnSync("which", …)`. */
  which?: WhichFn;
  /** Real home dir. Defaults to os.homedir(). */
  home?: string;
}

export interface ResolveDaemonPathResult {
  /** `:`-joined, de-duped PATH string for the daemon's env. */
  path: string;
  /** Non-fatal advisories (e.g. `claude` not found) — caller logs them. */
  warnings: string[];
}

function defaultWhich(bin: string): string | null {
  try {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    const out = (r.stdout || "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Compute the PATH the autostarted daemon (launchd / systemd) needs so it can
 * spawn `bun` and `claude` by bare name — launchd/systemd otherwise hand the
 * daemon a bare PATH (`/usr/bin:/bin:…`) that omits `~/.local/bin` + `~/.bun/bin`.
 *
 * Order: the dirs where `bun` and `claude` ACTUALLY live (resolved at install
 * time) come FIRST so the user's real install wins, then a stable fallback set,
 * de-duped preserving first-seen order.
 *
 * Contingency (story): a failed `which claude` (or `which bun`) does NOT abort —
 * the fallback dirs still yield a usable PATH; the miss is surfaced as a warning.
 */
export function resolveDaemonPath(
  deps: ResolveDaemonPathDeps = {},
): ResolveDaemonPathResult {
  const which = deps.which ?? defaultWhich;
  const home = deps.home ?? homedir();
  const warnings: string[] = [];
  const dirs: string[] = [];

  // Resolved-binary dirs first (user's real install wins).
  for (const bin of ["bun", "claude"] as const) {
    const resolved = which(bin);
    if (resolved) {
      dirs.push(dirname(resolved));
    } else {
      warnings.push(
        `${bin} not found on PATH at install time; the daemon PATH relies on fallback dirs`,
      );
    }
  }

  // Fallbacks (with ~ / ${HOME} expanded to the real home).
  dirs.push(
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".bun", "bin"),
    "/usr/bin",
    "/bin",
  );

  const seen = new Set<string>();
  const deduped = dirs.filter((d) => {
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });

  return { path: deduped.join(":"), warnings };
}

/**
 * Where the daemon entry lives, given the directory the CALLER is running from.
 *
 * THE canonical implementation of a rule this codebase needs in six places and
 * enforces in none: a module that ships both as `src/` and inlined into `dist/`
 * cannot compute a path to another entry with `..` — from `dist/` that walks
 * out of the tree. Two sites shipped broken on exactly this (dashboard indexing,
 * #560; Stop-hook daemon respawn, #562), each a total silent failure because
 * the spawn discarded its child's stderr.
 *
 *   - BUNDLED: every build-dist output lands flat in `dist/`, so the daemon's
 *     own bundle is a SIBLING — a plain filename join, no `..` to get wrong.
 *     A plugin cache ships no `src/`, so the target can never be the .ts entry.
 *   - SOURCE: any `src/<dir>` caller reaches `src/cli/daemon.ts` by going up one
 *     and back into `cli/`.
 *
 * Callers pass their own `import.meta.dir`. Kept here rather than in any one
 * consumer so the installers, the Stop hook and the CLI share ONE implementation
 * — `tests/installer/daemon-entry-path.test.ts` asserts they cannot drift apart.
 */
export function resolveDaemonEntry(hereDir: string): string {
  if (basename(hereDir) === "dist") {
    return join(hereDir, "siltpoke-daemon.js");
  }
  return join(hereDir, "..", "cli", "daemon.ts");
}

/** What the autostart unit execs: `<program> <script> start`. */
export interface DaemonLauncher {
  /** The binary the unit runs — `bun`, or `/bin/sh` when going through the shim. */
  program: string;
  /** Its single argument: the daemon shim, or the repo's daemon entry. */
  script: string;
  /** True when the unit resolves the daemon through ~/.siltpoke/plugin-root. */
  viaShim: boolean;
}

/**
 * Pick the daemon entry the launchd plist / systemd unit should exec.
 *
 * A plugin install writes ~/.siltpoke/bin/daemon.sh (installer/shim.ts) — a
 * stable path that resolves the CURRENT plugin bundle at every start. Baking the
 * plugin's own path into the unit instead would strand the daemon at the next
 * `/plugin update`, because the cache dir is versioned.
 *
 * The gate is the POINTER resolving, not the shim FILE existing. The shim is
 * inert without ~/.siltpoke/plugin-root, which ONLY the plugin's SessionStart
 * hook writes — and the shim file outlives the thing that made it useful (a
 * plugin install, then an uninstall; or a `configure --daemon` run that wrote it
 * speculatively). Gating on the file alone would hand a repo-checkout user
 * (`bun run setup`, `siltpoked install-autostart`) a unit that can never resolve
 * a daemon: it idles, gets respawned on every keep-alive interval forever, and
 * reports "installed" while serving nothing.
 *
 * Pointer doesn't resolve ⇒ from-source (repo checkout) install, whose path
 * doesn't move: exec `bun <repo>/src/cli/daemon.ts` exactly as before.
 */
export function resolveDaemonLauncher(
  bunPath: string,
  repoScript: string,
  home: string = homedir(),
): DaemonLauncher {
  const shim = daemonShimPath(home);
  if (existsSync(shim) && resolvePluginRoot(home) !== null) {
    return { program: "/bin/sh", script: shim, viaShim: true };
  }
  return { program: bunPath, script: repoScript, viaShim: false };
}
