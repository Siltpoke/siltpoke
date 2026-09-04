// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile, } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { siltpokeRoot } from "../../installer/paths";

export interface BiasAuditDelta {
  sampleSize: number;
  severityDisagreementPct: number;
  categoryDisagreementPct: number;
  alert: boolean;
}

interface AuditEntry {
  ts: string;
  haiku: { severity: string; confidence: string; category: string };
  ollama: { severity: string; confidence: string; category: string };
}

/**
 * Build the list of ISO date strings for the last 7 days (today inclusive).
 * The "current day" is determined by `now` (injectable for tests).
 */
function last7DayStrings(now: Date): string[] {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Parse a JSONL file, silently skipping malformed lines.
 */
async function parseJsonl(path: string): Promise<AuditEntry[]> {
  try {
    const raw = await readFile(path, "utf8");
    const entries: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as AuditEntry);
      } catch {
        // skip malformed line
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Compute 7-day bias audit delta from ~/.siltpoke/bias-audit/*.jsonl.
 *
 * @param opts.auditDir  Override audit directory (defaults to ~/.siltpoke/bias-audit)
 * @param opts.alertThreshold  Disagreement fraction above which alert=true (default 0.15)
 * @param opts.now  Injectable clock for testing
 */
export async function computeBiasAuditDelta(opts: {
  auditDir?: string;
  alertThreshold?: number;
  now?: Date;
} = {}): Promise<BiasAuditDelta> {
  const threshold = opts.alertThreshold ?? 0.15;
  const now = opts.now ?? new Date();
  const auditDir = opts.auditDir ?? join(siltpokeRoot(), "bias-audit");

  if (!existsSync(auditDir)) {
    return { sampleSize: 0, severityDisagreementPct: 0, categoryDisagreementPct: 0, alert: false };
  }

  // Only read files for the last 7 days
  const days = last7DayStrings(now);
  const allEntries: AuditEntry[] = [];

  for (const day of days) {
    const filePath = join(auditDir, `${day}.jsonl`);
    const entries = await parseJsonl(filePath);
    allEntries.push(...entries);
  }

  const total = allEntries.length;
  if (total === 0) {
    return { sampleSize: 0, severityDisagreementPct: 0, categoryDisagreementPct: 0, alert: false };
  }

  let severityMismatch = 0;
  let categoryMismatch = 0;
  for (const entry of allEntries) {
    if (entry.haiku.severity !== entry.ollama.severity) severityMismatch++;
    if (entry.haiku.category !== entry.ollama.category) categoryMismatch++;
  }

  const severityDisagreementPct = (severityMismatch / total) * 100;
  const categoryDisagreementPct = (categoryMismatch / total) * 100;
  const thresholdPct = threshold * 100;
  const alert = severityDisagreementPct > thresholdPct || categoryDisagreementPct > thresholdPct;

  return { sampleSize: total, severityDisagreementPct, categoryDisagreementPct, alert };
}
