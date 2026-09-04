// @bun
// src/face/wrapper.ts
import { spawnSync } from "child_process";
import { existsSync as existsSync6 } from "fs";
import { appendFile, mkdir as mkdir3, readFile as readFile6 } from "fs/promises";
import { basename, dirname, join as join10 } from "path";
import { fileURLToPath } from "url";

// src/installer/paths.ts
import { join } from "path";

class PathError extends Error {
}
function homeDir(env) {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home || home.length === 0) {
    throw new PathError("HOME environment variable is not set");
  }
  return home;
}
function siltpokeRoot(env = process.env) {
  const override = env.SILTPOKE_HOME;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homeDir(env), ".siltpoke");
}

// src/cli/restart-outcome.ts
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join as join2 } from "path";
function restartOutcomePath(homeBase) {
  return join2(homeBase, "last-restart.json");
}
function readRestartOutcome(homeBase) {
  try {
    const raw = JSON.parse(readFileSync(restartOutcomePath(homeBase), "utf8"));
    if (!raw || typeof raw !== "object")
      return null;
    const o = raw;
    if (typeof o.ok !== "boolean" || typeof o.at !== "string" || typeof o.message !== "string") {
      return null;
    }
    const summary = typeof o.summary === "string" && o.summary.length > 0 ? o.summary : o.message;
    return { ok: o.ok, at: o.at, summary, message: o.message };
  } catch {
    return null;
  }
}

// src/state/pose.ts
var MOOD_TO_VARIANT = {
  happy: "base",
  excited: "base",
  idle: "base",
  watching: "base",
  annoyed: "concerned",
  concerned: "concerned",
  tired: "concerned",
  sleeping_quiet: "sleeping",
  sleeping_broke: "sleeping"
};
var POSE_OVERRIDING_MOODS = new Set([
  "annoyed",
  "concerned",
  "tired",
  "sleeping_quiet",
  "sleeping_broke"
]);
var POSE_KEYS = new Set([
  "base",
  "peek",
  "blink",
  "arms_crossed",
  "shrug",
  "wave",
  "stretch",
  "zen"
]);
var ANIMATED_MOODS = new Set(["idle", "watching"]);
var PHASE_DURATION_MS = 2000;
function variantsAvailable(species) {
  const keys = ["base", "concerned", "sleeping"];
  return keys.filter((k) => typeof species.art[k] === "string");
}
function resolveArt(species, mood, pose, unlockedPoses, nowMs = Date.now()) {
  if (POSE_OVERRIDING_MOODS.has(mood)) {
    const baseVariant2 = MOOD_TO_VARIANT[mood] ?? "base";
    return species.art[baseVariant2] ?? species.art.base;
  }
  if (pose && POSE_KEYS.has(pose) && pose !== "base" && (unlockedPoses?.includes(pose) ?? false)) {
    const poseArt = species.art[pose];
    if (typeof poseArt === "string")
      return poseArt;
  }
  const baseVariant = MOOD_TO_VARIANT[mood] ?? "base";
  if (!ANIMATED_MOODS.has(mood)) {
    return species.art[baseVariant] ?? species.art.base;
  }
  const available = variantsAvailable(species).filter((v) => v === baseVariant);
  if (available.length <= 1)
    return species.art[baseVariant] ?? species.art.base;
  const phase = Math.floor(nowMs / PHASE_DURATION_MS) % available.length;
  const chosen = available[phase] ?? baseVariant;
  return species.art[chosen] ?? species.art.base;
}

// src/state/progression.ts
import { readFile, writeFile, rename, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join as join3 } from "path";
var DEFAULT_STATS = {
  hp: 10,
  hunger: 5,
  energy: 8,
  mood: 6,
  bond: 0
};
var DEFAULT_PROGRESSION = {
  schemaVersion: 2,
  level: 1,
  xp: 0,
  xp_to_next_level: 100,
  unlocked_poses: ["base"],
  unlocked_titles: ["Hatchling"],
  pet_log: [],
  daily_actions: [],
  stats: { ...DEFAULT_STATS },
  stats_last_tick_at: new Date().toISOString(),
  streak_days_persistent: 0,
  streak_last_day: null
};
var AURA_TIERS = [
  { level: 15, glyph: "\u2605" },
  { level: 25, glyph: "\u2726" }
];
function pickAuraGlyph(level) {
  let glyph;
  for (const tier of AURA_TIERS) {
    if (level >= tier.level)
      glyph = tier.glyph;
  }
  return glyph;
}
var FILENAME = "progression.json";
function progressionPath(basePath) {
  return join3(basePath, FILENAME);
}
function isLegacyProgression(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const p = value;
  const dailyActionsOK = p.daily_actions === undefined || Array.isArray(p.daily_actions);
  return (p.schemaVersion === 1 || p.schemaVersion === 2) && typeof p.level === "number" && typeof p.xp === "number" && typeof p.xp_to_next_level === "number" && Array.isArray(p.unlocked_poses) && Array.isArray(p.unlocked_titles) && Array.isArray(p.pet_log) && dailyActionsOK;
}
function migrateToV2(parsed, now) {
  const petLog = Array.isArray(parsed.pet_log) ? parsed.pet_log : [];
  const sortedLog = [...petLog].sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  const streak_last_day = sortedLog.length > 0 ? sortedLog[sortedLog.length - 1]?.day : null;
  const streak_days_persistent = Math.min(7, petLog.length);
  const rawStats = parsed.stats;
  const hasValidStats = rawStats !== null && typeof rawStats === "object" && typeof rawStats.hp === "number" && typeof rawStats.hunger === "number" && typeof rawStats.energy === "number" && typeof rawStats.mood === "number" && typeof rawStats.bond === "number";
  const stats = hasValidStats ? {
    hp: rawStats?.hp,
    hunger: rawStats?.hunger,
    energy: rawStats?.energy,
    mood: rawStats?.mood,
    bond: rawStats?.bond
  } : { ...DEFAULT_STATS };
  return {
    schemaVersion: 2,
    level: typeof parsed.level === "number" ? parsed.level : 1,
    xp: typeof parsed.xp === "number" ? parsed.xp : 0,
    xp_to_next_level: typeof parsed.xp_to_next_level === "number" ? parsed.xp_to_next_level : 100,
    unlocked_poses: Array.isArray(parsed.unlocked_poses) ? parsed.unlocked_poses : ["base"],
    unlocked_titles: Array.isArray(parsed.unlocked_titles) ? parsed.unlocked_titles : ["Hatchling"],
    pet_log: petLog,
    daily_actions: Array.isArray(parsed.daily_actions) ? parsed.daily_actions : [],
    stats,
    stats_last_tick_at: now.toISOString(),
    streak_days_persistent,
    streak_last_day
  };
}
async function readProgression(basePath) {
  const path = progressionPath(basePath);
  if (!existsSync(path))
    return { ...DEFAULT_PROGRESSION, stats_last_tick_at: new Date().toISOString() };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!isLegacyProgression(parsed))
      return { ...DEFAULT_PROGRESSION, stats_last_tick_at: new Date().toISOString() };
    const needsMigration = parsed.schemaVersion !== 2 || typeof parsed.stats_last_tick_at !== "string" || typeof parsed.streak_days_persistent !== "number" || !("streak_last_day" in parsed);
    if (needsMigration) {
      return migrateToV2(parsed, new Date);
    }
    if (typeof parsed.stats?.hp !== "number") {
      return migrateToV2(parsed, new Date);
    }
    return parsed;
  } catch {
    return { ...DEFAULT_PROGRESSION, stats_last_tick_at: new Date().toISOString() };
  }
}

