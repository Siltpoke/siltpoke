import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { runCard, buildSparkline } from "../../src/cli/card";
import { appendUsageEvent } from "../../src/state/usage";
import {
  freshBrainHealth,
  recordFailure,
  recordSuccess,
  writeBrainHealth,
} from "../../src/state/brain-health";

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-card-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const noon = new Date("2026-05-14T12:00:00Z");

test("card: defaults render when no state/config", async () => {
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.name).toBe("Siltpoke");
  expect(r.species).toBe("slime");
  expect(r.level).toBe(1);
  expect(r.xp).toBe(0);
  expect(r.brain_calls_today).toBe(0);
  expect(r.review_unit).toBe("commit");
  expect(r.card_text).toContain("Siltpoke the slime");
});

test("card: reflects personality + progression + state", async () => {
  writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({ name: "Mochi", species: "cat", language: "zh-CN" }),
  );
  writeFileSync(
    join(homeBase, "progression.json"),
    JSON.stringify({
      schemaVersion: 1,
      level: 2,
      xp: 50,
      xp_to_next_level: 200,
      unlocked_poses: ["base", "peek"],
      unlocked_titles: ["Hatchling", "Watcher"],
      pet_log: [],
    }),
  );
  writeFileSync(
    join(homeBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "annoyed",
      pose: "concerned",
      bubble_short: "queries.py:47 bad join",
      severity: "medium",
      confidence: "high",
      last_updated_ms: noon.getTime(),
      last_session_id: "s",
    }),
  );

  const r = await runCard({ homeBase, now: () => noon });
  expect(r.name).toBe("Mochi");
  expect(r.species).toBe("cat");
  expect(r.level).toBe(2);
  expect(r.xp).toBe(50);
  expect(r.titles).toEqual(["Hatchling", "Watcher"]);
  expect(r.mood).toBe("annoyed");
  expect(r.bubble).toBe("queries.py:47 bad join");
  expect(r.card_text).toContain("Mochi the cat");
  expect(r.card_text).toContain("level 2");
});

test("card: aggregates today's usage events", async () => {
  await appendUsageEvent(homeBase, {
    ts: noon.toISOString(),
    kind: "main",
    session_id: "s",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0.005,
  });
  await appendUsageEvent(homeBase, {
    ts: noon.toISOString(),
    kind: "reflection",
    session_id: "s",
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0.0002,
  });
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.brain_calls_today).toBe(1);
  expect(r.reflections_today).toBe(1);
  expect(r.cost_today_usd).toBeCloseTo(0.0052, 5);
});

test("card: stale state.json (>30min) falls back to idle + empty bubble", async () => {
  const oneHourAgo = new Date(noon.getTime() - 60 * 60 * 1000);
  writeFileSync(
    join(homeBase, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "annoyed",
      pose: "concerned",
      bubble_short: "stale bubble",
      severity: "medium",
      confidence: "high",
      last_updated_ms: oneHourAgo.getTime(),
      last_session_id: "s",
    }),
  );
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.mood).toBe("idle");
  expect(r.bubble).toBe("");
});

test("card: progress bar reflects XP ratio", async () => {
  writeFileSync(
    join(homeBase, "progression.json"),
    JSON.stringify({
      schemaVersion: 1,
      level: 1,
      xp: 50,
      xp_to_next_level: 100,
      unlocked_poses: ["base"],
      unlocked_titles: ["Hatchling"],
      pet_log: [],
    }),
  );
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.xp_progress_bar).toContain("50%");
  expect(r.xp_progress_bar).toMatch(/█{10}░{10}/);
});

test("buildSparkline: empty input renders blank line of correct width", () => {
  const out = buildSparkline([], noon, 7);
  expect(out).toHaveLength(7);
  expect(out).toBe(" ".repeat(7));
});

