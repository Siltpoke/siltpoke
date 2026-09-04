// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, normalize, relative, resolve } from "node:path";

const CAPTURE_ID_RE = /^case1-[a-f0-9]+$/;

export function isCase1CaptureEnabled(
  config: { capture_case1?: boolean } | null | undefined,
  env: NodeJS.ProcessEnv | undefined,
): boolean {
  try {
    const flag = config?.capture_case1 === true;
    const e = env?.SILTPOKE_CAPTURE_CASE1;
    const envOn = e === "1" || e === "true";
    return flag && envOn;
  } catch {
    return false;
  }
}

export function newCaptureId(): string {
  return "case1-" + randomBytes(6).toString("hex");
}

export function isValidCaptureId(s: string): boolean {
  return typeof s === "string" && /^[A-Za-z0-9_-]+$/.test(s) && CAPTURE_ID_RE.test(s);
}

export function sanitizeTargetPath(cwd: string, file: string): string | null {
  try {
    if (typeof file !== "string" || file.length === 0) return null;
    if (isAbsolute(file)) return null;
    if (normalize(file).split(/[\\/]/).includes("..")) return null;
    const abs = resolve(cwd, file);
    const rel = relative(resolve(cwd), abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split("\\").join("/");
  } catch {
    return null;
  }
}

export function resolveCandidatePath(stateBase: string, capture_id: string, suffix: string): string | null {
  try {
    if (!isValidCaptureId(capture_id)) return null;
    const dir = resolve(stateBase, "case1-candidates");
    const p = resolve(dir, `${capture_id}.${suffix}`);
    const rel = relative(dir, p);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.includes("/")) return null;
    return p;
  } catch {
    return null;
  }
}

// --- Task 4: pure record assembly (no fs, no git, no network, no clock) ---

export interface FileSnapshot {
  path: string;
  content: string;
  truncated: boolean;
}

export interface AnchorFP {
  path: string;
  anchor_fingerprints: string[];
}

/**
 * A critique anchor as the capture layer stores it — spec §5's "anchors already
 * carry file/line/tool/fingerprint". `file` is the only field this module
 * sanitizes (repo-relative, never absolute/traversal); the other three come
 * pre-computed from critique-creation time and are carried verbatim.
 *
 * All but `file` are optional because a pre-record read back from disk may
 * predate this shape, and evidence-derived anchors are not guaranteed to carry
 * a resolvable line. Producers that DO have the full shape (the handle-stop
 * enqueue sites) are typed to require it — see `StampCase1Ctx.anchors`.
 */
export interface CritiqueAnchor {
  file: string;
  line?: number;
  tool?: string;
  fingerprint?: string;
}

/** The ONE anchor the oracle confirmed fixed (spec §5) — file AND which line. */
export interface VerifiedAnchor {
  file: string;
  line?: number;
  fingerprint?: string;
  verdict_tier?: 1 | 2;
}

export interface Case1Inputs {
  capture_id: string;
  critique_id: string;
  session_id: string;
  cwd: string;
  created_at: string;
  finalized_at: string;
  before: FileSnapshot[];
  after: { head_sha: string | null; worktree_dirty: boolean; files: FileSnapshot[] };
  anchorFps: AnchorFP[];
  critique: { finding_text: string; severity: string; anchors: CritiqueAnchor[] };
  verified_anchor: VerifiedAnchor;
  rule: { id: string; text: string; category: string };
}

const SCHEMA_VERSION = 1;

export function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

export function snapshotDiff(
  before: FileSnapshot[],
  after: FileSnapshot[],
): Array<{ path: string; change: "added" | "removed" | "modified" | "unchanged" }> {
  const beforeByPath = new Map(before.map((f) => [f.path, f]));
  const afterByPath = new Map(after.map((f) => [f.path, f]));
  const paths = new Set<string>([...beforeByPath.keys(), ...afterByPath.keys()]);
  const result: Array<{ path: string; change: "added" | "removed" | "modified" | "unchanged" }> = [];
  for (const path of paths) {
    const b = beforeByPath.get(path);
    const a = afterByPath.get(path);
    let change: "added" | "removed" | "modified" | "unchanged";
    if (!b && a) change = "added";
    else if (b && !a) change = "removed";
    else if (b && a && b.content !== a.content) change = "modified";
    else change = "unchanged";
    result.push({ path, change });
  }
  return result;
}

