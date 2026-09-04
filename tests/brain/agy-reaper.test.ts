// Best-effort SQLite-conversation reaper for agy reviewer calls (Task 8,
// AgyBrainProvider track). SAFETY-CRITICAL: every test here operates on a
// SYNTHETIC temp dir — NEVER the real `~/.gemini/antigravity-cli/` tree.
// The reaper must only ever delete `.db` files whose conversation id is in
// the siltpoke-owned registry; anything else (the user's own agy work) must
// survive untouched. See src/brain/agy-reaper.ts for the full safety design
// and an internal design note §(c) for the spike
// finding this implements.
import { describe, test, expect, beforeEach } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordAgyConversation,
  reapAgyConversations,
  extractConversationIdFromLog,
  type AgyReviewerConversationRecord,
} from "../../src/brain/agy-reaper";
import { resolveAntigravityHome } from "../../src/installer/paths";

function writeConversationDb(conversationsDir: string, id: string): void {
  writeFileSync(join(conversationsDir, `${id}.db`), "fake-sqlite-bytes");
}

function writeRegistry(
  registryPath: string,
  records: AgyReviewerConversationRecord[],
): void {
  mkdirSync(join(registryPath, ".."), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(records));
}

// Canonical UUIDs for conversations (the reaper only acts on UUID-shaped
// ids — security-audit finding 3 — so fixtures must use realistic ids, the
// same discipline qoder-reaper.test.ts uses for its S1-S5/U1-U3 constants).
const S1 = "11111111-1111-1111-1111-111111111111";
const S2 = "22222222-2222-2222-2222-222222222222";
const S3 = "33333333-3333-3333-3333-333333333333";
const S4 = "44444444-4444-4444-4444-444444444444";
const S5 = "55555555-5555-5555-5555-555555555555";
const U1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const U2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const U3 = "cccccccc-cccc-cccc-cccc-cccccccccccc";
/** Deterministic distinct UUID for index i (used by the 12-entry fixture). */
const uuidFor = (i: number): string =>
  `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;

describe("reapAgyConversations — safety-critical: only registry ids are ever deleted", () => {
  let root: string;
  let conversationsDir: string;
  let registryPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agy-reaper-"));
    conversationsDir = join(root, "conversations");
    mkdirSync(conversationsDir, { recursive: true });
    registryPath = join(root, "agy-reviewer-conversations.json");
  });

  test("keeps exactly the K newest siltpoke-registry ids, reaps the rest", () => {
    // 5 siltpoke-owned conversations, staggered recordedAt.
    const siltpokeIds = [S1, S2, S3, S4, S5];
    const records: AgyReviewerConversationRecord[] = siltpokeIds.map(
      (id, i) => ({ id, recordedAt: 1000 + i }),
    );
    for (const id of siltpokeIds) writeConversationDb(conversationsDir, id);
    writeRegistry(registryPath, records);

    reapAgyConversations({ conversationsDir, registryPath, keepLast: 2 });

    // Oldest 3 (S1, S2, S3) reaped; newest 2 (S4, S5) survive.
    expect(existsSync(join(conversationsDir, `${S1}.db`))).toBe(false);
    expect(existsSync(join(conversationsDir, `${S2}.db`))).toBe(false);
    expect(existsSync(join(conversationsDir, `${S3}.db`))).toBe(false);
    expect(existsSync(join(conversationsDir, `${S4}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${S5}.db`))).toBe(true);

    const updatedRegistry = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as AgyReviewerConversationRecord[];
    expect(updatedRegistry.map((r) => r.id).sort()).toEqual([S4, S5].sort());
  });

  test("SAFETY: never touches a .db file whose id is absent from the registry (the user's own conversations)", () => {
    // Only S1 is siltpoke-owned and old; U1/U2/U3 are the user's own agy
    // conversations — NOT in the registry at all, even though their files
    // sit in the exact same directory.
    const records: AgyReviewerConversationRecord[] = [
      { id: S1, recordedAt: 1000 },
    ];
    writeConversationDb(conversationsDir, S1);
    writeConversationDb(conversationsDir, U1);
    writeConversationDb(conversationsDir, U2);
    writeConversationDb(conversationsDir, U3);
    writeRegistry(registryPath, records);

    // keepLast: 0 forces even the lone siltpoke id to be reaped — proving
    // the user files survive not because of retention headroom, but because
    // they were never eligible for deletion at all (registry membership is
    // the only gate).
    reapAgyConversations({ conversationsDir, registryPath, keepLast: 0 });

    expect(existsSync(join(conversationsDir, `${S1}.db`))).toBe(false);
    expect(existsSync(join(conversationsDir, `${U1}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${U2}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${U3}.db`))).toBe(true);
  });

  test("deletes -shm/-wal sidecars alongside the reaped .db", () => {
    const records: AgyReviewerConversationRecord[] = [
      { id: S1, recordedAt: 1000 },
    ];
    writeConversationDb(conversationsDir, S1);
    writeFileSync(join(conversationsDir, `${S1}.db-shm`), "shm");
    writeFileSync(join(conversationsDir, `${S1}.db-wal`), "wal");
    writeRegistry(registryPath, records);

    reapAgyConversations({ conversationsDir, registryPath, keepLast: 0 });

    expect(existsSync(join(conversationsDir, `${S1}.db`))).toBe(false);
    expect(existsSync(join(conversationsDir, `${S1}.db-shm`))).toBe(false);
    expect(existsSync(join(conversationsDir, `${S1}.db-wal`))).toBe(false);
  });

  test("registry with fewer entries than keepLast: no-op, nothing reaped", () => {
    const records: AgyReviewerConversationRecord[] = [
      { id: S1, recordedAt: 1000 },
      { id: S2, recordedAt: 1001 },
    ];
    writeConversationDb(conversationsDir, S1);
    writeConversationDb(conversationsDir, S2);
    writeRegistry(registryPath, records);

    reapAgyConversations({ conversationsDir, registryPath, keepLast: 10 });

    expect(existsSync(join(conversationsDir, `${S1}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${S2}.db`))).toBe(true);
  });

  test("best-effort: missing conversations dir is swallowed, never throws", () => {
    const records: AgyReviewerConversationRecord[] = [
      { id: S1, recordedAt: 1000 },
      { id: S2, recordedAt: 1001 },
      { id: S3, recordedAt: 1002 },
    ];
    writeRegistry(registryPath, records);
    const missingDir = join(root, "does-not-exist");

    expect(() =>
      reapAgyConversations({
        conversationsDir: missingDir,
        registryPath,
        keepLast: 1,
      }),
    ).not.toThrow();
  });

  test("best-effort: missing registry file is swallowed, never throws, and no files are touched", () => {
    writeConversationDb(conversationsDir, U1);
    const missingRegistry = join(root, "no-registry.json");

    expect(() =>
      reapAgyConversations({
        conversationsDir,
        registryPath: missingRegistry,
        keepLast: 1,
      }),
    ).not.toThrow();
    expect(existsSync(join(conversationsDir, `${U1}.db`))).toBe(true);
  });

  test("best-effort: malformed registry JSON is swallowed, never throws, and no files are touched", () => {
    writeConversationDb(conversationsDir, U1);
    mkdirSync(join(registryPath, ".."), { recursive: true });
    writeFileSync(registryPath, "{ not valid json ][");

    expect(() =>
      reapAgyConversations({ conversationsDir, registryPath, keepLast: 1 }),
    ).not.toThrow();
    expect(existsSync(join(conversationsDir, `${U1}.db`))).toBe(true);
  });

  test("uses DEFAULT_KEEP_LAST (10) when keepLast is omitted", () => {
    const records: AgyReviewerConversationRecord[] = Array.from(
      { length: 12 },
      (_, i) => ({ id: uuidFor(i), recordedAt: 1000 + i }),
    );
    for (const r of records) writeConversationDb(conversationsDir, r.id);
    writeRegistry(registryPath, records);

    reapAgyConversations({ conversationsDir, registryPath });

    // 12 entries, default keepLast=10 → oldest 2 (index 0, 1) reaped.
    expect(existsSync(join(conversationsDir, `${uuidFor(0)}.db`))).toBe(false);
    expect(existsSync(join(conversationsDir, `${uuidFor(1)}.db`))).toBe(false);
    expect(existsSync(join(conversationsDir, `${uuidFor(2)}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${uuidFor(11)}.db`))).toBe(true);
  });

  test("AGE GATE: a beyond-keep entry younger than olderThanMs is NOT reaped (second guardrail vs a just-misattributed id)", () => {
    const now = 10_000_000;
    // S1 is the oldest and beyond keepLast=1, but only 1 minute old →
    // protected by the 24h min-age gate. S2 is old enough → reaped.
    const records: AgyReviewerConversationRecord[] = [
      { id: S2, recordedAt: now - 48 * 60 * 60 * 1000 }, // 48h old → reap
      { id: S1, recordedAt: now - 60 * 1000 }, // 1min old → protected
      { id: S3, recordedAt: now - 5 * 1000 }, // newest → kept by retention
    ];
    for (const r of records) writeConversationDb(conversationsDir, r.id);
    writeRegistry(registryPath, records);

    reapAgyConversations({
      conversationsDir,
      registryPath,
      keepLast: 1,
      olderThanMs: 24 * 60 * 60 * 1000,
      now,
    });

    // S3 kept (retention), S1 kept (too young despite being beyond-keep),
    // only S2 (48h old + beyond-keep) reaped.
    expect(existsSync(join(conversationsDir, `${S3}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${S1}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${S2}.db`))).toBe(false);

    const survivors = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as AgyReviewerConversationRecord[];
    expect(survivors.map((r) => r.id).sort()).toEqual([S1, S3].sort());
  });

  test("AGE GATE: when every beyond-keep entry is too young, nothing is reaped and the registry is left as-is", () => {
    const now = 10_000_000;
    const records: AgyReviewerConversationRecord[] = [
      { id: S1, recordedAt: now - 3000 },
      { id: S2, recordedAt: now - 2000 },
      { id: S3, recordedAt: now - 1000 },
    ];
    for (const r of records) writeConversationDb(conversationsDir, r.id);
    writeRegistry(registryPath, records);

    reapAgyConversations({
      conversationsDir,
      registryPath,
      keepLast: 1,
      olderThanMs: 24 * 60 * 60 * 1000,
      now,
    });

    expect(existsSync(join(conversationsDir, `${S1}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${S2}.db`))).toBe(true);
    expect(existsSync(join(conversationsDir, `${S3}.db`))).toBe(true);
  });

  // Security-audit finding 3 — a hostile/corrupt registry id (e.g. from a
  // malformed log line matched by extractConversationIdFromLog's permissive
  // `\S+` capture) must never be used to build a delete path outside
  // conversationsDir. Mirrors qoder-reaper's equivalent traversal guard test
  // ("defends against a malformed (non-UUID) registry id").
  test("SECURITY: a non-UUID / path-traversal registry id is rejected before any path is built (no delete, no throw)", () => {
    const records = [
      { id: "../../etc/passwd", recordedAt: 1000 },
      { id: "..", recordedAt: 1001 },
      { id: "", recordedAt: 1002 },
    ] as AgyReviewerConversationRecord[];
    writeConversationDb(conversationsDir, U1); // user's own — must survive
    // A file at the traversal target this hostile id would hit if the id
    // were joined onto conversationsDir unchecked: conversationsDir is
    // `<root>/conversations`, so `../../etc/passwd.db` resolves to
    // `<parent-of-root>/etc/passwd.db`.
    const outsideDir = join(root, "..", "etc");
    mkdirSync(outsideDir, { recursive: true });
    const outsideSentinel = join(outsideDir, "passwd.db");
    writeFileSync(outsideSentinel, "root:x:0:0::/root:/bin/bash\n");
    writeRegistry(registryPath, records);

    expect(() =>
      reapAgyConversations({ conversationsDir, registryPath, keepLast: 0, olderThanMs: 0 }),
    ).not.toThrow();

    // The traversal target outside conversationsDir must survive untouched.
    expect(existsSync(outsideSentinel)).toBe(true);
    // conversationsDir itself was never swept — the user's own conversation
    // (not eligible via any hostile id) survives too.
    expect(existsSync(join(conversationsDir, `${U1}.db`))).toBe(true);

    // Cleanup: this sentinel lives outside the mkdtempSync root so afterEach
    // (none registered) wouldn't remove it — remove explicitly.
    rmSync(outsideDir, { recursive: true, force: true });
  });
});

describe("recordAgyConversation — reads OUR per-call --log-file (race-free attribution), appends to siltpoke registry", () => {
  let root: string;
  let homeBase: string;
  let registryPath: string;
  let logFilePath: string;

  // Realistic agy log line naming the conversation this subprocess created.
  const agyLog = (id: string): string =>
    `I0710 20:38:15.980076  5949 server.go:861] Created conversation ${id}\n` +
    `I0710 20:38:15.981894  5949 printmode.go:191] Print mode: conversation=${id}, sending message\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agy-record-"));
    homeBase = join(root, "siltpoke-home");
    mkdirSync(homeBase, { recursive: true });
    registryPath = join(homeBase, "agy-reviewer-conversations.json");
    logFilePath = join(root, "call.log");
  });

  test("appends the conversation id parsed from OUR log to a fresh registry", () => {
    writeFileSync(logFilePath, agyLog("conv-abc-123"));

    recordAgyConversation({ logFilePath, homeBase });

    const registry = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as AgyReviewerConversationRecord[];
    expect(registry).toHaveLength(1);
    expect(registry[0]?.id).toBe("conv-abc-123");
    expect(typeof registry[0]?.recordedAt).toBe("number");
  });

  test("appends to an EXISTING registry without clobbering prior entries", () => {
    writeFileSync(
      registryPath,
      JSON.stringify([{ id: "old-conv", recordedAt: 1 }]),
    );
    writeFileSync(logFilePath, agyLog("new-conv"));

    recordAgyConversation({ logFilePath, homeBase });

    const registry = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as AgyReviewerConversationRecord[];
    expect(registry.map((r) => r.id)).toEqual(["old-conv", "new-conv"]);
  });

  test("records only the per-call log-file conversation id, never the shared cwd cache even when the cache holds a foreign id (CRITICAL data-loss regression guard)", () => {
    // This is the guard for the CRITICAL bug: the original impl learned the
    // conversation id from agy's cwd-keyed cache
    // (`<antigravityHome>/cache/last_conversations.json`), which a concurrent
    // USER agy session on the same cwd could overwrite → siltpoke would record
    // the USER's id and the reaper would later delete the user's DB.
    //
    // To make this guard actually BITE if cwd-cache reading is ever
    // reintroduced, plant the decoy cache at the REAL resolvable path (via
    // resolveAntigravityHome + a sandboxed ANTIGRAVITY_HOME) holding a FOREIGN
    // ("user") uuid — the exact file+key a reintroduced reader would consult.
    const FOREIGN_USER_UUID = "ffffffff-1111-2222-3333-444444444444";
    const SILTPOKE_OWN_UUID = "aaaaaaaa-5555-6666-7777-888888888888";

    const prevAntigravityHome = process.env.ANTIGRAVITY_HOME;
    const sandboxAntigravityHome = join(root, "gemini-home");
    process.env.ANTIGRAVITY_HOME = sandboxAntigravityHome;
    try {
      // Decoy cache at the REAL location a cwd-cache reader would open,
      // populated with the user's conversation id keyed by the reviewed cwd.
      const realCachePath = join(
        resolveAntigravityHome(),
        "cache",
        "last_conversations.json",
      );
      mkdirSync(join(realCachePath, ".."), { recursive: true });
      // Key the foreign id under BOTH a plausible reviewed-repo cwd AND the
      // current process cwd, so the guard bites whichever cwd a reintroduced
      // reader would key off (the original impl defaulted to
      // `opts.cwd || process.cwd()`).
      writeFileSync(
        realCachePath,
        JSON.stringify({
          "/Users/v/repo": FOREIGN_USER_UUID,
          [process.cwd()]: FOREIGN_USER_UUID,
        }),
      );
      // Our own subprocess's private per-call log names OUR conversation.
      writeFileSync(logFilePath, agyLog(SILTPOKE_OWN_UUID));

      recordAgyConversation({ logFilePath, homeBase });

      const registry = JSON.parse(
        readFileSync(registryPath, "utf8"),
      ) as AgyReviewerConversationRecord[];
      // Attribution used ONLY the per-call log — the foreign cache id is
      // categorically absent, so the reaper can never reach the user's DB.
      // (If cwd-cache reading were reintroduced, this registry would contain
      // FOREIGN_USER_UUID and the assertion would fail — the guard bites.)
      expect(registry.map((r) => r.id)).toEqual([SILTPOKE_OWN_UUID]);
      expect(registry.map((r) => r.id)).not.toContain(FOREIGN_USER_UUID);
    } finally {
      if (prevAntigravityHome === undefined) {
        delete process.env.ANTIGRAVITY_HOME;
      } else {
        process.env.ANTIGRAVITY_HOME = prevAntigravityHome;
      }
    }
  });

  test("falls back to the sole uuid in the log when the 'Created conversation' anchor is absent (defensive)", () => {
    // No anchor line — only a uuid appears elsewhere. extractConversationId
    // still recovers it (log-format-change resilience).
    writeFileSync(
      logFilePath,
      "I0710 conversation=d0acc450-de71-4463-9d56-17b1370ec793 streaming\n",
    );

    recordAgyConversation({ logFilePath, homeBase });

    const registry = JSON.parse(
      readFileSync(registryPath, "utf8"),
    ) as AgyReviewerConversationRecord[];
    expect(registry.map((r) => r.id)).toEqual([
      "d0acc450-de71-4463-9d56-17b1370ec793",
    ]);
  });

  test("no-ops when the log has no conversation id at all (never invents one)", () => {
    writeFileSync(logFilePath, "I0710 some log with no conversation id here\n");

    recordAgyConversation({ logFilePath, homeBase });

    expect(existsSync(registryPath)).toBe(false);
  });

  test("best-effort: missing log file is swallowed, never throws, registry untouched", () => {
    expect(() =>
      recordAgyConversation({
        logFilePath: join(root, "does-not-exist.log"),
        homeBase,
      }),
    ).not.toThrow();
    expect(existsSync(registryPath)).toBe(false);
  });

  test("best-effort: omitted logFilePath is swallowed, never throws", () => {
    expect(() => recordAgyConversation({ homeBase })).not.toThrow();
    expect(existsSync(registryPath)).toBe(false);
  });
});