test("buildSparkline: today renders rightmost, older days fill from the right", () => {
  // Use the UTC midnight key as the floor, then subtract whole days so the
  // bucketing math (floor of day-diff) lands exactly where we expect.
  const todayMidnightMs = Date.parse(`${noon.toISOString().slice(0, 10)}T00:00:00Z`);
  const todayTs = new Date(todayMidnightMs).toISOString();
  const twoDaysAgoTs = new Date(todayMidnightMs - 2 * 86_400_000).toISOString();
  const out = buildSparkline([todayTs, todayTs, twoDaysAgoTs], noon, 7);
  expect(out).toHaveLength(7);
  // Today is rightmost (idx 6), 2 days ago is idx 4.
  expect(out[4]).not.toBe(" ");
  expect(out[6]).not.toBe(" ");
  // Today's bucket has the highest count (2) so it gets the tallest glyph.
  expect(out[6]).toBe("█");
});

test("buildSparkline: out-of-window timestamps are ignored", () => {
  const todayTs = noon.toISOString();
  const longAgoTs = new Date(noon.getTime() - 30 * 86_400_000).toISOString();
  const out = buildSparkline([todayTs, longAgoTs], noon, 7);
  expect(out[6]).toBe("█"); // today still renders
  expect(out.slice(0, 6).split("").every((c) => c === " ")).toBe(true);
});

test("card: per-project breakdown lists projects with today's calls", async () => {
  const projectA = join(tmp, "proj-a");
  const projectB = join(tmp, "proj-b");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });

  // Seed brain-calls.jsonl with two calls today from project A, one from B
  const brainLog = join(homeBase, "brain-calls.jsonl");
  const todayTs = noon.toISOString();
  for (const cwd of [projectA, projectA, projectB]) {
    appendFileSync(
      brainLog,
      `${JSON.stringify({ timestamp: todayTs, cwd })}\n`,
    );
  }
  // One skipped row that must NOT count as a brain call
  appendFileSync(
    brainLog,
    `${JSON.stringify({ timestamp: todayTs, cwd: projectA, skipped: "quiet_hours" })}\n`,
  );

  const r = await runCard({ homeBase, now: () => noon });
  const a = r.projects.find((p) => p.cwd === projectA);
  const b = r.projects.find((p) => p.cwd === projectB);
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  expect(a?.calls_today).toBe(2);
  expect(b?.calls_today).toBe(1);
  // Sorted: project with more pending wins, then more calls. A has 2 calls > B's 1.
  expect(r.projects[0]?.cwd).toBe(projectA);
});

test("card: pending critique count reflects only pending-status entries", async () => {
  const project = join(tmp, "proj-pc");
  const archiveDir = join(project, ".siltpoke", "critiques", "archive", "2026-05-14");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(
    join(archiveDir, "c-pend.md"),
    `---\nschemaVersion: 1\ncritique_id: c-pend\nstatus: pending\n---\nbody`,
  );
  writeFileSync(
    join(archiveDir, "c-done.md"),
    `---\nschemaVersion: 1\ncritique_id: c-done\nstatus: forwarded\n---\nbody`,
  );
  writeFileSync(
    join(project, ".siltpoke", "critiques", "history.jsonl"),
    [
      JSON.stringify({ critique_id: "c-pend", path: join(archiveDir, "c-pend.md") }),
      JSON.stringify({ critique_id: "c-done", path: join(archiveDir, "c-done.md") }),
      "",
    ].join("\n"),
  );

  // Need a brain-call row so the project shows up in the summary.
  appendFileSync(
    join(homeBase, "brain-calls.jsonl"),
    `${JSON.stringify({ timestamp: noon.toISOString(), cwd: project })}\n`,
  );

  const r = await runCard({ homeBase, now: () => noon });
  const p = r.projects.find((x) => x.cwd === project);
  expect(p).toBeTruthy();
  expect(p?.pending_critiques).toBe(1); // only c-pend, not c-done
});

test("card: handles 0 / 0 xp_to_next_level (no division by zero)", async () => {
  writeFileSync(
    join(homeBase, "progression.json"),
    JSON.stringify({
      schemaVersion: 1,
      level: 99,
      xp: 0,
      xp_to_next_level: 0,
      unlocked_poses: [],
      unlocked_titles: [],
      pet_log: [],
    }),
  );
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.xp_progress_bar).toContain("0%");
});

