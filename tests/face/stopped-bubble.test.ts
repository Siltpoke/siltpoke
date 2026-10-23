// The bubble's time stamp, and the bubble a latched reviewer takes over.
// Split out of wrapper.test.ts (pinned by the file-length ratchet).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBubbleBlock } from "../../src/face/bubble.ts";
import { runWrapper } from "../../src/face/wrapper.ts";

let tempBase: string;

beforeEach(() => {
  tempBase = mkdtempSync(join(tmpdir(), "siltpoke-test-"));
});

afterEach(() => {
  rmSync(tempBase, { recursive: true, force: true });
});

// The stamp, read off the bubble the statusline really builds — the stamp
// function itself is not exported, and nothing but the bubble uses it.
const bubbleTimeStamp = (atMs: number | undefined, nowMs?: number): string =>
  buildBubbleBlock("x", "cyan", 0, 200, atMs, nowMs)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips the ANSI colour
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/"x"$/, "");

test("bubbleTimeStamp: 12-hour with AM/PM, and empty for anything unusable", () => {
  // One fixed day for both the stamp and "now": built from the live clock,
  // the two could land either side of local midnight and grow a date.
  const at = (h: number, m: number): number => new Date(2026, 9, 1, h, m, 0, 0).getTime();
  const now = at(12, 0);
  expect(bubbleTimeStamp(at(9, 5), now)).toBe("[9:05 AM]: ");
  expect(bubbleTimeStamp(at(13, 44), now)).toBe("[1:44 PM]: ");
  // The two the modulo gets wrong: 0 % 12 and 12 % 12 are both 0.
  expect(bubbleTimeStamp(at(0, 15), now)).toBe("[12:15 AM]: ");
  expect(bubbleTimeStamp(at(12, 15), now)).toBe("[12:15 PM]: ");
  // Boundaries either side of noon and midnight.
  expect(bubbleTimeStamp(at(11, 59), now)).toBe("[11:59 AM]: ");
  expect(bubbleTimeStamp(at(23, 59), now)).toBe("[11:59 PM]: ");
  expect(bubbleTimeStamp(undefined)).toBe("");
  expect(bubbleTimeStamp(0)).toBe("");
  expect(bubbleTimeStamp(Number.NaN)).toBe("");
});

// ── Audit [48]: a latched reviewer says so, in the bubble ────────────────────
// A permanent failure latches every later review off until someone clears it.
// The statusline read none of that: the pet stayed on screen, the bubble went
// back to its default line after 30 minutes, and nothing said reviews had
// stopped. Measured on the maintainer's machine: about a day and a half, 562
// turns skipped.

const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test("bubbleTimeStamp: the date appears only when the stamp is not from today", () => {
  const now = local(2026, 10, 1, 14, 0);
  // Today: unchanged from before — a review bubble lives 30 minutes, so this
  // is what every ordinary bubble keeps looking like.
  expect(bubbleTimeStamp(local(2026, 10, 1, 9, 5), now)).toBe("[9:05 AM]: ");
  // An earlier day, same year.
  expect(bubbleTimeStamp(local(2026, 9, 29, 11, 45), now)).toBe("[Sep 29, 11:45 AM]: ");
  // Ten minutes ago, across midnight: still a different day, so it says so.
  expect(bubbleTimeStamp(local(2026, 9, 30, 23, 50), local(2026, 10, 1, 0, 0))).toBe(
    "[Sep 30, 11:50 PM]: ",
  );
  // Another year carries the year; "Dec 31" alone would read as this year's.
  expect(bubbleTimeStamp(local(2025, 12, 31, 23, 50), now)).toBe("[Dec 31 2025, 11:50 PM]: ");
});

const writeHealth = (
  base: string,
  breaker: { class: string; opened_at: string; next_eligible_at: string } | null,
  failureClass = "permanent",
): void => {
  writeFileSync(
    join(base, "brain-health.json"),
    JSON.stringify({
      schema_version: 1,
      last_attempt_ts: breaker?.opened_at ?? null,
      last_success_ts: null,
      consecutive_failures: 2,
      last_failure: {
        class: failureClass,
        exit_code: null,
        stderr_excerpt: "ERR_INVALID_ARG_VALUE",
        ts: breaker?.opened_at ?? new Date().toISOString(),
      },
      breaker,
      retry_budget: { date: "", outer_retries_used: 0 },
      quota_calls_today: {},
    }),
  );
};

const writeFreshState = (base: string, bubble: string): void => {
  writeFileSync(
    join(base, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      mood: "happy",
      pose: "base",
      bubble_short: bubble,
      severity: "info",
      confidence: "high",
      last_updated_ms: Date.now(),
      last_session_id: "s",
    }),
  );
};

test("a latched reviewer takes the bubble, with the day it stopped", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(join(tempBase, "config.json"), JSON.stringify({ species: "cat", bubble: "hello from config" }));
  const iso = new Date(local(2026, 9, 29, 11, 45)).toISOString();
  writeHealth(tempBase, { class: "permanent", opened_at: iso, next_eligible_at: iso });

  const result = await runWrapper({
    basePath: tempBase,
    termWidth: 200,
    nowMs: local(2026, 10, 1, 14, 0),
  });
  expect(result).toContain('[Sep 29, 11:45 AM]: "I stopped reviewing — run /siltpoke:siltpoke-wake"');
  // Red, the colour a high-severity review uses.
  expect(result).toContain("\x1b[31m[Sep 29, 11:45 AM]");
  // It replaces the default line rather than sitting next to it.
  expect(result).not.toContain("hello from config");
});

