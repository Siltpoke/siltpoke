// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { FAMILIES, type ProviderFamily } from "../brain/brain-config";
import { atomicWrite } from "../utils/atomic-write";
import { siltpokeRoot } from "./paths";

/**
 * `<siltpoke home>/last-host` — which coding agent the user worked in last
 * (defect `[49]`, spec an internal design note §2).
 *
 * The dashboard daemon is a separate process and never sees `SILTPOKE_HOST`,
 * which lives for one hook run. The hooks know the host at session start and at
 * the end of each turn; this is where they write it down.
 *
 * Two lines: the family, then the absolute path of that family's command as the
 * writing process resolves it (or an empty line). Same pointer-file pattern as
 * `plugin-root` and `bun-path`.
 *
 * Two writers produce these lines: `hooks/lib/record-host.sh` (the Unix hook
 * wrappers) and `recordLastHost` here (the Windows hook guard, the source
 * installer). `tests/hooks/last-host-record.test.ts` pins the shell side and
 * `tests/installer/last-host.test.ts` this one.
 */

/**
 * The command each family is launched by. `satisfies` makes a new family a
 * compile error here; the test checks it against the provider registry, which
 * this module cannot import (the registry pulls in every provider, and this
 * file is bundled into the small Windows hook guard).
 */
export const HOST_BINARY = {
  claude: "claude",
  codex: "codex",
  agy: "agy",
  qoder: "qodercli",
  codebuddy: "codebuddy",
} as const satisfies Record<ProviderFamily, string>;

function lastHostPath(env: NodeJS.ProcessEnv): string {
  return join(siltpokeRoot(env), "last-host");
}

interface LastHost {
  family: ProviderFamily;
  /** Absolute path of the family's command as the recording session saw it. */
  commandPath: string | null;
}

/**
 * Read the record from a siltpoke home directory, or null when there is none
 * this reader can trust.
 *
 * Strict on purpose. Line 1 must be exactly one of the five families: a damaged
 * record is treated as no record (the caller then looks at what is installed),
 * never repaired into a guess. Line 2 is kept only when it is an absolute path —
 * the caller puts its folder on a child's PATH, and a relative one would mean
 * "relative to wherever the daemon happens to be".
 */
export function readLastHost(homeDir: string): LastHost | null {
  try {
    const lines = readFileSync(join(homeDir, "last-host"), "utf8").split("\n");
    const family = (lines[0] ?? "").replace(/\r$/, "");
    if (!isFamily(family)) return null;
    const second = (lines[1] ?? "").replace(/\r$/, "");
    return { family, commandPath: isAbsolute(second) ? second : null };
  } catch {
    return null;
  }
}

/**
 * When the record was last written (the file's mtime), or null when there is no
 * usable record. A reader that shows the record to a person needs this: the
 * record never expires, so without a time an old one reads as current.
 */
export function lastHostSeenAt(homeDir: string): Date | null {
  if (readLastHost(homeDir) === null) return null;
  try {
    return statSync(join(homeDir, "last-host")).mtime;
  } catch {
    return null;
  }
}

function isFamily(value: string): value is ProviderFamily {
  return (FAMILIES as readonly string[]).includes(value);
}

function defaultWhich(bin: string): string | null {
  return typeof Bun !== "undefined" ? Bun.which(bin) : null;
}

/**
 * Record `family` as the agent in use. Returns whether a record was written.
 *
 * An unknown or empty family writes nothing and leaves any existing record
 * alone — never `claude` as a guess, because a wrong name sends chat to an
 * agent the user may not have. The caller must not call this from a session
 * siltpoke itself spawned (`isSiltpokeInternal`).
 *
 * Every failure is swallowed: this runs inside hook guards, where a thrown
 * error or a printed line lands in the user's session.
 */
export function recordLastHost(
  env: NodeJS.ProcessEnv,
  family: string,
  which: (bin: string) => string | null = defaultWhich,
): boolean {
  if (!isFamily(family)) return false;
  markSeen(env, family);
  return writeLastHost(env, family, which);
}

function writeLastHost(
  env: NodeJS.ProcessEnv,
  family: ProviderFamily,
  which: (bin: string) => string | null,
): boolean {
  try {
    let commandPath = "";
    try {
      commandPath = which(HOST_BINARY[family]) ?? "";
    } catch {
      // A failed lookup costs the path, not the record.
    }
    atomicWrite(lastHostPath(env), `${family}\n${commandPath}\n`);
    return true;
  } catch {
    return false;
  }
}

