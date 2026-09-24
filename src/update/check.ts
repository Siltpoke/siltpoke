// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// "Is there a newer siltpoke?" — the cache, the fetch, and the sentence.
//
// WHY this exists: updating is entirely manual today, so the only people who
// update are the ones who already suspected they should. 1.2.0 fixed a review
// hook that exited in silence on every turn while the pet, the config file and
// the statusline all reported a healthy install — a defect a user CANNOT find
// from inside the product. Shipping the fix does not reach them; telling them
// does.
//
// WHAT IT SENDS: one GET to GitHub for the latest release's tag. No user data,
// no code, no identifiers, no usage counts. siltpoke itself receives nothing —
// the request goes to GitHub, which sees it exactly as it would if the user
// opened the releases page. Off with `updateCheck: false` in config.json.
//
// WHAT IT MUST NEVER DO: block a session. Every failure mode here — offline,
// rate-limited, malformed JSON, unwritable home, unparseable version — resolves
// to "say nothing". A missed notice costs a user one day; a SessionStart that
// hangs on a network call costs them the tool.
import { join } from "node:path";
import { isNewerVersion } from "../installer/installed-version";

/** How long a cached answer is treated as fresh. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The releases endpoint. `latest` excludes pre-releases and drafts server-side. */
export const LATEST_RELEASE_URL = "https://api.github.com/repos/Siltpoke/siltpoke/releases/latest";

export interface UpdateCache {
  /** Epoch ms of the last COMPLETED check — success or definitive failure. */
  checkedAtMs: number;
  /** Tag of the newest release, without the leading `v`. Null when unknown. */
  latestVersion: string | null;
  /** First line(s) of the release body, already trimmed for display. */
  headline: string | null;
}

const CACHE_BASENAME = "update-check.json";

export function cachePath(home: string): string {
  return join(home, CACHE_BASENAME);
}

/**
 * Parse a cache file's contents. Anything unexpected reads as "no cache" rather
 * than throwing — a corrupt cache must degrade to a fresh check, never to a
 * broken session.
 */
export function parseCache(raw: string): UpdateCache | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.checkedAtMs !== "number" || !Number.isFinite(o.checkedAtMs)) return null;
    return {
      checkedAtMs: o.checkedAtMs,
      latestVersion: typeof o.latestVersion === "string" ? o.latestVersion : null,
      headline: typeof o.headline === "string" ? o.headline : null,
    };
  } catch {
    return null;
  }
}

export function isStale(cache: UpdateCache | null, nowMs: number): boolean {
  if (!cache) return true;
  // A clock that moved backwards (timezone fix, VM restore) would otherwise
  // freeze the cache as "fresh" forever.
  const age = nowMs - cache.checkedAtMs;
  return age < 0 || age >= CHECK_INTERVAL_MS;
}

/**
 * Turn a GitHub release payload into the two fields worth caching.
 * Returns null for any shape that does not carry a usable tag.
 */
export function readReleasePayload(payload: unknown): {
  latestVersion: string;
  headline: string | null;
} | null {
  if (typeof payload !== "object" || payload === null) return null;
  const o = payload as Record<string, unknown>;
  const tag = typeof o.tag_name === "string" ? o.tag_name.trim() : "";
  if (!tag) return null;
  const version = tag.replace(/^v/, "");
  if (!version) return null;
  return { latestVersion: version, headline: firstMeaningfulLines(o.body) };
}

/**
 * The release body's opening bullets, condensed to one short line.
 *
 * Deliberately not the whole body: these notes run to dozens of lines and this
 * is a single chat line, not a changelog viewer. The link carries the rest.
 */
function firstMeaningfulLines(body: unknown, maxChars = 160): string | null {
  if (typeof body !== "string") return null;
  const bullets: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("---")) continue;
    const bullet = line.replace(/^[-*]\s+/, "");
    // Strip the bold lead-in that every entry in this project's changelog uses,
    // so the line reads as prose rather than as markup in a terminal.
    const clean = bullet.replace(/\*\*/g, "").replace(/`/g, "");
    if (clean) bullets.push(clean);
    if (bullets.join(" · ").length >= maxChars) break;
  }
  if (bullets.length === 0) return null;
  const joined = bullets.join(" · ");
  return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * The sentence a user sees, or null for "say nothing".
 *
 * Null whenever anything is unknown: no installed version, no cached latest, an
 * unparseable version on either side, or nothing newer. "Say nothing" is the
 * default because the alternative — a wrong or noisy update banner on every
 * session — is worse than never mentioning it.
 */
export function updateNotice(
  installedVersion: string | null,
  cache: UpdateCache | null,
  updateCommand: string,
): string | null {
  if (!installedVersion || !cache?.latestVersion) return null;
  if (!isNewerVersion(cache.latestVersion, installedVersion)) return null;
  const head = cache.headline ? ` — ${cache.headline}` : "";
  return (
    `siltpoke ${cache.latestVersion} is out (you have ${installedVersion})${head}. ` +
    `Update with \`${updateCommand}\`, then restart.`
  );
}
