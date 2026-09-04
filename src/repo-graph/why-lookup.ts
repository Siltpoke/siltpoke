// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFileSync } from "node:fs";
import { changedLineRanges } from "./changed-lines";
import { blameLines } from "./git-blame";
import { readWhyIndex, type WhyIndex } from "./why-index";
import { extractTurnsFromEvents, type TranscriptEvent } from "../router/context";

export type AnchorScope = "uncommitted" | "turn" | "session" | "none";
export interface WhyAnchor { rung: "U" | 1 | 2 | 3; anchor_scope: AnchorScope; user_ask?: string; session_id?: string; transcript_path?: string; turn_index?: number }
export interface WhyLookupInput {
  cwd: string; file: string; startLine?: number; endLine?: number;
  /** Line-range refinement (spec §11): blame only the lines changed since
   *  this baseline instead of the whole file. Absent ⇒ whole-file fallback. */
  baselineSha?: string;
  blame?: typeof blameLines;
  changed?: typeof changedLineRanges;
  readIndex?: (cwd: string) => Promise<WhyIndex>;
  readTranscript?: (path: string) => string | null;
}

const RUNG_U: WhyAnchor = { rung: "U", anchor_scope: "uncommitted" };
const RUNG_3: WhyAnchor = { rung: 3, anchor_scope: "none" };
const session = (s: { session_id: string; transcript_path: string }): WhyAnchor =>
  ({ rung: 2, anchor_scope: "session", session_id: s.session_id, transcript_path: s.transcript_path });

function endsWithTarget(editedPath: string, target: string, cwd: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
  let e = norm(editedPath);
  const c = norm(cwd).replace(/\/$/, "");
  if (e.startsWith(c + "/")) e = e.slice(c.length + 1);        // strip cwd prefix ⇒ repo-relative
  return e === norm(target);                                    // exact repo-relative match (no bare-basename false positive)
}

export async function lookupWhy(input: WhyLookupInput): Promise<WhyAnchor> {
  try {
    // Line-range refinement: blame only the lines changed since the user's
    // baseline (spec §11) — bounds staleness to the changed region instead
    // of surfacing an unrelated older commit from elsewhere in the file.
    let blameResult: Awaited<ReturnType<typeof blameLines>> | null = null;
    if (input.baselineSha) {
      const ranges = await (input.changed ?? changedLineRanges)({ cwd: input.cwd, file: input.file, baselineSha: input.baselineSha });
      if (ranges.length > 0) {
        const per = await Promise.all(ranges.map((r) => (input.blame ?? blameLines)({ cwd: input.cwd, file: input.file, startLine: r.start, endLine: r.end })));
        if (per.some((b) => b.kind === "uncommitted")) return RUNG_U;
        const entries = per.flatMap((b) => (b.kind === "commits" ? b.entries : []));
        blameResult = entries.length > 0 ? { kind: "commits", entries } : { kind: "error", detail: "no committed lines in changed ranges" };
      }
    }
    const blame = blameResult ?? await (input.blame ?? blameLines)({ cwd: input.cwd, file: input.file, startLine: input.startLine, endLine: input.endLine });
    if (blame.kind === "uncommitted") return RUNG_U;
    if (blame.kind !== "commits" || blame.entries.length === 0) return RUNG_3;
    const idx = await (input.readIndex ?? readWhyIndex)(input.cwd);
    // newest→oldest; first indexed sha wins (unindexed tweak on top doesn't hide the real session commit)
    const ordered = [...blame.entries].sort((a, b) => Date.parse(b.committerDate) - Date.parse(a.committerDate));
    const hit = ordered.find((e) => idx[e.sha]?.sessions.length);
    if (!hit) return RUNG_3;
    const sessions = idx[hit.sha]!.sessions;
    if (sessions.length !== 1) return session(sessions[0]!);
    const s = sessions[0]!;
    if (s.host !== "claude-code") return session(s);                              // unsupported read host — do NOT open transcript
    const raw = (input.readTranscript ?? ((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } }))(s.transcript_path);
    if (raw === null) return session(s);
    const events = raw.split("\n").map((l) => { try { return JSON.parse(l) as TranscriptEvent; } catch { return null; } }).filter((e): e is TranscriptEvent => e !== null);
    const target = extractTurnsFromEvents(events).filter((t) => t.editedFiles.some((f) => endsWithTarget(f, input.file, input.cwd)));
    if (target.length !== 1) return session(s);
    const turn = target[0]!;
    return { rung: 1, anchor_scope: "turn", user_ask: turn.userAsk, session_id: s.session_id, transcript_path: s.transcript_path, turn_index: turn.index };
  } catch { return RUNG_3; }
}