// src/state/state.ts
import { writeFile as writeFile2, rename as rename2, readFile as readFile2, mkdir as mkdir2 } from "fs/promises";
import { existsSync as existsSync2 } from "fs";
import { join as join4 } from "path";
var FILENAME2 = "state.json";
var DEFAULT_STALE_MS = 30 * 60 * 1000;
function statePath(basePath) {
  return join4(basePath, FILENAME2);
}
async function readState(basePath) {
  const path = statePath(basePath);
  if (!existsSync2(path))
    return null;
  try {
    const raw = await readFile2(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== 1)
      return null;
    if (typeof parsed.mood !== "string" || typeof parsed.pose !== "string" || typeof parsed.bubble_short !== "string" || typeof parsed.severity !== "string" || typeof parsed.confidence !== "string" || typeof parsed.last_updated_ms !== "number" || typeof parsed.last_session_id !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function isStale(state, maxAgeMs = DEFAULT_STALE_MS, now = Date.now()) {
  return now - state.last_updated_ms > maxAgeMs;
}

// src/face/width.ts
var ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
function stripAnsi(s) {
  return s.replace(ANSI_PATTERN, "");
}
function visibleWidth(s) {
  const stripped = stripAnsi(s);
  return [...stripped].length;
}
function visibleWidthOfWidestLine(s) {
  return s.split(`
`).reduce((m, l) => Math.max(m, visibleWidth(l)), 0);
}
function isWideCodePoint(cp) {
  return cp >= 4352 && cp <= 4447 || cp >= 11904 && cp <= 12350 || cp >= 12353 && cp <= 13311 || cp >= 13312 && cp <= 19903 || cp >= 19968 && cp <= 40959 || cp >= 40960 && cp <= 42191 || cp >= 44032 && cp <= 55203 || cp >= 63744 && cp <= 64255 || cp >= 65072 && cp <= 65103 || cp >= 65280 && cp <= 65376 || cp >= 65504 && cp <= 65510 || cp >= 127744 && cp <= 128591 || cp >= 128640 && cp <= 128767 || cp >= 129280 && cp <= 129535;
}
function visualWidth(s) {
  const stripped = stripAnsi(s);
  let w = 0;
  for (const ch of stripped) {
    const cp = ch.codePointAt(0);
    if (cp === undefined)
      continue;
    w += isWideCodePoint(cp) ? 2 : 1;
  }
  return w;
}
function truncateToVisualWidth(s, maxWidth) {
  if (maxWidth <= 0)
    return "";
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined)
      continue;
    const cw = isWideCodePoint(cp) ? 2 : 1;
    if (w + cw > maxWidth)
      break;
    w += cw;
    out += ch;
  }
  return out;
}

// src/face/composer.ts
var GUTTER = " ";
function composeOutput(opts) {
  const { face, inner, termWidth } = opts;
  if (!face)
    return inner;
  if (!inner)
    return face;
  const faceLines = face.split(`
`);
  const innerLines = inner.split(`
`);
  const faceWidth = visibleWidthOfWidestLine(face);
  const innerWidth = visibleWidthOfWidestLine(inner);
  const combinedWidth = faceWidth + GUTTER.length + innerWidth;
  if (termWidth > 0 && combinedWidth > termWidth) {
    return inner;
  }
  const rows = Math.max(faceLines.length, innerLines.length);
  const out = [];
  const INDENT_CHAR = "\u2800";
  for (let i = 0;i < rows; i++) {
    const faceLine = faceLines[i];
    const innerLine = innerLines[i] ?? "";
    if (faceLine === undefined || faceLine.trim() === "") {
      const indentWidth = faceWidth + GUTTER.length;
      out.push(`${INDENT_CHAR.repeat(indentWidth)}${innerLine}`);
    } else {
      const facePadded = faceLine.padEnd(faceWidth, " ");
      out.push(`${facePadded}${GUTTER}${innerLine}`);
    }
  }
  return out.join(`
`);
}

// src/face/menubar.ts
var RESTART_OUTCOME_TTL_MS = 10 * 60000;
var SUBMENU_WRAP = 52;
function wrapForSubmenu(text, width = SUBMENU_WRAP) {
  const out = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur.length === 0)
      cur = word;
    else if (cur.length + 1 + word.length <= width)
      cur += ` ${word}`;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur.length > 0)
    out.push(cur);
  return out;
}
function relTime(fromIso, nowMs) {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t))
    return "";
  const diffMin = Math.floor(Math.max(0, nowMs - t) / 60000);
  if (diffMin < 1)
    return "just now";
  if (diffMin < 60)
    return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)
    return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}
function hhmm(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t))
    return iso;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function sanitize(s) {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\xA6").trim();
}
function sanitizeAndClip(s, budget) {
  const clean = sanitize(s);
  const clipped = truncateToVisualWidth(clean, budget);
  return clipped === clean ? clipped : `${clipped}\u2026`;
}
var NAME_BUDGET = 24;
var COMMENT_BUDGET = 60;
function renderMenubar(input) {
  const n = input.reviews.length;
  const badge = n > 0 ? ` \xB7 ${n}` : "";
  const title = `${input.emoji} ${sanitizeAndClip(input.name, NAME_BUDGET)}${badge}`;
  const lines = [title, "---"];
  for (const r of input.reviews) {
    const builderTag = `\uD83D\uDD27 ${r.authorFamily ?? "claude"}`;
    const tagParts = [r.repo, r.branch, relTime(r.timestamp, input.nowMs), builderTag].filter((p) => typeof p === "string" && p.length > 0);
    lines.push(`${sanitize(tagParts.join(" \xB7 "))} | color=#888 font=Menlo`);
    lines.push(`${sanitizeAndClip(r.comment, COMMENT_BUDGET)} | href=${input.dashboardUrl}/timeline`);
    lines.push("---");
  }
  if (input.dashboard) {
    lines.push(`\uD83D\uDDA5 Open dashboard (see all) | bash=${input.dashboard.bun} param1=${input.dashboard.cli} param2=dashboard terminal=false refresh=false`);
  } else {
    lines.push(`\uD83D\uDDA5 Open dashboard (see all) | href=${input.dashboardUrl}`);
  }
  lines.push("---");
  if (input.restart) {
    lines.push(`\uD83D\uDD04 Restart daemon | bash=${input.restart.bun} param1=${input.restart.script} param2=restart terminal=false refresh=true`);
  }
  const outcome = input.restartOutcome;
  if (outcome) {
    const at = Date.parse(outcome.at);
    const fresh = Number.isFinite(at) && input.nowMs - at <= RESTART_OUTCOME_TTL_MS;
    if (fresh && !outcome.ok) {
      lines.push(`\u26A0 Restart ${sanitize(outcome.summary)} | color=orange`);
      for (const line of wrapForSubmenu(sanitize(outcome.message))) {
        lines.push(`-- ${line}`);
      }
    } else if (fresh && outcome.ok) {
      lines.push(`\u2713 Restarted ${sanitize(hhmm(outcome.at))} | color=green`);
    }
  }
  lines.push("Refresh | refresh=true");
  return lines.join(`
`);
}

