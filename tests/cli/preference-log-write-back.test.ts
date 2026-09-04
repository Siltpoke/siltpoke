// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Regression guard: the preference-log write-back famine (measured 2026-08-19).
 *
 * THE BUG: `src/cli/{dismiss,ack,mark-forwarded}.ts` called
 * `appendPreferenceEntry(...)` WITHOUT awaiting it (`.catch()`-swallowed,
 * "preference log is non-fatal"). Each of those files is also a CLI entry whose
 * `import.meta.main` block ends in `process.exit(0)`. The exit fired before the
 * un-awaited `appendFile` reached disk, so every dismiss / ack / forward wrote
 * `feedback-archive.jsonl` (awaited) and silently dropped its
 * `preference-log.jsonl` line — while still printing `"archive_appended": true`.
 *
 * BLAST RADIUS, stated precisely rather than generously. All three signals were
 * lost, but only ONE of the three has a shipped caller: `mark-forwarded` is run
 * by `/siltpoke-last` after it surfaces a review, so every forward a real user
 * ever produced was dropped. `ack` and `dismiss` have no slash command, no entry
 * in `src/cli/plugin-cli.ts`'s dispatch table, and no daemon route — the
 * dashboard's ACK / DISMISS buttons POST to `/api/critic/action` and write
 * `critic-actions.jsonl`, a different file this code never touches. So those two
 * are reachable only by running the entry by hand, and Block D's `ack`/`dismiss`
 * counters stay at zero after this fix for a different reason: they read a log
 * that no shipped surface writes.
 *
 * On the real machine `~/.siltpoke/preference-log.jsonl` sat at 0 bytes for two
 * months while `feedback-archive.jsonl` collected genuine dismissals, and
 * `consolidate.ts` carried a TODO asserting the exact opposite (that the archive
 * was "absent in practice" and dismissals landed in the preference log).
 *
 * WHY IT SURVIVED THE SUITE: nothing was asserted wrong — the assertion was
 * ABSENT. `tests/cli/dismiss.test.ts` threads `preferenceLogPath` through 13
 * call sites purely for isolation and never reads the file back. The one place
 * that did (`tests/cli/ack.test.ts`) called `await runDismiss`-style in-process
 * and then slept 25ms with the comment "give the microtask a tick to flush" —
 * a grace period the real CLI does not have, because `process.exit(0)` is not
 * a tick.
 *
 * SO THIS TEST SPAWNS THE REAL CLI. An in-process `await runDismiss(...)` is
 * structurally blind to this defect: the bug lives in the gap between the
 * function returning and the process dying, and only a subprocess has that gap.
 * `siltpoke-feedback` — the one writer that always awaited — is included as the
 * CONTROL: it varies only the awaited-ness, so a run where the control lands and
 * the other three do not is evidence about `await`, not about the fixture.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

let sandbox: string;
let home: string;
let projectCwd: string;
let prefLog: string;

const CRITIQUE_DATE = "2026-08-19";

function seedCritique(id: string): void {
  const dir = join(projectCwd, ".siltpoke", "critiques", "archive", CRITIQUE_DATE);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.md`),
    `---\nschemaVersion: 1\ncritique_id: ${id}\nstatus: open\n---\n\n# [SILTPOKE CRITIQUE]\nqueries.py:47 missing null check\n`,
  );
}

/**
 * `findCritiqueByIdOrLatest` resolves "latest" to `critiques/latest.md`, a
 * different location from the dated archive `seedCritique` writes to. The
 * sentinel path needs its own fixture, and the id inside must DIFFER from the
 * address used to reach it — otherwise the assertion below cannot tell a
 * resolved id apart from an echoed one.
 */
function seedLatest(id: string): void {
  const dir = join(projectCwd, ".siltpoke", "critiques");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "latest.md"),
    `---\nschemaVersion: 1\ncritique_id: ${id}\nstatus: pending\n---\n\n# [SILTPOKE CRITIQUE]\nqueries.py:47 missing null check\n`,
  );
}

/**
 * Run a CLI entry the way a user does — a real subprocess that reaches its own
 * `process.exit(0)`. `SILTPOKE_HOME` redirects every global write into the
 * sandbox, so this never touches the developer's `~/.siltpoke/` (the pollution
 * that filled the real preference log with 5,229 fixture rows in May–June 2026).
 */
