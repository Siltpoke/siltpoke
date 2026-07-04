// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * v2-sidecar — load and parse the .md sidecar for a critique.
 *
 * Critique .md files live at:
 *   {basePath}/critiques/archive/{day}/{critique_id}.md
 *
 * v2 sidecars (schemaVersion: 2) contain extra fields written by the
 * v2 pipeline: intent_classification, intent_confidence, category,
 * user_raw_query, agent_restatement, agent_restatement_source, evidence
 * (rubric triggers), signal_sources, changed_files.
 *
 * v1 critiques will be found on disk but will lack those fields — this
 * module returns null for any missing field, never throws.
 *
 * Lookup strategy: critiques are matched by `session_id` (not by
 * critique_id) because the brain-calls.jsonl entry has session_id+timestamp
 * but does not carry the critique_id. We scan the archive newest-day-first
 * and return the first matching file.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface V2RubricTrigger {
  rule_id: string;
  tier: 1 | 2 | 3;
  severity?: string;
  file: string;
  line: number;
  snippet?: string;
  message?: string;
  signal_source?: string;
}

export interface V2SidecarData {
  // Core v1 fields
  schemaVersion: number | null;
  critique_id: string | null;
  ts: string | null;
  severity: string | null;
  confidence: string | null;
  category: string | null;
  status: string | null;
  reasoning: string | null;
  critique_for_claude: string | null;
  suggested_fix: string | null;
  bubble_short: string | null;
  bubble_long: string | null;
  mood: string | null;
  pose: string | null;

  // v2 fields (null when not present / v1 critique)
  intent_classification: string | null;
  intent_confidence: number | null;
  user_raw_query: string | null;
  /**
   * Verbatim first paragraph of the agent's first reply AFTER the last
   * user turn. Surface text only — no alignment judgement. null when no
   * text reply was captured.
   */
  agent_reply: string | null;
  signal_sources: string[];

  /** Rubric triggers from the evidence: block in frontmatter. */
  rubric_triggers: V2RubricTrigger[];

  /** Changed files from the changed_files: block in frontmatter (if written). */
  changed_files: string[];

  /** diff_intent from frontmatter (if written). */
  diff_intent: string | null;
}

// ---------------------------------------------------------------------------
// Frontmatter parser — hand-rolled; no external deps.
// The format is tightly controlled by writeCritique() + the v2 writer.
// ---------------------------------------------------------------------------

interface ParseResult {
  fm: Record<string, string>;
  evidenceLines: string[];
  changedFilesLines: string[];
}

/**
 * Parse YAML-ish frontmatter block.
 * Handles flat `key: value` pairs, flow-style arrays `[a, b]`, two block
 * arrays we care about (`evidence:` and `changed_files:`), and YAML
 * literal block scalars (`key: |` plus indented payload).
 */
function parseFrontmatter(raw: string): ParseResult {
  const lines = raw.split("\n");
  const fm: Record<string, string> = {};
  const evidenceLines: string[] = [];
  const changedFilesLines: string[] = [];

  if (lines[0]?.trim() !== "---") {
    return { fm, evidenceLines, changedFilesLines };
  }

  let inEvidence = false;
  let inChangedFiles = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "---") break;  // end of frontmatter

    // Detect block array keys (possibly with empty inline value)
    if (/^evidence\s*:/.test(trimmed)) {
      inEvidence = true;
      inChangedFiles = false;
      continue;
    }
    if (/^changed_files\s*:/.test(trimmed)) {
      inChangedFiles = true;
      inEvidence = false;
      continue;
    }
    // Skip other known block-list keys
    if (/^xp_earned_events\s*:/.test(trimmed)) {
      inEvidence = false;
      inChangedFiles = false;
      continue;
    }

    // Collect block array lines (indented or dash-prefixed)
    if (inEvidence) {
      if (line.startsWith("  ") || trimmed.startsWith("-")) {
        evidenceLines.push(line);
        continue;
      }
      if (trimmed.length > 0 && !line.startsWith(" ")) {
        inEvidence = false;
        // Fall through to parse as key: value
      }
    }
    if (inChangedFiles) {
      if (line.startsWith("  ") || trimmed.startsWith("-")) {
        changedFilesLines.push(line);
        continue;
      }
      if (trimmed.length > 0 && !line.startsWith(" ")) {
        inChangedFiles = false;
        // Fall through to parse as key: value
      }
    }

    // Simple key: value (or block scalar header `key: |` / `key: |-` / `key: >`)
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const val = trimmed.slice(colonIdx + 1).trim();

      // YAML block scalar: collect subsequent indented lines as multi-line value.
      // Supports `|` (literal), `|-` (strip trailing nl), `|+` (keep), `>` (folded).
      // Frontmatter terminates at `---` or the first non-indented non-empty line.
      if (val === "|" || val === "|-" || val === "|+" || val === ">" || val === ">-" || val === ">+") {
        const folded = val.startsWith(">");
        const blockLines: string[] = [];
        let baseIndent = -1;
        while (i + 1 < lines.length) {
          const next = lines[i + 1] ?? "";
          const nextTrim = next.trim();
          if (nextTrim === "---") break;
          if (next === "") {
            // Empty line — preserved inside the block unless block already ended.
            blockLines.push("");
            i++;
            continue;
          }
          // Measure leading spaces.
          const leading = next.length - next.trimStart().length;
          if (leading === 0) break;
          if (baseIndent === -1) baseIndent = leading;
          if (leading < baseIndent) break;
          blockLines.push(next.slice(baseIndent));
          i++;
        }
        // Trim trailing empty lines (YAML clip behavior for `|` and `>`).
        while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
          blockLines.pop();
        }
        fm[key] = folded ? blockLines.join(" ") : blockLines.join("\n");
        continue;
      }

      fm[key] = val;
    }
  }

  return { fm, evidenceLines, changedFilesLines };
}