// src/face/menubar-aggregate.ts
import { join as join8 } from "path";

// src/state/critic-event-log.ts
import { existsSync as existsSync3 } from "fs";
import { readFile as readFile3 } from "fs/promises";
import { join as join6 } from "path";

// src/preference-log/reader.ts
import { join as join5 } from "path";
var DEFAULT_PATH = join5(siltpokeRoot(), "preference-log.jsonl");

// src/state/audit-absence.ts
function text(v) {
  return typeof v === "string" ? v : "";
}
function classifyAuditAbsence(input) {
  if (input.skipped === true)
    return "not_reviewed";
  if (input.accepted === true) {
    return input.critiqueId !== null && input.critiqueId !== "" ? "present" : "write_failed";
  }
  const guard = text(input.guardReason);
  if (guard !== "") {
    if (guard.includes("evidence array empty"))
      return "evidence_empty";
    if (guard.includes("evidence_corpus"))
      return "snippet_unverified";
  }
  const reason = text(input.reason);
  if (reason !== "") {
    if (reason.includes("no diff hunks"))
      return "nothing_to_review";
    if (reason.includes("spawn failed") || reason.includes("ENOENT"))
      return "brain_unavailable";
    if (reason.includes("exited with code 143"))
      return "brain_killed";
    if (reason.includes("failed schema validation"))
      return "brain_schema";
    if (reason.includes("not valid JSON"))
      return "brain_not_json";
    return "brain_failed_other";
  }
  return "unrecorded";
}

// src/state/critic-event-log-types.ts
function classifySpeechKind(status, severity, critiqueText) {
  if (status !== "fired")
    return null;
  const sev = (severity ?? "").toLowerCase();
  if (sev === "high")
    return "critical";
  if (sev === "medium" || sev === "med")
    return "warning";
  return "comment";
}

// src/state/critic-event-log-parse.ts
function parseProviderFields(raw) {
  return {
    provider: typeof raw.provider === "string" ? raw.provider : "claude",
    billing: raw.billing === "quota" ? "quota" : "usd",
    model: typeof raw.model === "string" ? raw.model : null,
    authorFamily: typeof raw.authorFamily === "string" ? raw.authorFamily : "claude"
  };
}
function parseBranch(raw) {
  return typeof raw.branch === "string" && raw.branch.length > 0 ? raw.branch : null;
}
function parseCapturedIntent(raw) {
  const q = typeof raw.user_raw_query === "string" && raw.user_raw_query.length > 0 ? raw.user_raw_query : null;
  return {
    user_raw_query: q,
    user_raw_query_truncated: q !== null && raw.user_raw_query_truncated === true,
    agent_reply: typeof raw.agent_reply === "string" && raw.agent_reply.length > 0 ? raw.agent_reply : null
  };
}
function parseTiming(raw) {
  if (typeof raw !== "object" || raw === null)
    return null;
  const r = raw;
  const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const summary_ms = num(r.summary_ms);
  const critic_ms = num(r.critic_ms);
  const wall_ms = num(r.wall_ms);
  if (summary_ms === 0 && critic_ms === 0 && wall_ms === 0)
    return null;
  return { summary_ms, critic_ms, wall_ms };
}
function parseDiffSummary(raw) {
  if (typeof raw !== "object" || raw === null)
    return null;
  const r = raw;
  const intent = typeof r.intent === "string" ? r.intent : null;
  if (intent === null)
    return null;
  const strArr = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  const filesRaw = Array.isArray(r.files_with_purpose) ? r.files_with_purpose : [];
  const files = filesRaw.filter((f) => typeof f === "object" && f !== null).filter((f) => typeof f.path === "string" && typeof f.purpose === "string").map((f) => ({ path: f.path, purpose: f.purpose }));
  const fileCount = typeof r.file_count === "number" && Number.isFinite(r.file_count) && r.file_count >= 0 ? Math.floor(r.file_count) : files.length;
  const source = r.source === "heuristic" ? "heuristic" : "haiku";
  const posInt = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  let truncated;
  if (typeof r.truncated === "object" && r.truncated !== null) {
    const t = r.truncated;
    const entries = {
      key_changes: posInt(t.key_changes),
      risks: posInt(t.risks),
      files_with_purpose: posInt(t.files_with_purpose)
    };
    if (Object.values(entries).some((v) => v !== undefined))
      truncated = entries;
  }
  return {
    intent,
    key_changes: strArr(r.key_changes),
    risks: strArr(r.risks),
    file_count: fileCount,
    files_with_purpose: files,
    source,
    ...truncated ? { truncated } : {}
  };
}
function deriveProject(cwd) {
  if (!cwd)
    return "(unknown)";
  const parts = cwd.split("/").filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? cwd;
}
function absenceOf(raw, skipped) {
  return classifyAuditAbsence({
    accepted: raw.m112_accepted,
    reason: raw.m112_reason,
    guardReason: raw.m112_guard_reason,
    critiqueId: typeof raw.critique_id === "string" && raw.critique_id !== "" ? raw.critique_id : null,
    skipped
  });
}
var EVIDENCE_LABELS = new Set([
  "not_checked",
  "verified",
  "no_evidence",
  "partly_unverified",
  "none_verified"
]);
function evidenceLabelOf(raw) {
  const v = raw.m112_evidence_label;
  return typeof v === "string" && EVIDENCE_LABELS.has(v) ? v : null;
}
function unverifiedCountOf(raw) {
  const v = raw.m112_evidence_unverified;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}