test("a latched reviewer outranks a fresh review bubble", async () => {
  // /siltpoke-review has no breaker pre-check, so a review can still land
  // while the latch is on. The stop is the thing the reader has to act on.
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFreshState(tempBase, "looks fine to me");
  const iso = new Date(local(2026, 9, 29, 11, 45)).toISOString();
  writeHealth(tempBase, { class: "permanent", opened_at: iso, next_eligible_at: iso });

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });
  expect(result).toContain("I stopped reviewing");
  expect(result).not.toContain("looks fine to me");
});

test("latched today: the bubble carries the time alone, like any other bubble", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  const iso = new Date(local(2026, 10, 1, 11, 45)).toISOString();
  writeHealth(tempBase, { class: "permanent", opened_at: iso, next_eligible_at: iso });

  const result = await runWrapper({
    basePath: tempBase,
    termWidth: 200,
    nowMs: local(2026, 10, 1, 14, 0),
  });
  expect(result).toContain('[11:45 AM]: "I stopped reviewing');
  expect(result).not.toContain("Oct 1");
});

test("a breaker on a timer does NOT take the bubble — it ends by itself", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFreshState(tempBase, "looks fine to me");
  const opened = new Date();
  const until = new Date(opened.getTime() + 60 * 60_000);
  writeHealth(
    tempBase,
    { class: "resource", opened_at: opened.toISOString(), next_eligible_at: until.toISOString() },
    "resource",
  );

  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });
  expect(result).toContain('"looks fine to me"');
  expect(result).not.toContain("stopped reviewing");
});

test("no brain-health file: the bubble is untouched", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFreshState(tempBase, "looks fine to me");
  const result = await runWrapper({ basePath: tempBase, termWidth: 200 });
  expect(result).toContain('"looks fine to me"');
  expect(result).not.toContain("stopped reviewing");
});

test("minimal mode (no face) still says reviews stopped", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'inner line'");
  writeFileSync(join(tempBase, "config.json"), JSON.stringify({ species: "cat", minimalMode: true }));
  const iso = new Date(local(2026, 9, 29, 11, 45)).toISOString();
  writeHealth(tempBase, { class: "permanent", opened_at: iso, next_eligible_at: iso });

  const result = await runWrapper({
    basePath: tempBase,
    termWidth: 200,
    nowMs: local(2026, 10, 1, 14, 0),
  });
  expect(result).toContain("inner line");
  expect(result).toContain('[Sep 29, 11:45 AM]: "I stopped reviewing — run /siltpoke:siltpoke-wake"');
});

test("an unreadable brain-health.json never costs the face", async () => {
  // This read happens on every statusline paint. A bad file must degrade to
  // "not latched", not fall into the catch that returns the bare inner line.
  for (const garbage of [
    "{ not json",
    "[]",
    JSON.stringify({ schema_version: 1, consecutive_failures: 1, breaker: { class: "permanent", opened_at: "nope", next_eligible_at: "nope" } }),
  ]) {
    writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
    writeFileSync(join(tempBase, "config.json"), JSON.stringify({ species: "cat", name: "Bangbang" }));
    writeFileSync(join(tempBase, "brain-health.json"), garbage);
    const result = await runWrapper({ basePath: tempBase, termWidth: 200 });
    expect(result).toContain("Bangbang");
    expect(result).not.toContain("stopped reviewing");
  }
});

test("a non-Claude host is never handed a /siltpoke- command in the stopped bubble", async () => {
  // Same invariant as tests/plugin/host-aware-nudge.test.ts: codex and agy
  // have no slash commands, so the advice has to be something they can do.
  const iso = new Date(local(2026, 9, 29, 11, 45)).toISOString();
  writeHealth(tempBase, { class: "permanent", opened_at: iso, next_eligible_at: iso });

  const result = await runWrapper({ basePath: tempBase, termWidth: 200, agent: "antigravity" });
  expect(result).toContain("I stopped reviewing");
  expect(result).not.toContain("/siltpoke-");
  expect(result).toContain("wake Siltpoke");
});

// §110 W6 made the command 9 characters longer. At 40 columns the bubble wraps
// to three lines and the command is still whole — the part the reader acts on.
test("at 40 columns the stopped bubble still shows the whole command", async () => {
  writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
  writeFileSync(join(tempBase, "config.json"), JSON.stringify({ species: "cat" }));
  const iso = new Date(local(2026, 9, 29, 11, 45)).toISOString();
  writeHealth(tempBase, { class: "permanent", opened_at: iso, next_eligible_at: iso });
  const result = await runWrapper({ basePath: tempBase, termWidth: 40, nowMs: local(2026, 10, 1, 14, 0) });
  expect(result.replace(/\x1b\[[0-9;]*m/g, "")).toContain("/siltpoke:siltpoke-wake");
  expect(result).not.toContain("...");
});