const SEEN_DIR = "hosts-seen";

/**
 * The first time hosts-seen/ is made: give the family in last-host a file, at
 * last-host's time. Only if it has none. Two agents starting at once can both
 * find the folder missing; the later one used to seed after the earlier one
 * had already touched that family as seen NOW, and put it back to last-host's
 * old time (small item [10] of the chat mainline). A seed is always older than
 * a real touch, so an existing file is never the seed's to change.
 */
function seedSeen(homeDir: string, dir: string): void {
  const prev = readLastHost(homeDir);
  if (prev === null) return;
  const file = join(dir, prev.family);
  const at = statSync(join(homeDir, "last-host")).mtime;
  try {
    // "wx": create, or fail if another writer got there first — no gap between check and write.
    writeFileSync(file, "", { flag: "wx" });
  } catch {
    return;
  }
  utimesSync(file, at, at);
}

/**
 * Touch `<home>/hosts-seen/<family>` — every agent seen, not only the last one
 * (spec §12.4). Mirrors `hooks/lib/record-host.sh`: the first time the folder
 * is made, the family already in `last-host` gets a file too, at last-host's
 * own time; this runs BEFORE last-host is overwritten. Silent on any failure.
 */
function markSeen(env: NodeJS.ProcessEnv, family: ProviderFamily): void {
  try {
    const homeDir = siltpokeRoot(env);
    const dir = join(homeDir, SEEN_DIR);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      seedSeen(homeDir, dir);
    }
    const file = join(dir, family);
    const now = new Date();
    if (existsSync(file)) utimesSync(file, now, now);
    else writeFileSync(file, "");
  } catch {
    // Costs the "seen" line on the Settings page, never the hook.
  }
}

/**
 * Every agent siltpoke has seen a session of, newest first, with when (spec
 * §12.4). Names under `hosts-seen/` that are not one of the five are ignored.
 * With no folder yet — nothing has run since this record was added — the one
 * family in `last-host` is all there is, at last-host's time.
 */
export function hostsSeen(homeDir: string): { family: ProviderFamily; seenAt: string }[] {
  const dir = join(homeDir, SEEN_DIR);
  if (!existsSync(dir)) {
    const last = readLastHost(homeDir);
    const at = lastHostSeenAt(homeDir);
    return last !== null && at !== null ? [{ family: last.family, seenAt: at.toISOString() }] : [];
  }
  const out: { family: ProviderFamily; seenAt: string; ms: number }[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!isFamily(name)) continue;
      try {
        const mtime = statSync(join(dir, name)).mtime;
        out.push({ family: name, seenAt: mtime.toISOString(), ms: mtime.getTime() });
      } catch {
        // Removed between the listing and the stat.
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.ms - a.ms).map(({ family, seenAt }) => ({ family, seenAt }));
}

/**
 * The source installer's agent ids (`AgentTarget`, src/installer/agent-types.ts)
 * as families. Keyed by plain string on purpose: an id this table does not hold
 * maps to nothing and records nothing.
 */
const AGENT_TARGET_FAMILY: Record<string, ProviderFamily> = {
  "claude-code": "claude",
  codex: "codex",
  codebuddy: "codebuddy",
  qodercli: "qoder",
  antigravity: "agy",
};

/**
 * Record the host at source-install time (`bun run setup --agent <one>`).
 *
 * A source install registers hooks that carry no host variable, so no hook will
 * ever write this record for it; the install is the only moment that knows.
 * Two limits, both deliberate:
 *   - only when EXACTLY ONE agent was wired. With two the installer would be
 *     choosing for the user; chat then asks instead (spec §3.1, step 3).
 *   - never over an existing record. That one came from a real session, and an
 *     install is weaker evidence of what the user works in than a turn is.
 */
export function recordInstallHost(
  env: NodeJS.ProcessEnv,
  wiredAgents: readonly string[],
  which: (bin: string) => string | null = defaultWhich,
): boolean {
  try {
    if (wiredAgents.length !== 1) return false;
    const family = AGENT_TARGET_FAMILY[wiredAgents[0] as string];
    if (family === undefined) return false;
    if (existsSync(lastHostPath(env))) return false;
    // last-host only: an install is not a session, so it is not "seen" (§12.4).
    return writeLastHost(env, family, which);
  } catch {
    return false;
  }
}