function diffCoverageOf(raw) {
  const s = raw.m112_diff_shown;
  const t = raw.m112_diff_total;
  if (typeof s !== "number" || typeof t !== "number")
    return null;
  if (!Number.isFinite(s) || !Number.isFinite(t))
    return null;
  const shown = Math.floor(s);
  const total = Math.floor(t);
  if (shown <= 0 || total <= shown)
    return null;
  return { shown, total };
}
function parseCall(rawIn) {
  if (typeof rawIn !== "object" || rawIn === null)
    return null;
  const raw = rawIn;
  const ts = typeof raw.timestamp === "string" ? raw.timestamp : null;
  const sid = typeof raw.session_id === "string" ? raw.session_id : null;
  if (!ts || !sid)
    return null;
  const skipReason = typeof raw.skipped === "string" ? raw.skipped : null;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : null;
  const project = deriveProject(cwd);
  const critiqueId = typeof raw.critique_id === "string" && raw.critique_id.length > 0 ? raw.critique_id : null;
  if (skipReason !== null) {
    return {
      timestamp: ts,
      session_id: sid,
      cwd,
      project,
      status: "skipped",
      skip_reason: skipReason,
      audit_absence: absenceOf(raw, true),
      evidence_label: evidenceLabelOf(raw),
      evidence_unverified: unverifiedCountOf(raw),
      diff_shown: diffCoverageOf(raw)?.shown ?? null,
      diff_total: diffCoverageOf(raw)?.total ?? null,
      ...parseCapturedIntent(raw),
      critique_id: null,
      bubble_short: null,
      bubble_long: null,
      critique_for_claude: null,
      severity: null,
      confidence: null,
      evidence: [],
      gating_decision: null,
      turns_included: null,
      duration_ms: null,
      cost_usd: null,
      tokens: null,
      diff_snapshot_id: null,
      diff_text: null,
      diff_summary: null,
      user_action: null,
      speech_kind: null,
      reasoning: null,
      timing: parseTiming(raw.timing),
      summary_error: typeof raw.summary_error === "string" ? raw.summary_error : null,
      error_message: null,
      v2: null,
      branch: parseBranch(raw),
      ...parseProviderFields(raw)
    };
  }
  const errorMessage = typeof raw.error_message === "string" && raw.error_message.length > 0 ? raw.error_message : null;
  if (errorMessage !== null) {
    return {
      timestamp: ts,
      session_id: sid,
      cwd,
      project,
      status: "skipped",
      skip_reason: "brain_error",
      audit_absence: absenceOf(raw, false),
      evidence_label: evidenceLabelOf(raw),
      evidence_unverified: unverifiedCountOf(raw),
      diff_shown: diffCoverageOf(raw)?.shown ?? null,
      diff_total: diffCoverageOf(raw)?.total ?? null,
      ...parseCapturedIntent(raw),
      critique_id: critiqueId,
      bubble_short: null,
      bubble_long: null,
      critique_for_claude: null,
      severity: null,
      confidence: null,
      evidence: [],
      gating_decision: null,
      turns_included: null,
      duration_ms: typeof raw.duration_ms === "number" ? raw.duration_ms : null,
      cost_usd: null,
      tokens: null,
      diff_snapshot_id: null,
      diff_text: null,
      diff_summary: null,
      user_action: null,
      speech_kind: null,
      reasoning: null,
      timing: parseTiming(raw.timing),
      summary_error: typeof raw.summary_error === "string" ? raw.summary_error : null,
      error_message: errorMessage,
      v2: null,
      branch: parseBranch(raw),
      ...parseProviderFields(raw)
    };
  }
  const bo = raw.brain_output ?? {};
  const u = raw.usage ?? {};
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const strOrNull = (v) => typeof v === "string" && v.length > 0 ? v : null;
  const evidenceArr = Array.isArray(bo.evidence) ? bo.evidence : [];
  return {
    timestamp: ts,
    session_id: sid,
    cwd,
    project,
    status: "fired",
    skip_reason: null,
    critique_id: critiqueId,
    bubble_short: raw.bubble_suppressed === true ? null : strOrNull(bo.bubble_short),
    bubble_long: strOrNull(bo.bubble_long),
    critique_for_claude: strOrNull(bo.critique_for_claude),
    severity: typeof bo.severity === "string" ? bo.severity : null,
    confidence: typeof bo.confidence === "string" ? bo.confidence : null,
    evidence: evidenceArr,
    audit_absence: absenceOf(raw, false),
    evidence_label: evidenceLabelOf(raw),
    evidence_unverified: unverifiedCountOf(raw),
    diff_shown: diffCoverageOf(raw)?.shown ?? null,
    diff_total: diffCoverageOf(raw)?.total ?? null,
    ...parseCapturedIntent(raw),
    gating_decision: typeof raw.critic_path_decision === "string" && raw.critic_path_decision || typeof raw.m112_decision === "string" && raw.m112_decision || (typeof raw.gating_decision === "string" ? raw.gating_decision : null),
    turns_included: typeof raw.turns_included === "number" ? raw.turns_included : null,
    duration_ms: typeof raw.duration_ms === "number" ? raw.duration_ms : null,
    cost_usd: typeof u.total_cost_usd === "number" ? u.total_cost_usd : null,
    tokens: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cache_read: num(u.cache_read_input_tokens),
      cache_create: num(u.cache_creation_input_tokens)
    },
    diff_snapshot_id: typeof raw.diff_snapshot_id === "string" ? raw.diff_snapshot_id : null,
    diff_text: null,
    diff_summary: parseDiffSummary(raw.diff_summary),
    user_action: null,
    speech_kind: classifySpeechKind("fired", typeof bo.severity === "string" ? bo.severity : null, strOrNull(bo.critique_for_claude)),
    reasoning: strOrNull(bo.reasoning),
    timing: parseTiming(raw.timing),
    summary_error: typeof raw.summary_error === "string" ? raw.summary_error : null,
    error_message: null,
    v2: null,
    branch: parseBranch(raw),
    ...parseProviderFields(raw)
  };
}

// src/state/critic-event-log-window.ts
function parseLine(line) {
  try {
    return parseCall(JSON.parse(line));
  } catch {
    return null;
  }
}