export function buildCandidateRecords(i: Case1Inputs): { public: object; private: object } {
  const anchorFpByPath = new Map(i.anchorFps.map((a) => [a.path, a.anchor_fingerprints]));
  const beforeFiles = i.before.map((f) => ({
    path: f.path,
    content: f.content,
    truncated: f.truncated,
    anchor_fingerprints: anchorFpByPath.get(f.path) ?? [],
  }));
  const afterFiles = i.after.files.map((f) => ({
    path: f.path,
    content: f.content,
    truncated: f.truncated,
  }));

  const anyTruncated = i.before.some((f) => f.truncated) || i.after.files.some((f) => f.truncated);
  const multi_file_unverified = i.before.length > 1;
  const admissible_for_reconstruction = !anyTruncated && !multi_file_unverified;

  const pub = {
    schema_version: SCHEMA_VERSION,
    capture_id: i.capture_id,
    critique_id: i.critique_id,
    status: "raw" as const,
    created_at: i.created_at,
    finalized_at: i.finalized_at,
    project_hash: projectHash(i.cwd),
    before: { files: beforeFiles },
    after: {
      head_sha: i.after.head_sha,
      worktree_dirty: i.after.worktree_dirty,
      files: afterFiles,
    },
    // spec §5: `fix.changed_files` is the per-file CHANGED set (added/removed/
    // modified) — `snapshotDiff` itself reports every path incl. "unchanged"
    // (its own unit tests rely on that), so filter here at the assembly site.
    fix: { changed_files: snapshotDiff(i.before, i.after.files).filter((f) => f.change !== "unchanged") },
    critique: {
      finding_text: i.critique.finding_text,
      severity: i.critique.severity,
      anchors: i.critique.anchors,
    },
    // Which line, not just which file — a downstream step must be able to check
    // that THIS flagged line vanished (its fingerprint is the key into
    // `before.files[].anchor_fingerprints`). Fields absent upstream stay absent
    // rather than serializing as explicit nulls.
    verified_anchor: {
      file: i.verified_anchor.file,
      ...(i.verified_anchor.line !== undefined ? { line: i.verified_anchor.line } : {}),
      ...(i.verified_anchor.fingerprint ? { fingerprint: i.verified_anchor.fingerprint } : {}),
      verdict_tier: i.verified_anchor.verdict_tier,
    },
    multi_file_unverified,
    provenance: { captured_after_may_include_later_edits: true as const },
    admissible_for_reconstruction,
    classification: {
      archetype: null as null,
      material: null as null,
      admissible: null as null,
      blind_discoverable: null as null,
    },
  };

  const pri = {
    schema_version: SCHEMA_VERSION,
    capture_id: i.capture_id,
    critique_id: i.critique_id,
    session_id: i.session_id,
    cwd: i.cwd,
    rule: { id: i.rule.id, text: i.rule.text, category: i.rule.category },
    write_outcome: "appended" as const,
  };

  return { public: pub, private: pri };
}

// --- Task 5: Phase 1 captureCase1Pre (defect snapshot, injected deps) ---

export interface CaptureDeps {
  readFileCapped: (absPath: string, byteCap: number) => Promise<{ content: string; truncated: boolean } | null>;
  /**
   * Callers pass the SANITIZED (repo-relative) anchor set — never raw/absolute
   * paths — carrying each anchor's critique-time `line`/`fingerprint`, so the
   * implementation can return the FLAGGED lines' hashes for `relPath` rather
   * than an undifferentiated whole-file set.
   */
  fingerprintsFor: (relPath: string, content: string, anchors: CritiqueAnchor[]) => string[];
  writeAtomic: (path: string, data: string) => Promise<void>;
  now: () => Date;
  deadlineMs?: number;
  byteCap?: number;
  fileCap?: number;
}

export interface PreInput {
  critique_id: string;
  session_id: string;
  cwd: string;
  stateBase: string;
  finding_text: string;
  severity: string;
  anchors: CritiqueAnchor[];
  evidenceFiles: string[];
}

const DEFAULT_PRE_BYTE_CAP = 200_000;
const DEFAULT_PRE_FILE_CAP = 20;