describe("extractConversationIdFromLog — anchor preferred, uuid fallback", () => {
  test("prefers the 'Created conversation <uuid>' anchor over other uuids", () => {
    const log =
      "I0710 server.go:2212] GetConversationDetail: found conversation aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n" +
      "I0710 server.go:861] Created conversation 11111111-2222-3333-4444-555555555555\n";
    expect(extractConversationIdFromLog(log)).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  test("parses the id from a REAL captured agy --log-file (Task 8 fix-spike fixture)", () => {
    // tests/fixtures/agy/created-conversation.log = verbatim log-line format
    // captured live from a real `agy -p --log-file` call (the conversation
    // was cleaned up post-spike; this asserts the anchor the CRITICAL fix
    // depends on against agy's actual output, same rigor as the stdout
    // fixture tests/fixtures/agy/brain-reply.json).
    const realLog = readFileSync(
      join(import.meta.dir, "../fixtures/agy/created-conversation-log.txt"),
      "utf8",
    );
    expect(extractConversationIdFromLog(realLog)).toBe(
      "d0acc450-de71-4463-9d56-17b1370ec793",
    );
  });

  test("returns undefined when nothing uuid-shaped is present", () => {
    expect(extractConversationIdFromLog("no ids here")).toBeUndefined();
  });
});