// src/state/critic-event-log.ts
function readTailWindow(lines, limit) {
  const calls = [];
  for (const line of lines.slice(-limit)) {
    const call = parseLine(line);
    if (call)
      calls.push(call);
  }
  calls.reverse();
  let hasMore = false;
  for (let i = lines.length - limit - 1;i >= 0; i--) {
    if (parseLine(lines[i])) {
      hasMore = true;
      break;
    }
  }
  return { calls, hasMore };
}
function scanBoundedWindow(lines, limit, rangeCutoff, before) {
  const calls = [];
  let hasMore = false;
  for (let i = lines.length - 1;i >= 0; i--) {
    const call = parseLine(lines[i]);
    if (!call)
      continue;
    const t = Date.parse(call.timestamp);
    if (Number.isNaN(t))
      continue;
    if (before !== null && t >= before.getTime())
      continue;
    if (rangeCutoff !== null && t < rangeCutoff.getTime())
      break;
    if (calls.length >= limit) {
      hasMore = true;
      break;
    }
    calls.push(call);
  }
  return { calls, hasMore };
}
async function readBrainCalls(basePath, limit = 50, opts = {}) {
  const path = join6(basePath, "brain-calls.jsonl");
  if (!existsSync3(path))
    return { calls: [], hasMore: false };
  const raw = await readFile3(path, "utf8");
  const lines = raw.split(`
`).filter((l) => l.length > 0);
  const rangeCutoff = opts.rangeCutoff ?? null;
  const before = opts.before ?? null;
  return rangeCutoff === null && before === null ? readTailWindow(lines, limit) : scanBoundedWindow(lines, limit, rangeCutoff, before);
}
async function readUserActions(basePath) {
  const map = new Map;
  const path = join6(basePath, "critic-actions.jsonl");
  if (!existsSync3(path))
    return map;
  const raw = await readFile3(path, "utf8");
  for (const line of raw.split(`
`)) {
    if (!line)
      continue;
    try {
      const e = JSON.parse(line);
      if (typeof e.session_id !== "string" || typeof e.timestamp !== "string")
        continue;
      if (e.action !== "dismiss" && e.action !== "ack" && e.action !== "clear")
        continue;
      const key = `${e.session_id}|${e.timestamp}`;
      if (e.action === "clear") {
        map.delete(key);
      } else {
        map.set(key, e.action === "dismiss" ? "dismissed" : "acked");
      }
    } catch {}
  }
  return map;
}

