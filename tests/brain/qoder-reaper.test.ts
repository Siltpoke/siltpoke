// Best-effort session reaper for qoder (`qodercli -p`) reviewer calls
// (CcForkReviewerProvider track — qoder session-reaper deferred item).
// SAFETY-CRITICAL: every test here operates on a SYNTHETIC temp dir — NEVER
// the real `~/.qoder/projects/` tree. The reaper must only ever delete a
// session whose id is in the siltpoke-owned registry; anything else (the
// user's own qoder work) must survive untouched. See src/brain/qoder-reaper.ts
// for the full safety design and an internal design note
// spike-notes.md §Step 4 for the spike finding this implements.
import { describe, test, expect, beforeEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordQoderSession,
  reapQoderSessions,
  extractQoderSessionId,
  type QoderReviewerSessionRecord,
} from "../../src/brain/qoder-reaper";

// A realistic qoder `-p --output-format json` envelope (single result object,
// spike Step 2) carrying the session_id our own call created.
const qoderEnvelope = (sessionId: string): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: '{"mood":"happy"}',
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    uuid: "41785915-6e40-4adf-b8b2-42e0d326b35e",
    session_id: sessionId,
  });

// Canonical UUIDs for sessions (the reaper only acts on UUID-shaped ids).
const S1 = "11111111-1111-1111-1111-111111111111";
const S2 = "22222222-2222-2222-2222-222222222222";
const S3 = "33333333-3333-3333-3333-333333333333";
const S4 = "44444444-4444-4444-4444-444444444444";
const S5 = "55555555-5555-5555-5555-555555555555";
const U1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** Creates a qoder session on disk under projects/<projectKey>/: the
 * `<id>.jsonl` transcript + the `<id>/state.json` sidecar state dir. */
function writeSession(
  projectsDir: string,
  projectKey: string,
  id: string,
): void {
  const dir = join(projectsDir, projectKey);
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "fake-transcript-jsonl\n");
  writeFileSync(join(dir, id, "state.json"), '{"sessionId":"x"}');
}

function sessionExists(
  projectsDir: string,
  projectKey: string,
  id: string,
): boolean {
  return (
    existsSync(join(projectsDir, projectKey, `${id}.jsonl`)) ||
    existsSync(join(projectsDir, projectKey, id))
  );
}

function writeRegistry(
  registryPath: string,
  records: QoderReviewerSessionRecord[],
): void {
  mkdirSync(join(registryPath, ".."), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(records));
}