function parseFlowArray(val: string): string[] {
  const t = val.trim();
  if (t === "[]" || t === "") return [];
  const inner = t.replace(/^\[/, "").replace(/\]$/, "");
  return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseEvidenceBlock(lines: string[]): V2RubricTrigger[] {
  const triggers: V2RubricTrigger[] = [];
  let current: Partial<V2RubricTrigger> | null = null;

  const flush = (): void => {
    if (current?.rule_id && current?.file) {
      triggers.push({
        rule_id: current.rule_id,
        tier: (current.tier ?? 1) as 1 | 2 | 3,
        severity: current.severity,
        file: current.file,
        line: current.line ?? 0,
        snippet: current.snippet,
        message: current.message,
        signal_source: current.signal_source,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const t = line.trim();
    // New evidence item starts with `- rule_id:`
    if (/^-\s*rule_id\s*:/.test(t)) {
      flush();
      current = {};
      current.rule_id = unquote(t.replace(/^-\s*rule_id\s*:/, "").trim());
      continue;
    }
    if (!current) continue;
    if (/^rule_id\s*:/.test(t)) {
      current.rule_id = unquote(t.slice(t.indexOf(":") + 1).trim());
    } else if (/^tier\s*:/.test(t)) {
      const n = parseInt(t.slice(t.indexOf(":") + 1).trim(), 10);
      if (n === 1 || n === 2 || n === 3) current.tier = n;
    } else if (/^severity\s*:/.test(t)) {
      current.severity = unquote(t.slice(t.indexOf(":") + 1).trim());
    } else if (/^file\s*:/.test(t)) {
      current.file = unquote(t.slice(t.indexOf(":") + 1).trim());
    } else if (/^line\s*:/.test(t)) {
      const n = parseInt(t.slice(t.indexOf(":") + 1).trim(), 10);
      if (!Number.isNaN(n)) current.line = n;
    } else if (/^snippet\s*:/.test(t)) {
      current.snippet = unquote(t.slice(t.indexOf(":") + 1).trim());
    } else if (/^message\s*:/.test(t)) {
      current.message = unquote(t.slice(t.indexOf(":") + 1).trim());
    } else if (/^signal_source\s*:/.test(t)) {
      current.signal_source = unquote(t.slice(t.indexOf(":") + 1).trim());
    }
  }
  flush();
  return triggers;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function parseChangedFilesBlock(lines: string[]): string[] {
  return lines
    .map((l) => unquote(l.trim().replace(/^-\s*/, "").trim()))
    .filter((s) => s.length > 0);
}

function strOrNull(v: string | undefined): string | null {
  if (v === undefined || v.trim().length === 0) return null;
  return unquote(v.trim());
}

function numOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

function mapFmToSidecar(
  fm: Record<string, string>,
  evidenceLines: string[],
  changedFilesLines: string[],
): V2SidecarData {
  const schemaStr = fm.schemaVersion;
  const schemaVersion = schemaStr ? parseInt(schemaStr, 10) : null;

  return {
    schemaVersion,
    critique_id: strOrNull(fm.critique_id),
    ts: strOrNull(fm.ts) ?? strOrNull(fm.timestamp),
    severity: strOrNull(fm.severity),
    confidence: strOrNull(fm.confidence),
    category: strOrNull(fm.category),
    status: strOrNull(fm.status),
    reasoning: strOrNull(fm.reasoning),
    critique_for_claude: strOrNull(fm.critique_for_claude),
    suggested_fix: strOrNull(fm.suggested_fix),
    bubble_short: strOrNull(fm.bubble_short),
    bubble_long: strOrNull(fm.bubble_long),
    mood: strOrNull(fm.mood),
    pose: strOrNull(fm.pose),
    intent_classification: strOrNull(fm.intent_classification),
    intent_confidence: numOrNull(fm.intent_confidence),
    user_raw_query: strOrNull(fm.user_raw_query),
    agent_reply: strOrNull(fm.agent_reply),
    signal_sources: fm.signal_sources ? parseFlowArray(fm.signal_sources) : [],
    rubric_triggers: parseEvidenceBlock(evidenceLines),
    changed_files: parseChangedFilesBlock(changedFilesLines),
    diff_intent: strOrNull(fm.diff_intent),
  };
}

// ---------------------------------------------------------------------------
// Archive scanning helpers
// ---------------------------------------------------------------------------

/**
 * Scan the archive for a critique file matching the given session_id.
 * Returns the absolute path of the first matching file, newest day first.
 */
async function findBySessionId(
  basePath: string,
  sessionId: string,
): Promise<string | null> {
  const archiveRoot = join(basePath, "critiques", "archive");
  if (!existsSync(archiveRoot)) return null;

  let dates: string[];
  try {
    dates = await readdir(archiveRoot);
  } catch {
    return null;
  }

  for (const date of dates.sort().reverse()) {
    const dateDir = join(archiveRoot, date);
    let files: string[];
    try {
      files = await readdir(dateDir);
    } catch {
      continue;
    }
    // Read each .md file and check its session_id frontmatter field
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = join(dateDir, file);
      try {
        const raw = await readFile(filePath, "utf8");
        const { fm } = parseFrontmatter(raw);
        if (fm.session_id === sessionId) return filePath;
      } catch {
        // skip unreadable
      }
    }
  }
  return null;
}

async function findByCritiqueId(
  basePath: string,
  critiqueId: string,
): Promise<string | null> {
  const archiveRoot = join(basePath, "critiques", "archive");
  if (!existsSync(archiveRoot)) return null;

  let dates: string[];
  try {
    dates = await readdir(archiveRoot);
  } catch {
    return null;
  }

  for (const date of dates.sort().reverse()) {
    // Prefer the v2 sidecar (written by writeV2Archive) — it has evidence + captured intent.
    const v2Candidate = join(archiveRoot, date, `${critiqueId}.v2.md`);
    if (existsSync(v2Candidate)) return v2Candidate;
    // Fall back to the plain critique .md (contains rubric evidence when written by demo-seed).
    const candidate = join(archiveRoot, date, `${critiqueId}.md`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function parseFile(filePath: string): Promise<V2SidecarData | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const { fm, evidenceLines, changedFilesLines } = parseFrontmatter(raw);
    return mapFmToSidecar(fm, evidenceLines, changedFilesLines);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and parse the v2 sidecar for a critique entry.
 *
 * Lookup priority:
 *   1. critiqueId  — scans archive for {critiqueId}.md
 *   2. sessionId   — scans archive for a file with matching session_id frontmatter
 *
 * Returns null when no matching file exists or parsing fails.
 * Never throws.
 *
 * @param critiqueId  Bare critique ID (e.g. "c-abc123"). May be null.
 * @param sessionId   Session ID from brain-calls.jsonl. May be null.
 * @param basePath    ~/.siltpoke root.
 */
export async function loadV2Sidecar(
  critiqueId: string | null | undefined,
  sessionId: string | null | undefined,
  basePath: string,
): Promise<V2SidecarData | null> {
  // Try critiqueId first (fast: O(days) stat calls)
  if (critiqueId) {
    const byId = await findByCritiqueId(basePath, critiqueId);
    if (byId) return parseFile(byId);
  }

  // Fall back to session_id scan (slower: reads frontmatter of each file)
  if (sessionId) {
    const bySession = await findBySessionId(basePath, sessionId);
    if (bySession) return parseFile(bySession);
  }

  return null;
}