// src/state/critique-status.ts
import { readFile as readFile4, writeFile as writeFile3, readdir } from "fs/promises";
import { existsSync as existsSync4 } from "fs";
import { join as join7 } from "path";
var STATUS_LINE = /^status:\s*(\S+)\s*$/m;
async function readStatus(critiquePath) {
  try {
    const raw = await readFile4(critiquePath, "utf8");
    const match = raw.match(STATUS_LINE);
    if (!match)
      return null;
    const value = match[1];
    if (value === "pending" || value === "forwarded" || value === "dismissed" || value === "acked") {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}
async function findCritiqueByIdOrLatest(basePath, idOrLatest) {
  const critiqueRoot = join7(basePath, "critiques");
  if (idOrLatest === "latest") {
    const latestPath = join7(critiqueRoot, "latest.md");
    return existsSync4(latestPath) ? latestPath : null;
  }
  const archiveRoot = join7(critiqueRoot, "archive");
  if (!existsSync4(archiveRoot))
    return null;
  try {
    const dates = await readdir(archiveRoot);
    for (const date of dates.sort().reverse()) {
      const dateDir = join7(archiveRoot, date);
      const files = await readdir(dateDir);
      const match = files.find((f) => f === `${idOrLatest}.md`);
      if (match)
        return join7(dateDir, match);
    }
    return null;
  } catch {
    return null;
  }
}

// src/face/menubar-aggregate.ts
var KNOWN_SEVERITIES = ["info", "low", "medium", "high"];
function normalizeSeverity(severity) {
  return KNOWN_SEVERITIES.includes(severity ?? "") ? severity : "info";
}
function commentOf(c) {
  return (c.critique_for_claude ?? c.bubble_short ?? "").trim();
}
function isPending(c, actionsMap) {
  if (commentOf(c).length === 0)
    return false;
  if (c.critique_id === null)
    return false;
  const key = `${c.session_id}|${c.timestamp}`;
  return !actionsMap.has(key);
}
async function isActionedViaCli(c) {
  if (c.cwd === null || c.critique_id === null)
    return false;
  const basePath = join8(c.cwd, ".siltpoke");
  const path = await findCritiqueByIdOrLatest(basePath, c.critique_id);
  if (!path)
    return false;
  const status = await readStatus(path);
  return status === "acked" || status === "dismissed";
}
var DEFAULT_FRESHNESS_MS = 30 * 60 * 1000;
async function collectPendingReviews(homeBase, opts = {}) {
  const limit = opts.limit ?? 8;
  const scanWindow = opts.scanWindow ?? 200;
  const freshnessMs = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const [{ calls }, actionsMap] = await Promise.all([
    readBrainCalls(homeBase, scanWindow),
    readUserActions(homeBase)
  ]);
  const out = [];
  const seenSessions = new Set;
  for (const c of calls) {
    if (out.length >= limit)
      break;
    if (seenSessions.has(c.session_id))
      continue;
    if (!isPending(c, actionsMap))
      continue;
    const ageMs = nowMs - Date.parse(c.timestamp);
    if (Number.isFinite(ageMs) && ageMs > freshnessMs)
      continue;
    if (await isActionedViaCli(c))
      continue;
    seenSessions.add(c.session_id);
    out.push({
      repo: c.project,
      branch: c.branch,
      session: c.session_id.slice(0, 3),
      comment: commentOf(c),
      severity: normalizeSeverity(c.severity),
      critiqueId: c.critique_id,
      timestamp: c.timestamp,
      authorFamily: c.authorFamily || "claude"
    });
  }
  return out;
}

// src/face/species.ts
var slime = {
  name: "slime",
  menubarEmoji: "\uD83D\uDFE2",
  art: {
    base: [" .---. ", " (o.o) ", " (___) "].join(`
`),
    concerned: [" .---. ", " (>.<) ", " (___) "].join(`
`),
    sleeping: [" .---. ", " (-.-) ", "  zzz  "].join(`
`),
    peek: [" .---. ", " (o.-) ", " (___) "].join(`
`),
    blink: [" .---. ", " (^.^) ", " (___) "].join(`
`),
    arms_crossed: [" .---. ", " (-_-) ", " [___] "].join(`
`),
    shrug: [" .---. ", " (o.O) ", " \xAF\\_/\xAF "].join(`
`),
    wave: [" .---. ", " (^o^) ", " (_o/) "].join(`
`),
    stretch: [" .---. ", " (o.~) ", " ~o/^\\~ "].join(`
`),
    zen: [" .---. ", " (-\u3002-) ", " \u262F___\u262F "].join(`
`)
  }
};
var cat = {
  name: "cat",
  menubarEmoji: "\uD83D\uDC31",
  art: {
    base: [" /\\_/\\ ", " (o.o) ", " > ^ < "].join(`
`),
    concerned: [" /\\_/\\ ", " (>.<) ", " > _ < "].join(`
`),
    sleeping: [" /\\_/\\ ", " (-.-) ", "  zzz  "].join(`
`),
    peek: [" /\\_/\\ ", " (o.-) ", " > ^ < "].join(`
`),
    blink: [" /\\_/\\ ", " (^.^) ", " > ^ < "].join(`
`),
    arms_crossed: [" /\\_/\\ ", " (-_-) ", " >=-=< "].join(`
`),
    shrug: [" /\\_/\\ ", " (o.O) ", " \xAF\\_/\xAF "].join(`
`),
    wave: [" /\\_/\\ ", " (^o^) ", " >o/^< "].join(`
`),
    stretch: [" /\\_/\\ ", " (o.~) ", " ~o/^\\~ "].join(`
`),
    zen: [" /\\_/\\ ", " (-\u3002-) ", " \u262F ^ \u262F "].join(`
`)
  }
};
var owl = {
  name: "owl",
  menubarEmoji: "\uD83E\uDD89",
  art: {
    base: [" ,-,-, ", " (O,O) ", " ===== "].join(`
`),
    concerned: [" ,-,-, ", " (>,<) ", " ===== "].join(`
`),
    sleeping: [" ,-,-, ", " (-,-) ", " ===== "].join(`
`),
    peek: [" ,-,-, ", " (O,-) ", " ===== "].join(`
`),
    blink: [" ,-,-, ", " (^,^) ", " ===== "].join(`
`),
    arms_crossed: [" ,-,-, ", " (=,=) ", " =[X]= "].join(`
`),
    shrug: [" ,-,-, ", " (O,o) ", " \xAF===\xAF "].join(`
`),
    wave: [" ,-,-, ", " (^,^) ", " ==o/= "].join(`
`),
    stretch: [" ,-,-, ", " (O,~) ", " ~o=o~ "].join(`
`),
    zen: [" ,-,-, ", " (-\u3002-) ", " \u262F===\u262F "].join(`
`)
  }
};
var robot = {
  name: "robot",
  menubarEmoji: "\uD83E\uDD16",
  art: {
    base: [" [---] ", " |o-o| ", " [___] "].join(`
`),
    concerned: [" [---] ", " |x-x| ", " [___] "].join(`
`),
    sleeping: [" [---] ", " |---| ", " [___] "].join(`
`),
    peek: [" [---] ", " |o-_| ", " [___] "].join(`
`),
    blink: [" [---] ", " |^-^| ", " [___] "].join(`
`),
    arms_crossed: [" [---] ", " |=-=| ", " [X-X] "].join(`
`),
    shrug: [" [---] ", " |o-O| ", " [\xAF_\xAF] "].join(`
`),
    wave: [" [---] ", " |^-^| ", " [_o/] "].join(`
`),
    stretch: [" [---] ", " |o-~| ", " [~o~] "].join(`
`),
    zen: [" [---] ", " |-\u3002-| ", " [\u262F_\u262F] "].join(`
`)
  }
};
var bunny = {
  name: "bunny",
  menubarEmoji: "\uD83D\uDC30",
  art: {
    base: [" (\\_/) ", " (o.o) ", " (=v=) "].join(`
`),
    concerned: [" (\\_/) ", " (>.<) ", " (=v=) "].join(`
`),
    sleeping: [" (\\_/) ", " (-.-) ", "  zzz  "].join(`
`),
    peek: [" (\\_/) ", " (o.-) ", " (=v=) "].join(`
`),
    blink: [" (\\_/) ", " (^.^) ", " (=v=) "].join(`
`),
    arms_crossed: [" (\\_/) ", " (-_-) ", " [=v=] "].join(`
`),
    shrug: [" (\\_/) ", " (o.O) ", " \xAF=v=\xAF "].join(`
`),
    wave: [" (\\_/) ", " (^o^) ", " (=v/) "].join(`
`),
    stretch: [" (\\_/) ", " (o.~) ", " ~=v=~ "].join(`
`),
    zen: [" (\\_/) ", " (-\u3002-) ", " \u262F=v=\u262F "].join(`
`)
  }
};
var SPECIES = {
  slime,
  cat,
  owl,
  robot,
  bunny
};
var DEFAULT_SPECIES = "slime";
function getSpecies(name) {
  if (!name)
    return SPECIES[DEFAULT_SPECIES];
  return SPECIES[name] ?? SPECIES[DEFAULT_SPECIES];
}

// src/face/tasklist.ts
import { existsSync as existsSync5 } from "fs";
import { readFile as readFile5 } from "fs/promises";
import { join as join9 } from "path";
var LEAF = /^\s*[-*+]\s+\[(.)\]\s*(.*)$/;
var FENCE = /^\s*(```|~~~)/;
function parseTasklist(md) {
  let inFence = false;
  let done = 0;
  let total = 0;
  let currentStep;
  for (const line of md.split(`
`)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence)
      continue;
    const m = LEAF.exec(line);
    if (!m)
      continue;
    total += 1;
    const state = m[1];
    if (state === "x" || state === "X") {
      done += 1;
    } else if (state === "/" && currentStep === undefined) {
      currentStep = (m[2] ?? "").trim();
    }
  }
  if (total === 0)
    return null;
  return currentStep === undefined ? { done, total } : { done, total, currentStep };
}
var DEFAULT_MAX_STEP_COLS = 40;
var CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
function formatTasklistSegment(p, maxStepCols = DEFAULT_MAX_STEP_COLS) {
  const base = `\uD83D\uDCCB ${p.done}/${p.total}`;
  if (p.done === p.total)
    return `${base} \u2713`;
  const step = stripAnsi(p.currentStep ?? "").replace(CONTROL_CHARS, "").trim();
  if (!step)
    return base;
  if (visualWidth(step) <= maxStepCols)
    return `${base} \u25B6 ${step}`;
  const clipped = truncateToVisualWidth(step, maxStepCols - 1);
  return `${base} \u25B6 ${clipped}\u2026`;
}
async function readTasklist(cwd) {
  if (!cwd)
    return null;
  try {
    const path = join9(cwd, ".claude", "tasklist.md");
    if (!existsSync5(path))
      return null;
    return await readFile5(path, "utf8");
  } catch {
    return null;
  }
}

// src/face/wrapper.ts
async function logError(basePath, message) {
  try {
    const logsDir = join10(basePath, "logs");
    await mkdir3(logsDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ERROR ${message}
`;
    await appendFile(join10(logsDir, "errors.log"), line);
  } catch {}
}
async function readConfig(basePath) {
  const fallback = {
    species: DEFAULT_SPECIES,
    name: "",
    bubble: "",
    bubbleColor: "cyan",
    terminalWidth: 0,
    minimalMode: false
  };
  try {
    const configPath = join10(basePath, "config.json");
    if (!existsSync6(configPath))
      return fallback;
    const raw = await readFile6(configPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      species: typeof parsed?.species === "string" ? parsed.species : DEFAULT_SPECIES,
      name: typeof parsed?.name === "string" ? parsed.name : "",
      bubble: typeof parsed?.bubble === "string" ? parsed.bubble : "",
      bubbleColor: typeof parsed?.bubbleColor === "string" ? parsed.bubbleColor : "cyan",
      terminalWidth: typeof parsed?.terminalWidth === "number" && parsed.terminalWidth > 0 ? Math.floor(parsed.terminalWidth) : 0,
      minimalMode: parsed?.minimalMode === true
    };
  } catch {
    return fallback;
  }
}
var SEVERITY_TO_COLOR = {
  high: "red",
  medium: "yellow",
  med: "yellow",
  low: "gray",
  info: "gray"
};
function severityToColor(severity, fallback) {
  return SEVERITY_TO_COLOR[severity] ?? fallback;
}
var ANSI_COLOR_CODES = {
  cyan: "36",
  green: "32",
  yellow: "33",
  magenta: "35",
  red: "31",
  blue: "34",
  white: "37",
  gray: "90",
  pink: "38;5;213",
  hotpink: "38;5;205",
  coral: "38;5;210",
  mint: "38;5;121"
};
function colorize(text2, colorName) {
  const code = ANSI_COLOR_CODES[colorName] ?? ANSI_COLOR_CODES.cyan;
  return `\x1B[${code}m${text2}\x1B[0m`;
}
function tokenize(text2) {
  return text2.split(/(?:\s+|(?<=[\uFF0C\u3002\uFF01\uFF1F]))/).filter((t) => t !== "");
}
function wrapBubble(text2, maxWidth, maxLines) {
  if (maxWidth <= 0 || visualWidth(text2) <= maxWidth)
    return [text2];
  const words = tokenize(text2);
  const lines = [];
  let cur = "";
  const endsWithCjkPunct = (s) => /[\uFF0C\u3002\uFF01\uFF1F]$/.test(s);
  for (const w of words) {
    const sep = !cur || endsWithCjkPunct(cur) ? "" : " ";
    const tryNext = `${cur}${sep}${w}`;
    if (visualWidth(tryNext) <= maxWidth) {
      cur = tryNext;
    } else {
      if (cur)
        lines.push(cur);
      cur = w;
    }
  }
  if (cur)
    lines.push(cur);
  const flat = [];
  for (const line of lines) {
    if (visualWidth(line) <= maxWidth) {
      flat.push(line);
      continue;
    }
    let rest = line;
    while (visualWidth(rest) > maxWidth) {
      const chunk = truncateToVisualWidth(rest, maxWidth);
      flat.push(chunk);
      rest = rest.slice(chunk.length);
    }
    if (rest)
      flat.push(rest);
  }
  if (flat.length > maxLines) {
    const kept = flat.slice(0, maxLines);
    const idx = maxLines - 1;
    const last = kept[idx];
    const trimmed = truncateToVisualWidth(last, Math.max(0, maxWidth - 3));
    kept[idx] = `${trimmed}...`;
    return kept;
  }
  return flat;
}
function buildBubbleBlock(bubble, colorName, faceWidth, termWidth) {
  const quoted = `"${bubble}"`;
  const effective = termWidth > 0 ? termWidth : 160;
  const available = Math.max(20, effective - faceWidth - 2);
  const wrapped = wrapBubble(quoted, available, 3);
  return wrapped.map((l) => colorize(l, colorName)).join(`
`);
}
function detectTermWidth() {
  if (process.stderr.columns && process.stderr.columns > 0) {
    return process.stderr.columns;
  }
  const envCols = parseInt(process.env.COLUMNS ?? "", 10);
  if (Number.isFinite(envCols) && envCols > 0)
    return envCols;
  return 160;
}
function widestLine(text2) {
  return text2.split(`
`).reduce((m, l) => Math.max(m, l.length), 0);
}
function buildFaceBlock(art, name, progressionLine, titleLine) {
  const artLines = art.split(`
`);
  const artWidth = artLines.reduce((m, l) => Math.max(m, l.length), 0);
  const labelLines = [name, titleLine, progressionLine].filter((l) => typeof l === "string" && l.length > 0);
  const widestLabel = labelLines.reduce((m, l) => Math.max(m, l.length), 0);
  const blockWidth = widestLabel ? Math.max(artWidth, widestLabel + 2) : artWidth;
  const NBSP_LIKE = "\u2800";
  const center = (line) => {
    const total = blockWidth - line.length;
    if (total <= 0)
      return line;
    const left = Math.floor(total / 2);
    const right = total - left;
    return NBSP_LIKE.repeat(left) + line + " ".repeat(right);
  };
  const centeredArt = artLines.map(center).join(`
`);
  if (labelLines.length === 0)
    return centeredArt;
  return [centeredArt, ...labelLines.map(center)].join(`
`);
}
function formatProgressionLine(p) {
  return `L${p.level} ${p.xp}/${p.xp_to_next_level}`;
}
var TITLE_ORDER = [
  "Legend",
  "Ancient",
  "Oracle",
  "Sage",
  "Veteran",
  "Sentinel",
  "Apprentice",
  "Watcher"
];
function pickHighestTitle(unlockedTitles) {
  for (const tier of TITLE_ORDER) {
    if (unlockedTitles.includes(tier))
      return tier;
  }
  return;
}
function applyAura(faceBlock, glyph) {
  if (!glyph)
    return faceBlock;
  const lines = faceBlock.split(`
`);
  if (lines.length === 0)
    return faceBlock;
  const width = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const pad = (line) => {
    const deficit = width - line.length;
    return deficit > 0 ? line + " ".repeat(deficit) : line;
  };
  const top = `${glyph}${" ".repeat(Math.max(0, width))}${glyph}`;
  const bottom = `${glyph}${" ".repeat(Math.max(0, width))}${glyph}`;
  const middle = lines.map((l) => ` ${pad(l)} `);
  return [top, ...middle, bottom].join(`
`);
}
async function runWrapper(options) {
  const innerPath = join10(options.basePath, "inner.txt");
  let stdout = "";
  if (!options.agent && existsSync6(innerPath)) {
    let innerCommand;
    try {
      innerCommand = (await readFile6(innerPath, "utf8")).trim();
    } catch (err) {
      await logError(options.basePath, `Failed to read inner.txt: ${err}`);
      return "";
    }
    if (!innerCommand) {
      await logError(options.basePath, "inner.txt is empty");
      return "";
    }
    try {
      const useReplay = typeof options.innerStdin === "string";
      const proc = Bun.spawn(["bash", "-c", innerCommand], {
        stdin: useReplay ? "pipe" : "inherit",
        stderr: "inherit",
        stdout: "pipe"
      });
      if (useReplay && proc.stdin) {
        proc.stdin.write(options.innerStdin);
        proc.stdin.end();
      }
      stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        await logError(options.basePath, `Inner command exited with code ${exitCode}`);
        return "";
      }
    } catch (err) {
      await logError(options.basePath, `Failed to spawn inner command: ${err}`);
      return "";
    }
  }
  return spliceFace(options, stdout);
}
async function spliceFace(options, stdout) {
  try {
    const cfg = await readConfig(options.basePath);
    const species = getSpecies(cfg.species);
    const projectState = options.projectBase ? await readState(options.projectBase) : null;
    const globalState = projectState === null ? await readState(options.basePath) : null;
    const state = projectState ?? globalState;
    const stateFresh = state !== null && !isStale(state);
    const mood = stateFresh ? state?.mood : "happy";
    const bubbleText = stateFresh ? state?.bubble_short : cfg.bubble;
    const bubbleColor = stateFresh ? severityToColor(state?.severity, cfg.bubbleColor) : cfg.bubbleColor;
    const termWidth = options.termWidth ?? (cfg.terminalWidth > 0 ? cfg.terminalWidth : detectTermWidth());
    const tasklistRaw = await readTasklist(options.cwd);
    const tasklistParsed = tasklistRaw ? parseTasklist(tasklistRaw) : null;
    const tasklistSeg = tasklistParsed ? colorize(formatTasklistSegment(tasklistParsed), "gray") : "";
    const appendSeg = (s) => tasklistSeg ? `${s.replace(/\n+$/, "")}
${tasklistSeg}` : s;
    if (cfg.minimalMode) {
      if (!bubbleText)
        return appendSeg(stdout);
      const bubbleBlock = buildBubbleBlock(bubbleText, bubbleColor, 0, termWidth);
      return appendSeg(`${stdout.replace(/\n+$/, "")}

${bubbleBlock}`);
    }
    const progression = await readProgression(options.basePath);
    const pose = stateFresh ? state?.pose : undefined;
    const art = resolveArt(species, mood, pose, progression.unlocked_poses ?? []);
    const titleLine = pickHighestTitle(progression.unlocked_titles ?? []);
    const rawFace = buildFaceBlock(art, cfg.name, formatProgressionLine(progression), titleLine);
    const auraGlyph = pickAuraGlyph(progression.level ?? 1);
    const face = applyAura(rawFace, auraGlyph);
    const faceWidth = widestLine(face);
    const inner = bubbleText ? `${stdout.replace(/\n+$/, "")}

${buildBubbleBlock(bubbleText, bubbleColor, faceWidth, termWidth)}` : stdout;
    return composeOutput({ face, inner: appendSeg(inner), termWidth });
  } catch (err) {
    await logError(options.basePath, `Face splice failed, falling through: ${err}`);
    return stdout;
  }
}
async function readStdinAll() {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
}
function resolveBunBinary(execPath, which) {
  if (execPath && execPath.length > 0)
    return execPath;
  return which("bun");
}
function resolveDaemonScript(hereDir) {
  if (basename(hereDir) === "dist") {
    return join10(hereDir, "siltpoke-daemon.js");
  }
  return join10(hereDir, "..", "cli", "daemon.ts");
}
function resolveDashboardCli(hereDir) {
  if (basename(hereDir) === "dist") {
    return join10(hereDir, "siltpoke-cli.js");
  }
  return join10(hereDir, "..", "cli", "plugin-cli.ts");
}
function resolveRestartField(which, scriptPath) {
  const bun = which("bun");
  if (!bun)
    return;
  return { bun, script: scriptPath };
}
function parseCwd(rawJson) {
  if (!rawJson)
    return;
  try {
    const parsed = JSON.parse(rawJson);
    const cwd = parsed?.cwd ?? parsed?.workspace?.current_dir;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
  } catch {
    return;
  }
}
function parseAgentFlag(argv) {
  const idx = argv.indexOf("--agent");
  if (idx === -1)
    return;
  const value = argv[idx + 1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function installFaultNet(basePath) {
  let caught = false;
  const net = (label, err) => {
    if (caught)
      return;
    caught = true;
    logError(basePath, `FATAL ${label}: ${err}`).finally(() => process.exit(0));
  };
  process.on("uncaughtException", (err) => net("uncaughtException", err));
  process.on("unhandledRejection", (reason) => net("unhandledRejection", reason));
}
if (import.meta.main) {
  const basePath = siltpokeRoot();
  installFaultNet(basePath);
  if (process.env.SILTPOKE_TEST_FAULT === "unhandled-rejection") {
    Promise.reject(new Error("test-injected unhandled rejection"));
  } else if (process.env.SILTPOKE_TEST_FAULT === "uncaught-exception") {
    setTimeout(() => {
      throw new Error("test-injected uncaught exception");
    }, 0);
  }
  if (process.env.SILTPOKE_TEST_FAULT) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (process.argv.includes("--menubar")) {
    try {
      const cfg = await readConfig(basePath);
      const reviews = await collectPendingReviews(basePath);
      const hereDir = dirname(fileURLToPath(import.meta.url));
      const daemonScript = resolveDaemonScript(hereDir);
      const dashboardCli = resolveDashboardCli(hereDir);
      const whichBun = (cmd) => {
        const r = spawnSync("which", [cmd], { encoding: "utf8" });
        const p = (r.stdout ?? "").trim();
        return p.length > 0 ? p : null;
      };
      const bunBinary = resolveBunBinary(process.execPath, whichBun);
      process.stdout.write(renderMenubar({
        name: cfg.name || "Siltpoke",
        emoji: getSpecies(cfg.species).menubarEmoji,
        reviews,
        dashboardUrl: "http://127.0.0.1:9876",
        nowMs: Date.now(),
        restart: resolveRestartField(() => bunBinary, daemonScript),
        restartOutcome: readRestartOutcome(basePath) ?? undefined,
        dashboard: bunBinary ? { bun: bunBinary, cli: dashboardCli } : undefined
      }));
    } catch (err) {
      await logError(basePath, `menubar mode failed: ${err}`);
      process.stdout.write(`\uD83D\uDFE2 Siltpoke
---
Open dashboard | href=http://127.0.0.1:9876
`);
    }
    process.exit(0);
  }
  try {
    const agent = parseAgentFlag(process.argv);
    const innerStdin = await readStdinAll();
    const cwd = parseCwd(innerStdin);
    const projectBase = cwd ? join10(cwd, ".siltpoke") : undefined;
    const output = await runWrapper({
      basePath,
      projectBase,
      innerStdin,
      agent,
      cwd
    });
    process.stdout.write(output);
    process.exit(0);
  } catch (err) {
    await logError(basePath, `FATAL wrapper crashed: ${err}`);
    process.exit(0);
  }
}
export {
  runWrapper,
  resolveRestartField,
  resolveDashboardCli,
  resolveDaemonScript,
  resolveBunBinary,
  readConfig,
  parseAgentFlag
};
