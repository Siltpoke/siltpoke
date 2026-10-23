// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync } from "node:fs";

/**
 * Read a host's config file that the installer is about to rewrite.
 *
 * Absent → `{}` (a fresh install creates it). A JSON object → that object.
 * Anything else — a file that does not parse (a comment, a trailing comma) or
 * JSON that is not an object — THROWS, and nothing is written.
 *
 * WHY — defect [85]: this used to return `{}` for an unreadable file too, and
 * the caller then wrote Siltpoke's hooks over it: the user's own settings were
 * gone. Claude Code's side already refused (`preflight.ts`); this is the same
 * rule for codebuddy, qoder, agy and codex. Each host is wired on its own
 * (`wireSecondaryHosts`), so one refused host does not stop the others.
 */
export function readJsonObjectForRewrite(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}) — left it untouched. Fix it (or move it aside), then set up again.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is valid JSON but not an object — left it untouched. Fix it (or move it aside), then set up again.`);
  }
  return parsed as Record<string, unknown>;
}