async function runCli(entry: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", join(repoRoot, entry), ...args], {
    cwd: projectCwd,
    env: { ...process.env, SILTPOKE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

function preferenceEntries(): Array<Record<string, unknown>> {
  if (!existsSync(prefLog)) return [];
  return readFileSync(prefLog, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "siltpoke-prefwrite-"));
  home = join(sandbox, "home");
  projectCwd = join(sandbox, "proj");
  prefLog = join(home, "preference-log.jsonl");
  mkdirSync(home, { recursive: true });
  mkdirSync(projectCwd, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("preference-log survives the CLI's process.exit (write-back famine)", () => {
  test("CONTROL: siltpoke-feedback (always awaited) reaches disk", async () => {
    seedCritique("c-control");
    const r = await runCli("src/cli/siltpoke-feedback.ts", ["c-control", "control text"]);
    expect(r.exitCode).toBe(0);

    const entries = preferenceEntries();
    // Non-empty on BOTH sides of the comparison below — an all-empty run would
    // otherwise "agree" with a totally broken writer.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.critique_id)).toContain("c-control");
    expect(entries.find((e) => e.critique_id === "c-control")?.signal).toBe("feedback");
  });

  test("dismiss (no reason) writes its preference entry before exiting", async () => {
    seedCritique("c-dismiss-bare");
    const r = await runCli("src/cli/dismiss.ts", ["c-dismiss-bare"]);
    expect(r.exitCode).toBe(0);
    // The CLI reported success on the archive — the bug was that it reported
    // that while dropping the preference-log line.
    expect(r.stdout).toContain('"archive_appended": true');

    const entry = preferenceEntries().find((e) => e.critique_id === "c-dismiss-bare");
    expect(entry).toBeDefined();
    expect(entry?.signal).toBe("dismiss");
  });

  test("ack writes its preference entry before exiting", async () => {
    seedCritique("c-ack");
    const r = await runCli("src/cli/ack.ts", ["c-ack"]);
    expect(r.exitCode).toBe(0);

    const entry = preferenceEntries().find((e) => e.critique_id === "c-ack");
    expect(entry).toBeDefined();
    expect(entry?.signal).toBe("ack");
  });

  test("mark-forwarded writes its preference entry before exiting", async () => {
    seedCritique("c-forward");
    const r = await runCli("src/cli/mark-forwarded.ts", ["c-forward"]);
    expect(r.exitCode).toBe(0);

    const entry = preferenceEntries().find((e) => e.critique_id === "c-forward");
    expect(entry).toBeDefined();
    expect(entry?.signal).toBe("forward");
  });

  test("all four signals land, so Block D's counters can be non-zero", async () => {
    for (const id of ["c-a", "c-d", "c-f", "c-k"]) seedCritique(id);
    await runCli("src/cli/ack.ts", ["c-a"]);
    await runCli("src/cli/dismiss.ts", ["c-d"]);
    await runCli("src/cli/mark-forwarded.ts", ["c-f"]);
    await runCli("src/cli/siltpoke-feedback.ts", ["c-k", "some words"]);

    const signals = new Set(preferenceEntries().map((e) => e.signal));
    // Pre-fix this set was {"feedback"} alone: the other three were structurally
    // unreachable from the CLI, which is why the panel read `ack 0 · dismiss 0 ·
    // forward 0` no matter how much the user actually used it.
    expect([...signals].sort()).toEqual(["ack", "dismiss", "feedback", "forward"]);
  });

  test("mark-forwarded with NO argument records the critique's own id, not the \"latest\" sentinel", async () => {
    // This is the shipped invocation: `.claude-plugin/commands/siltpoke-last.md`
    // runs `siltpoke-cli mark-forwarded` with no argument, so `idOrLatest`
    // defaults to the string "latest".
    seedLatest("c-real99");
    const r = await runCli("src/cli/mark-forwarded.ts", []);
    expect(r.exitCode).toBe(0);

    const entries = preferenceEntries();
    expect(entries.length).toBe(1);
    // The defect: the row carried `critique_id: "latest"`, an address rather
    // than an identity, so it joined back to no critique at all. Measured on
    // the real store the day the awaited write started landing.
    expect(entries[0]?.critique_id).toBe("c-real99");
    expect(entries[0]?.critique_id).not.toBe("latest");
    expect(entries[0]?.signal).toBe("forward");
  });

  test("mark-forwarded with an explicit id still records that id", async () => {
    // The resolver must not change the addressed-by-id path, which already
    // recorded the right thing.
    seedCritique("c-explicit");
    const r = await runCli("src/cli/mark-forwarded.ts", ["c-explicit"]);
    expect(r.exitCode).toBe(0);
    expect(preferenceEntries().map((e) => e.critique_id)).toEqual(["c-explicit"]);
  });

  test("the dismiss archive still lands too — the fix adds a write, it does not move one", async () => {
    seedCritique("c-both");
    await runCli("src/cli/dismiss.ts", ["c-both"]);

    // feedback-archive.jsonl and preference-log.jsonl are different records, not
    // rival paths: the archive is the durable verdict store, the log is the raw
    // signal stream. Both must carry this dismissal.
    const archive = join(home, "feedback-archive.jsonl");
    expect(existsSync(archive)).toBe(true);
    expect(readFileSync(archive, "utf8")).toContain("c-both");
    expect(preferenceEntries().map((e) => e.critique_id)).toContain("c-both");
  });
});
