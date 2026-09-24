// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The SessionStart half of the update check: read the cache, maybe say a
// sentence, and kick a refresh that the session does not wait for.
//
// The split from `check.ts` is the testable/untestable line. Everything there
// is pure. Everything here touches a clock, a disk or a socket, and takes all
// three as injected dependencies so the wiring — not just the helpers — can be
// asserted. A previous lesson in this repo: the delivery half is the half that
// ships with no assertions, and reverting it leaves the suite green.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadUpdateCheckConfigSync } from "../config/update-check-config";
import { findInstalledVersion } from "../installer/installed-version";
import {
  cachePath,
  isStale,
  LATEST_RELEASE_URL,
  parseCache,
  readReleasePayload,
  updateNotice,
  type UpdateCache,
} from "./check";

interface UpdateNoticeDeps {
  home: string;
  /** Directory the version search starts from. Defaults to this module's dir. */
  startDir: string;
  /** The per-host command that performs the update. */
  updateCommand: string;
  nowMs?: () => number;
  readFileSyncFn?: (p: string, enc: "utf8") => string;
  writeFileSyncFn?: (p: string, data: string) => void;
  existsSyncFn?: (p: string) => boolean;
}

interface SessionUpdateState {
  /** The sentence to show, or null for "say nothing". */
  notice: string | null;
  /** True when the cached answer is missing or past its day. */
  needsRefresh: boolean;
}

/**
 * What this session should say about updates, and whether the cache is due.
 *
 * Reads only local state — **never** waits on the network, whatever the cache
 * says. Today's session prints whatever was already known, which on a first
 * install is nothing; a refresh triggered now lands in time for the NEXT one.
 * One quiet day is the price of never making a session wait on GitHub.
 *
 * The REFRESH IS NOT PERFORMED HERE. `needsRefresh` is returned so the caller —
 * the hook — is the thing that decides to fire and not await it. That decision
 * belongs at the boundary where "do not block the user" is a rule, not buried
 * in a helper where a later reader could quietly start awaiting it.
 *
 * Every failure resolves to `{ notice: null, needsRefresh: false }`. There is
 * no error path that prints, and none that schedules work.
 */
export function updateNoticeForSession(deps: UpdateNoticeDeps): SessionUpdateState {
  const now = deps.nowMs ?? Date.now;
  const readF = deps.readFileSyncFn ?? ((p: string, e: "utf8") => readFileSync(p, e));
  const exists = deps.existsSyncFn ?? existsSync;
  try {
    if (!loadUpdateCheckConfigSync(deps.home, readF).enabled) return SILENT;

    const path = cachePath(deps.home);
    const cache: UpdateCache | null = exists(path) ? parseCache(readF(path, "utf8")) : null;

    return {
      notice: updateNotice(findInstalledVersion(deps.startDir), cache, deps.updateCommand),
      needsRefresh: isStale(cache, now()),
    };
  } catch {
    return SILENT;
  }
}

const SILENT: SessionUpdateState = { notice: null, needsRefresh: false };

/**
 * Ask GitHub for the latest release and write the cache. Resolves rather than
 * rejects on every failure, and writes a cache entry even then: a recorded
 * failure is what keeps an offline machine from retrying on every single
 * session start.
 */
export async function refreshUpdateCache(
  home: string,
  deps: {
    fetchFn?: typeof fetch;
    nowMs?: () => number;
    writeFileSyncFn?: (p: string, data: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<UpdateCache> {
  const now = (deps.nowMs ?? Date.now)();
  const write = deps.writeFileSyncFn ?? ((p: string, d: string) => writeFileSync(p, d));
  let entry: UpdateCache = { checkedAtMs: now, latestVersion: null, headline: null };
  try {
    const f = deps.fetchFn ?? fetch;
    const res = await f(LATEST_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
    });
    if (res.ok) {
      const parsed = readReleasePayload(await res.json());
      if (parsed) entry = { checkedAtMs: now, ...parsed };
    }
  } catch {
    // Offline, DNS failure, timeout, rate limit, malformed body — all the same
    // outcome: record that we looked, say nothing, try again tomorrow.
  }
  try {
    const path = cachePath(home);
    mkdirSync(dirname(path), { recursive: true });
    write(path, `${JSON.stringify(entry)}\n`);
  } catch {
    // Unwritable home: the notice is simply never shown. Never nag, never throw.
  }
  return entry;
}
