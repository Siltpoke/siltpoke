// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * What to say when there is no review to show.
 *
 * WHY THIS EXISTS — audit defect `[5c]`. One string served two different
 * facts. A brand-new user's very first `/siltpoke-last` answered
 *
 *   # Siltpoke: review 'latest' not found.
 *
 * which reads like a failure — a missing file, a broken install — when the
 * truth is that nothing has been reviewed yet, which is the expected state on
 * a fresh install. The same string also answered a genuinely mistyped id, so
 * neither case could say anything useful about itself.
 *
 * Shared by `get-critique.ts` and `mark-forwarded.ts`: both produced the old
 * string, and fixing one instance does not immunise the family.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * True when this project has no reviews at all — not one stored, ever.
 *
 * Deliberately broader than "the requested one is missing": a wrong id typed
 * into an empty store is still best answered with "there is nothing here yet",
 * because that is the fact that explains the silence.
 *
 * ERROR HANDLING IS PER-DIRECTORY, ON PURPOSE. A single `try` around the whole
 * walk meant that one unreadable date directory — a permissions problem, a
 * concurrent rotation, anything not a directory sitting where one is expected —
 * aborted the scan and returned `true`, i.e. announced "you have no reviews" to
 * someone who does. Reproduced: with two date dirs where the FIRST one
 * `readdir` returns is unreadable and the second holds a real critique, the old
 * shape answered `true` and the real review was hidden. (`readdir` order is not
 * sorted, so which directory is hit first is not something a caller controls.)
 *
 * Skipping a bad directory can only ever make this function MORE likely to say
 * "empty" than the truth for that directory — so a directory we could not read
 * is never counted as evidence either way, and "empty" is concluded only after
 * every reachable directory came back clean.
 */
export async function hasNoCritiquesAtAll(basePath: string): Promise<boolean> {
  const critiqueRoot = join(basePath, "critiques");
  if (existsSync(join(critiqueRoot, "latest.md"))) return false;
  const archiveRoot = join(critiqueRoot, "archive");
  if (!existsSync(archiveRoot)) return true;
  let dates: string[];
  try {
    dates = await readdir(archiveRoot);
  } catch {
    return true;
  }
  for (const date of dates) {
    try {
      const files = await readdir(join(archiveRoot, date));
      if (files.some((f) => f.endsWith(".md"))) return false;
    } catch {
      // Unreadable — skip it and keep looking, rather than concluding "empty"
      // from a directory we never actually read. (The `continue` that used to
      // say this was the loop's last statement, so biome removed it; the
      // reason it existed is the part worth keeping.)
    }
  }
  return true;
}

/** The fresh-install answer: an expected state, said as one. */
export const NO_CRITIQUES_YET =
  "# Siltpoke: no reviews yet.\n\n" +
  "Siltpoke writes one after a turn in which code actually changed, so there is " +
  "nothing here until you have changed some code and let the turn finish. " +
  "Nothing is wrong.\n";

/** The mistyped-id answer, when the store is NOT empty. */
export function critiqueNotFound(idOrLatest: string): string {
  return (
    `# Siltpoke: no review with id '${idOrLatest}'.\n\n` +
    "This project does have reviews — that id just is not one of them. " +
    "Run `/siltpoke-last` with no argument for the most recent one.\n"
  );
}

/**
 * The third state: reviews exist in the archive, but the `latest.md` pointer is
 * gone.
 *
 * Reachable without anything exotic — `src/state/critique.ts:406` treats the
 * copy to `latest.md` as NON-FATAL on purpose, so a disk or permission hiccup
 * leaves the archive written and the pointer missing. `/siltpoke-last` always
 * shells out with no argument, so `idOrLatest` is the sentinel `"latest"`,
 * which the user never typed.
 *
 * Telling them "that id is not one of them, re-run with no argument" would be a
 * loop: re-running produces the identical call and the identical message. So
 * this state gets its own answer, naming the real repair.
 */
export function latestPointerMissing(): string {
  return (
    "# Siltpoke: reviews exist, but the `latest` pointer is missing.\n\n" +
    "Your reviews are still on disk under `.siltpoke/critiques/archive/`; only " +
    "the shortcut to the newest one is gone (writing it is allowed to fail " +
    "without losing the review). Ask for one by id — `/siltpoke-last <id>` — " +
    "or let the next review run, which rewrites the pointer.\n"
  );
}

/** The whole decision, so both callers make it identically. */
export async function absentCritiqueMessage(
  basePath: string,
  idOrLatest: string,
): Promise<string> {
  if (await hasNoCritiquesAtAll(basePath)) return NO_CRITIQUES_YET;
  // Only `latest` can reach this: a real id the user typed is genuinely absent,
  // and that is what `critiqueNotFound` is for.
  if (idOrLatest === "latest") return latestPointerMissing();
  return critiqueNotFound(idOrLatest);
}