import { writeMute, type MuteFile } from "../../src/state/mute";

test("card: no mute → mute is null + card text has no mute line", async () => {
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.mute).toBeNull();
  expect(r.card_text).not.toContain("muted");
});

test("card: timed mute → mute populated + card text contains mute line", async () => {
  const future = new Date("2026-05-14T13:30:00Z");
  const mute: MuteFile = {
    schemaVersion: 1,
    until_ms: future.getTime(),
    indefinite: false,
    set_at: noon.toISOString(),
  };
  writeMute(homeBase, mute);
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.mute).not.toBeNull();
  expect(r.mute?.indefinite).toBe(false);
  expect(r.mute?.until_ms).toBe(future.getTime());
  expect(r.card_text).toContain("muted until");
  expect(r.card_text).toContain("1h 30m left");
});

test("card: indefinite mute → display says indefinite", async () => {
  const mute: MuteFile = {
    schemaVersion: 1,
    until_ms: null,
    indefinite: true,
    set_at: noon.toISOString(),
  };
  writeMute(homeBase, mute);
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.mute).not.toBeNull();
  expect(r.mute?.indefinite).toBe(true);
  expect(r.card_text).toContain("muted (indefinite");
});

test("card: expired mute → mute is null (lingering file ignored)", async () => {
  const past = new Date("2026-05-14T11:00:00Z");
  const mute: MuteFile = {
    schemaVersion: 1,
    until_ms: past.getTime(),
    indefinite: false,
    set_at: past.toISOString(),
  };
  writeMute(homeBase, mute);
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.mute).toBeNull();
  expect(r.card_text).not.toContain("muted");
});


// ─────────────────────────────────────────────────────────────────────────────
// ⚠ Brain-failure one-liner on the state card.
// ─────────────────────────────────────────────────────────────────────────────

test("card shows ⚠ brain line when ≥2 consecutive transient failures", async () => {
  let h = freshBrainHealth();
  h = recordFailure(h, { class: "ambiguous", exit_code: 1, stderr_excerpt: "", ts: noon.toISOString() });
  h = recordFailure(h, { class: "ambiguous", exit_code: 1, stderr_excerpt: "", ts: noon.toISOString() });
  writeBrainHealth(homeBase, h);
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.brain_warning).toContain("ambiguous");
  // Wording follows `brainUnhealthySignal`: state first. An `ambiguous` pair
  // opens no breaker, so this is the past-tense branch.
  expect(r.card_text).toContain("2 ambiguous failures");
});

test("permanent class surfaces on the card at the FIRST failure", async () => {
  let h = freshBrainHealth();
  h = recordFailure(h, { class: "permanent", exit_code: 1, stderr_excerpt: "Invalid API key", ts: noon.toISOString() });
  writeBrainHealth(homeBase, h);
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.card_text).toContain("permanent");
  // The reason survives on the card specifically because there is no tooltip
  // here — see `brainUnhealthySignal`'s permanent branch.
  expect(r.card_text).toContain("Invalid API key");
  expect(r.card_text).toContain("/siltpoke-wake");
});

test("card line clears automatically after the next success (no user ack)", async () => {
  let h = freshBrainHealth();
  h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts: noon.toISOString() });
  h = recordFailure(h, { class: "resource", exit_code: 137, stderr_excerpt: "EAGAIN", ts: noon.toISOString() });
  h = recordSuccess(h, noon.toISOString());
  writeBrainHealth(homeBase, h);
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.brain_warning).toBeNull();
  expect(r.card_text).not.toContain("⚠ brain");
});

test("single transient failure does NOT clutter the card", async () => {
  let h = freshBrainHealth();
  h = recordFailure(h, { class: "ambiguous", exit_code: 1, stderr_excerpt: "", ts: noon.toISOString() });
  writeBrainHealth(homeBase, h);
  const r = await runCard({ homeBase, now: () => noon });
  expect(r.brain_warning).toBeNull();
});