describe("reapQoderSessions — safety-critical: only registry ids are ever deleted", () => {
  let root: string;
  let projectsDir: string;
  let registryPath: string;
  const KEY = "-Users-dev-repo";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qoder-reaper-"));
    projectsDir = join(root, "projects");
    mkdirSync(projectsDir, { recursive: true });
    registryPath = join(root, "qoder-reviewer-sessions.json");
  });

  test("keeps exactly the K newest siltpoke-registry ids, reaps the rest (jsonl + state dir)", () => {
    const ids = [S1, S2, S3, S4, S5];
    const records: QoderReviewerSessionRecord[] = ids.map((id, i) => ({
      id,
      recordedAt: 1000 + i,
    }));
    for (const id of ids) writeSession(projectsDir, KEY, id);
    writeRegistry(registryPath, records);

    // keepLast 2, min-age 0 so the age gate never intervenes for this test.
    reapQoderSessions({ projectsDir, registryPath, keepLast: 2, olderThanMs: 0 });

    // Oldest 3 (S1,S2,S3) reaped — both the .jsonl AND the state dir; newest 2 survive.
    expect(sessionExists(projectsDir, KEY, S1)).toBe(false);
    expect(sessionExists(projectsDir, KEY, S2)).toBe(false);
    expect(sessionExists(projectsDir, KEY, S3)).toBe(false);
    expect(existsSync(join(projectsDir, KEY, S1))).toBe(false); // state dir gone
    expect(existsSync(join(projectsDir, KEY, `${S1}.jsonl`))).toBe(false);
    expect(sessionExists(projectsDir, KEY, S4)).toBe(true);
    expect(sessionExists(projectsDir, KEY, S5)).toBe(true);

    const updated = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as QoderReviewerSessionRecord[];
    expect(updated.map((r) => r.id).sort()).toEqual([S4, S5]);
  });

  test("SAFETY: never touches a session whose id is absent from the registry (the user's own qoder sessions)", () => {
    // Only S1 is siltpoke-owned and old; U1/U2 are the user's own qoder
    // sessions — NOT in the registry, though they sit in the exact same
    // project dir.
    const records: QoderReviewerSessionRecord[] = [{ id: S1, recordedAt: 1000 }];
    writeSession(projectsDir, KEY, S1);
    writeSession(projectsDir, KEY, U1);
    writeSession(projectsDir, KEY, U2);
    writeRegistry(registryPath, records);

    // keepLast 0 + min-age 0 forces even the lone siltpoke id to be reaped —
    // proving the user files survive not because of retention headroom, but
    // because they were never eligible at all (registry membership is the gate).
    reapQoderSessions({ projectsDir, registryPath, keepLast: 0, olderThanMs: 0 });

    expect(sessionExists(projectsDir, KEY, S1)).toBe(false);
    expect(sessionExists(projectsDir, KEY, U1)).toBe(true);
    expect(sessionExists(projectsDir, KEY, U2)).toBe(true);
  });

  test("SAFETY: never touches paths outside projects/ even when a same-named file sits there", () => {
    // A decoy `<id>.jsonl` sitting OUTSIDE projects/ (a sibling of it, under
    // the qoder home root) must be immune — the reaper only ever scans the
    // children of projects/.
    const records: QoderReviewerSessionRecord[] = [{ id: S1, recordedAt: 1000 }];
    writeSession(projectsDir, KEY, S1); // the real, reap-eligible one
    const outsideJsonl = join(root, `${S1}.jsonl`); // sibling of projects/
    writeFileSync(outsideJsonl, "OUTSIDE-projects-must-survive");
    writeRegistry(registryPath, records);

    reapQoderSessions({ projectsDir, registryPath, keepLast: 0, olderThanMs: 0 });

    expect(sessionExists(projectsDir, KEY, S1)).toBe(false); // in-projects reaped
    expect(existsSync(outsideJsonl)).toBe(true); // outside untouched
  });

  test("locates the session by scan regardless of which cwd-key subdir holds it", () => {
    // The registry stores only the id; the reaper finds it by scanning ALL
    // project subdirs — so a session under an arbitrary cwd-key is still found.
    const OTHER_KEY = "-private-tmp-some-other-repo";
    const records: QoderReviewerSessionRecord[] = [{ id: S1, recordedAt: 1000 }];
    writeSession(projectsDir, OTHER_KEY, S1);
    writeRegistry(registryPath, records);

    reapQoderSessions({ projectsDir, registryPath, keepLast: 0, olderThanMs: 0 });

    expect(sessionExists(projectsDir, OTHER_KEY, S1)).toBe(false);
  });

  test("registry with fewer entries than keepLast: no-op, nothing reaped", () => {
    const records: QoderReviewerSessionRecord[] = [
      { id: S1, recordedAt: 1000 },
      { id: S2, recordedAt: 1001 },
    ];
    writeSession(projectsDir, KEY, S1);
    writeSession(projectsDir, KEY, S2);
    writeRegistry(registryPath, records);

    reapQoderSessions({ projectsDir, registryPath, keepLast: 10 });

    expect(sessionExists(projectsDir, KEY, S1)).toBe(true);
    expect(sessionExists(projectsDir, KEY, S2)).toBe(true);
  });

  test("AGE GATE: a <24h-old (active-window) beyond-keep session is NOT reaped", () => {
    const now = 10_000_000;
    const records: QoderReviewerSessionRecord[] = [
      { id: S2, recordedAt: now - 48 * 60 * 60 * 1000 }, // 48h old -> reap
      { id: S1, recordedAt: now - 60 * 1000 }, // 1min old -> protected
      { id: S3, recordedAt: now - 5 * 1000 }, // newest -> kept by retention
    ];
    for (const r of records) writeSession(projectsDir, KEY, r.id);
    writeRegistry(registryPath, records);

    reapQoderSessions({
      projectsDir,
      registryPath,
      keepLast: 1,
      olderThanMs: 24 * 60 * 60 * 1000,
      now,
    });

    expect(sessionExists(projectsDir, KEY, S3)).toBe(true); // retention
    expect(sessionExists(projectsDir, KEY, S1)).toBe(true); // too young
    expect(sessionExists(projectsDir, KEY, S2)).toBe(false); // 48h old -> reaped

    const survivors = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as QoderReviewerSessionRecord[];
    expect(survivors.map((r) => r.id).sort()).toEqual([S1, S3]);
  });

  test("AGE GATE: when every beyond-keep entry is too young, nothing is reaped and the registry is left as-is", () => {
    const now = 10_000_000;
    const records: QoderReviewerSessionRecord[] = [
      { id: S1, recordedAt: now - 3000 },
      { id: S2, recordedAt: now - 2000 },
      { id: S3, recordedAt: now - 1000 },
    ];
    for (const r of records) writeSession(projectsDir, KEY, r.id);
    writeRegistry(registryPath, records);

    reapQoderSessions({
      projectsDir,
      registryPath,
      keepLast: 1,
      olderThanMs: 24 * 60 * 60 * 1000,
      now,
    });

    expect(sessionExists(projectsDir, KEY, S1)).toBe(true);
    expect(sessionExists(projectsDir, KEY, S2)).toBe(true);
    expect(sessionExists(projectsDir, KEY, S3)).toBe(true);
  });

  test("defends against a malformed (non-UUID) registry id — never builds a wider match", () => {
    // A hostile/corrupt id must never be used to construct a delete path.
    const records = [
      { id: "..", recordedAt: 1000 },
      { id: "", recordedAt: 1001 },
    ] as QoderReviewerSessionRecord[];
    writeSession(projectsDir, KEY, U1); // a user session that must survive
    writeRegistry(registryPath, records);

    expect(() =>
      reapQoderSessions({ projectsDir, registryPath, keepLast: 0, olderThanMs: 0 }),
    ).not.toThrow();
    expect(sessionExists(projectsDir, KEY, U1)).toBe(true);
    // The KEY project dir itself must survive (no traversal delete).
    expect(existsSync(join(projectsDir, KEY))).toBe(true);
  });

  test("best-effort: missing projects dir is swallowed, never throws", () => {
    const records: QoderReviewerSessionRecord[] = [
      { id: S1, recordedAt: 1000 },
      { id: S2, recordedAt: 1001 },
      { id: S3, recordedAt: 1002 },
    ];
    writeRegistry(registryPath, records);
    const missingDir = join(root, "does-not-exist");

    expect(() =>
      reapQoderSessions({
        projectsDir: missingDir,
        registryPath,
        keepLast: 1,
        olderThanMs: 0,
      }),
    ).not.toThrow();
  });

  test("best-effort: missing registry file is swallowed, never throws, and no files are touched", () => {
    writeSession(projectsDir, KEY, U1);
    const missingRegistry = join(root, "no-registry.json");

    expect(() =>
      reapQoderSessions({
        projectsDir,
        registryPath: missingRegistry,
        keepLast: 1,
      }),
    ).not.toThrow();
    expect(sessionExists(projectsDir, KEY, U1)).toBe(true);
  });

  test("best-effort: malformed registry JSON is swallowed, never throws, and no files are touched", () => {
    writeSession(projectsDir, KEY, U1);
    mkdirSync(join(registryPath, ".."), { recursive: true });
    writeFileSync(registryPath, "{ not valid json ][");

    expect(() =>
      reapQoderSessions({ projectsDir, registryPath, keepLast: 1 }),
    ).not.toThrow();
    expect(sessionExists(projectsDir, KEY, U1)).toBe(true);
  });

  test("uses DEFAULT_KEEP_LAST (10) when keepLast is omitted", () => {
    // 12 distinct canonical uuids, oldest first, all created before the age gate.
    const ids = Array.from(
      { length: 12 },
      (_, i) => `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`,
    );
    const records: QoderReviewerSessionRecord[] = ids.map((id, i) => ({
      id,
      recordedAt: 1000 + i,
    }));
    for (const id of ids) writeSession(projectsDir, KEY, id);
    writeRegistry(registryPath, records);

    // olderThanMs 0 so the default keepLast (10) is what's exercised, not the age gate.
    reapQoderSessions({ projectsDir, registryPath, olderThanMs: 0 });

    // 12 entries, default keepLast=10 -> oldest 2 reaped.
    expect(sessionExists(projectsDir, KEY, ids[0] ?? "")).toBe(false);
    expect(sessionExists(projectsDir, KEY, ids[1] ?? "")).toBe(false);
    expect(sessionExists(projectsDir, KEY, ids[2] ?? "")).toBe(true);
    expect(sessionExists(projectsDir, KEY, ids[11] ?? "")).toBe(true);
  });
});