export async function captureCase1Pre(
  input: PreInput,
  config: { capture_case1?: boolean } | null | undefined,
  env: NodeJS.ProcessEnv | undefined,
  deps: CaptureDeps,
): Promise<string | undefined> {
  try {
    if (!isCase1CaptureEnabled(config, env)) return undefined;

    const byteCap = deps.byteCap ?? DEFAULT_PRE_BYTE_CAP;
    const fileCap = deps.fileCap ?? DEFAULT_PRE_FILE_CAP;

    // Sanitize the anchors we'll store — never let an absolute/traversal path
    // reach the persisted record, even if the caller handed us junk. An anchor
    // whose path is unsafe is dropped WHOLE (fingerprint included).
    //
    // `file` is the only field sanitized: `line`/`tool`/`fingerprint` were
    // computed at critique-creation and are carried verbatim, so the record can
    // name the specific flagged line (spec §5). Fields are copied explicitly —
    // never spread — so nothing unvetted rides along, and absent fields stay
    // absent instead of serializing as explicit nulls.
    const sanitizedAnchors: CritiqueAnchor[] = [];
    for (const a of input.anchors ?? []) {
      const safeAnchor = sanitizeTargetPath(input.cwd, a?.file);
      if (safeAnchor === null) continue;
      sanitizedAnchors.push({
        file: safeAnchor,
        ...(typeof a?.line === "number" ? { line: a.line } : {}),
        ...(typeof a?.tool === "string" && a.tool.length > 0 ? { tool: a.tool } : {}),
        ...(typeof a?.fingerprint === "string" && a.fingerprint.length > 0
          ? { fingerprint: a.fingerprint }
          : {}),
      });
    }

    // Target files = dedupe(anchor files ∪ evidenceFiles), each sanitized;
    // anything unsafe (absolute / traversal / outside cwd) is dropped.
    const rawCandidates = [...(input.anchors ?? []).map((a) => a?.file), ...(input.evidenceFiles ?? [])];
    const safeTargets: string[] = [];
    const seen = new Set<string>();
    for (const f of rawCandidates) {
      const safe = sanitizeTargetPath(input.cwd, f);
      if (safe === null || seen.has(safe)) continue;
      seen.add(safe);
      safeTargets.push(safe);
    }
    if (safeTargets.length === 0) return undefined;

    const capped = safeTargets.slice(0, fileCap);
    const startTime = deps.now().getTime();

    const files: FileSnapshot[] = [];
    const anchorFps: AnchorFP[] = [];

    for (const relPath of capped) {
      if (deps.deadlineMs !== undefined) {
        const elapsed = deps.now().getTime() - startTime;
        if (elapsed >= deps.deadlineMs) break; // stop STARTING new reads past the deadline
      }
      const absPath = resolve(input.cwd, relPath);
      const result = await deps.readFileCapped(absPath, byteCap);
      if (result === null) continue;
      files.push({ path: relPath, content: result.content, truncated: result.truncated });
      const fps = deps.fingerprintsFor(relPath, result.content, sanitizedAnchors);
      anchorFps.push({ path: relPath, anchor_fingerprints: fps });
    }

    if (files.length === 0) return undefined;

    const capture_id = newCaptureId();
    const targetPath = resolveCandidatePath(input.stateBase, capture_id, "pre.json");
    if (targetPath === null) return undefined;

    const record = {
      schema_version: SCHEMA_VERSION,
      capture_id,
      critique_id: input.critique_id,
      session_id: input.session_id,
      cwd: input.cwd,
      phase: "pre" as const,
      created_at: deps.now().toISOString(),
      before: { files },
      anchorFps,
      critique: {
        finding_text: input.finding_text,
        severity: input.severity,
        anchors: sanitizedAnchors,
      },
    };

    await deps.writeAtomic(targetPath, JSON.stringify(record));
    return capture_id;
  } catch {
    return undefined;
  }
}

// --- Task 6: Phase 2 finalizeCase1 (fix snapshot + rule linkage, injected deps) ---

export interface FinalizeDeps extends CaptureDeps {
  /** Loads the pre.json record at the given (already-validated) path, or null if missing/corrupt. */
  readPre: (path: string) => Promise<any | null>;
  /** killable-timeout `git rev-parse HEAD` in cwd; null on any git/timeout failure. */
  headSha: (cwd: string) => Promise<string | null>;
  /** killable-timeout `git status` in cwd; true if the worktree has uncommitted changes. */
  worktreeDirty: (cwd: string) => Promise<boolean>;
  deleteFile: (path: string) => Promise<void>;
}

export interface FinalizeArgs {
  capture_id: string;
  cwd: string;
  stateBase: string;
  rule: { id: string; text: string; category: string };
  verified_anchor: VerifiedAnchor;
}