describe("recordQoderSession — reads OUR call's own envelope session_id, appends to siltpoke registry", () => {
  let root: string;
  let homeBase: string;
  let registryPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qoder-record-"));
    homeBase = join(root, "siltpoke-home");
    mkdirSync(homeBase, { recursive: true });
    registryPath = join(homeBase, "qoder-reviewer-sessions.json");
  });

  test("appends the session_id parsed from OUR envelope to a fresh registry", () => {
    recordQoderSession({ stdout: qoderEnvelope(S1), homeBase });

    const registry = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as QoderReviewerSessionRecord[];
    expect(registry).toHaveLength(1);
    expect(registry[0]?.id).toBe(S1);
    expect(typeof registry[0]?.recordedAt).toBe("number");
  });

  test("appends to an EXISTING registry without clobbering prior entries", () => {
    writeFileSync(registryPath, JSON.stringify([{ id: S1, recordedAt: 1 }]));

    recordQoderSession({ stdout: qoderEnvelope(S2), homeBase });

    const registry = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as QoderReviewerSessionRecord[];
    expect(registry.map((r) => r.id)).toEqual([S1, S2]);
  });

  test("dedupes a back-to-back duplicate of the newest entry (never double-records one call)", () => {
    recordQoderSession({ stdout: qoderEnvelope(S1), homeBase });
    recordQoderSession({ stdout: qoderEnvelope(S1), homeBase });

    const registry = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as QoderReviewerSessionRecord[];
    expect(registry.map((r) => r.id)).toEqual([S1]);
  });

  test("no-ops when the envelope carries no session_id (never invents one)", () => {
    recordQoderSession({
      stdout: JSON.stringify({ type: "result", is_error: false, result: "x" }),
      homeBase,
    });
    expect(existsSync(registryPath)).toBe(false);
  });

  test("best-effort: unparseable stdout (bad-flag ANSI text) is swallowed, never throws, registry untouched", () => {
    expect(() =>
      recordQoderSession({
        stdout: "\x1b[31mInvalid model \"NoSuchModel\".\x1b[0m",
        homeBase,
      }),
    ).not.toThrow();
    expect(existsSync(registryPath)).toBe(false);
  });

  test("best-effort: omitted/empty stdout is swallowed, never throws", () => {
    expect(() => recordQoderSession({ homeBase })).not.toThrow();
    expect(() => recordQoderSession({ stdout: "", homeBase })).not.toThrow();
    expect(existsSync(registryPath)).toBe(false);
  });
});

describe("extractQoderSessionId — single-object (qoder) + array-of-events (codebuddy-shaped) + defensive", () => {
  test("reads session_id from a single result object (qoder shape)", () => {
    expect(extractQoderSessionId(qoderEnvelope(S1))).toBe(S1);
  });

  test("reads session_id from the terminal result event of an array (codebuddy shape)", () => {
    const arr = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "assistant", message: {} },
      { type: "result", is_error: false, result: "x", session_id: S2 },
    ]);
    expect(extractQoderSessionId(arr)).toBe(S2);
  });

  test("returns undefined for non-JSON stdout", () => {
    expect(extractQoderSessionId("not json at all")).toBeUndefined();
  });

  test("returns undefined when no session_id field is present", () => {
    expect(
      extractQoderSessionId(JSON.stringify({ type: "result", result: "x" })),
    ).toBeUndefined();
  });

  test("returns undefined for an empty-string session_id (never records a blank id)", () => {
    expect(
      extractQoderSessionId(
        JSON.stringify({ type: "result", session_id: "" }),
      ),
    ).toBeUndefined();
  });
});