export async function finalizeCase1(
  args: FinalizeArgs,
  config: { capture_case1?: boolean } | null | undefined,
  env: NodeJS.ProcessEnv | undefined,
  deps: FinalizeDeps,
): Promise<"finalized" | "skipped"> {
  try {
    if (!isCase1CaptureEnabled(config, env)) return "skipped";

    const prePath = resolveCandidatePath(args.stateBase, args.capture_id, "pre.json");
    if (prePath === null) return "skipped";

    const pre = await deps.readPre(prePath);
    if (pre === null || pre === undefined || typeof pre !== "object") return "skipped";

    // cwd source-of-truth: the capture-time cwd (pre.cwd) is authoritative — it's the tree
    // the "before" snapshot was actually read from. If the caller's cwd at finalize time
    // diverges (worktree moved, CI runner, distil-worker against a fresh clone), re-reading
    // "after" files against args.cwd while attributing the record to pre.cwd (or vice versa)
    // would silently produce a mismatched/corrupt record. Fail-soft: skip instead.
    // Compare `resolve()`-normalized forms (pure, no fs/realpath call) so a cosmetic
    // difference — trailing slash, relative-vs-absolute, `.`/`..` segments — doesn't
    // trip the guard; a genuinely different root still resolves to a different path
    // and still skips.
    if (typeof pre.cwd !== "string" || pre.cwd.length === 0) return "skipped";
    if (resolve(pre.cwd) !== resolve(args.cwd)) return "skipped";
    const cwd = pre.cwd;

    const beforeFiles: FileSnapshot[] = Array.isArray(pre.before?.files) ? pre.before.files : [];
    const anchorFps: AnchorFP[] = Array.isArray(pre.anchorFps) ? pre.anchorFps : [];

    // Re-read the SAME files (by the pre-captured path list) to snapshot the fix (after) state.
    const byteCap = deps.byteCap ?? DEFAULT_PRE_BYTE_CAP;
    const afterFiles: FileSnapshot[] = [];
    for (const f of beforeFiles) {
      const absPath = resolve(cwd, f.path);
      const result = await deps.readFileCapped(absPath, byteCap);
      if (result === null) continue;
      afterFiles.push({ path: f.path, content: result.content, truncated: result.truncated });
    }

    const head_sha = await deps.headSha(cwd);
    const worktree_dirty = await deps.worktreeDirty(cwd);

    const inputs: Case1Inputs = {
      capture_id: args.capture_id,
      critique_id: pre.critique_id,
      session_id: pre.session_id,
      cwd,
      created_at: pre.created_at,
      finalized_at: deps.now().toISOString(),
      before: beforeFiles,
      after: { head_sha, worktree_dirty, files: afterFiles },
      anchorFps,
      critique: pre.critique ?? { finding_text: "", severity: "", anchors: [] },
      verified_anchor: args.verified_anchor,
      rule: args.rule,
    };

    const { public: pub, private: pri } = buildCandidateRecords(inputs);

    const publicPath = resolveCandidatePath(args.stateBase, args.capture_id, "public.json");
    const privatePath = resolveCandidatePath(args.stateBase, args.capture_id, "provenance-private.json");
    if (publicPath === null || privatePath === null) return "skipped";

    await deps.writeAtomic(publicPath, JSON.stringify(pub));
    await deps.writeAtomic(privatePath, JSON.stringify(pri));

    // Only delete the pre-snapshot once both finalized records are safely written.
    await deps.deleteFile(prePath);

    return "finalized";
  } catch {
    return "skipped";
  }
}

// --- Task 10: orphan GC (housekeeping, never a gate — spec §8) ---

const PRE_SUFFIX = ".pre.json";

export interface GcOpts {
  now: Date;
  maxAgeMs: number;
  /** capture_ids whose critique is still in the pending queue — their `.pre.json` must survive. */
  livePendingIds: Set<string>;
}

export interface GcDeps {
  /** Lists filenames (not full paths) present in the given candidates dir. */
  listPre: (dir: string) => Promise<string[]>;
  /** mtime (epoch ms) of the file at the given absolute path. */
  statMtime: (path: string) => Promise<number>;
  deleteFile: (path: string) => Promise<void>;
}

/**
 * Prunes stale, orphaned `.pre.json` pre-candidates from `<stateBase>/case1-candidates/`.
 * A pre is deleted ONLY when it is BOTH older than `maxAgeMs` AND its `capture_id` is NOT in
 * `livePendingIds` (the critique is still pending → its pre must never be deleted, no matter
 * how old). Never throws — the whole body is guarded so a listing/stat/delete failure just
 * returns the count of files successfully deleted before the failure (fail-soft housekeeping,
 * never allowed to affect the caller's sweep accounting).
 */
export async function gcCase1Candidates(
  stateBase: string,
  opts: GcOpts,
  deps: GcDeps,
): Promise<number> {
  let deletedCount = 0;
  try {
    const dir = resolve(stateBase, "case1-candidates");
    const names = await deps.listPre(dir);
    const cutoff = opts.now.getTime() - opts.maxAgeMs;

    for (const name of names) {
      if (!name.endsWith(PRE_SUFFIX)) continue;
      const capture_id = name.slice(0, -PRE_SUFFIX.length);
      if (!isValidCaptureId(capture_id)) continue; // never delete an unparseable filename
      if (opts.livePendingIds.has(capture_id)) continue; // still pending — never delete

      const path = resolve(dir, name);
      const mtime = await deps.statMtime(path);
      if (mtime < cutoff) {
        await deps.deleteFile(path);
        deletedCount++;
      }
    }
  } catch {
    // fail-soft: return whatever was deleted before the failure
  }
  return deletedCount;
}
