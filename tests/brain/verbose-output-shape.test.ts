// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [12] — siltpoke depended on an output shape it did not control.
 *
 * `claude -p --output-format json` returns the full event ARRAY only when
 * `verbose` is on. A user's `~/.claude/settings.json` decides that, and a
 * clean new-user config has it OFF — so stdout is a single `type:"result"`
 * object, `Array.isArray` fails, and every review dies silently.
 *
 * Measured 2026-09-17 against Claude Code 2.1.274, one variable changed via
 * `--settings '{"verbose": X}'`:
 *   verbose=true  -> list (7 events)
 *   verbose=false -> dict (a complete result event: type/result/usage/...)
 *   verbose=false + `--verbose` on argv -> list  (the argv flag wins)
 *
 * Two independent defenses, because either alone has been enough to lose the
 * whole feature once:
 *   1. pass `--verbose` ourselves, at EVERY `claude -p` argv site;
 *   2. accept the single-object shape anyway, so a host that strips the flag
 *      (or a future CLI change) degrades to working instead of silent.
 */
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { callBrain, runBrainCall, BrainError } from "../../src/brain/brain";
import {
  extractUsage,
  findResultEvent,
  normalizeStreamEnvelope,
} from "../../src/brain/envelope";

const validOutput = {
  mood: "happy",
  pose: "base",
  bubble_short: "looks good",
  bubble_long: "",
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  xp_earned_events: [],
};

/** A complete result event, exactly as CC emits it with verbose OFF. */
function bareResultObject(resultText: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: resultText,
    total_cost_usd: 0.002,
    usage: {
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
      input_tokens: 30,
      output_tokens: 40,
    },
  });
}

function fakeSpawn(
  stdoutText: string,
  seen?: { argv: string[] },
): typeof Bun.spawn {
  return ((cmd: string[], _options: unknown) => {
    if (seen) seen.argv = cmd;
    return {
      stdin: { write(_c: string) {}, end() {} },
      stdout: new Response(stdoutText).body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as unknown as typeof Bun.spawn;
}

test("[12] runBrainCall passes --verbose so the array shape is ours, not the user's setting", async () => {
  const seen = { argv: [] as string[] };
  await runBrainCall({
    systemPrompt: "test",
    contextBundle: "ctx",
    spawnFn: fakeSpawn(bareResultObject("hi"), seen),
  }).catch(() => {});
  expect(seen.argv).toContain("--verbose");
  // The flag only helps if it reaches the same process as --output-format.
  expect(seen.argv.indexOf("--output-format")).toBeGreaterThan(-1);
});

test("[12] a bare result object (verbose OFF) is accepted, not rejected as 'not a JSON array'", async () => {
  const { output, usage } = await callBrain({
    systemPrompt: "test",
    contextBundle: "ctx",
    spawnFn: fakeSpawn(bareResultObject(JSON.stringify(validOutput))),
  });
  expect(output.bubble_short).toBe("looks good");
  expect(usage.output_tokens).toBe(40);
  expect(usage.total_cost_usd).toBe(0.002);
});

test("[12] the array shape still works (positive control — verbose ON is unchanged)", async () => {
  const stream = JSON.stringify([
    { type: "system", subtype: "init" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(validOutput),
      total_cost_usd: 0.001,
      usage: { input_tokens: 5, output_tokens: 6 },
    },
  ]);
  const { output } = await callBrain({
    systemPrompt: "test",
    contextBundle: "ctx",
    spawnFn: fakeSpawn(stream),
  });
  expect(output.bubble_short).toBe("looks good");
});

test("[12]/[4] an unusable shape names what actually arrived, not 'was not a JSON array'", async () => {
  const err = await runBrainCall({
    systemPrompt: "test",
    contextBundle: "ctx",
    spawnFn: fakeSpawn(JSON.stringify({ hello: "world" })),
  }).then(
    () => null,
    (e) => e as BrainError,
  );
  expect(err).toBeInstanceOf(BrainError);
  const msg = (err as BrainError).message;
  // Must describe the received shape. The old wording was a dead end for a
  // user: it named a type, not a cause.
  expect(msg).not.toBe("claude -p stdout was not a JSON array");
  expect(msg.toLowerCase()).toContain("result");
});

// ── Real captured envelopes, not hand-written ones ──────────────────────────
// The hand-written `bareResultObject` above encodes what I BELIEVE the
// verbose-off envelope looks like. These two files are what `claude -p`
// actually emitted on 2026-09-17 (CC 2.1.274), captured with one variable
// changed via `--settings '{"verbose": X}'` and scrubbed of session ids and
// absolute paths. If the belief and the capture ever disagree, the capture
// wins — that disagreement is exactly how defect [12]'s first root-cause
// diagnosis turned out to be wrong.

test("[12] the REAL verbose-off capture is a bare result object this code reads", () => {
  const raw = readFileSync("tests/fixtures/claude-envelope/verbose-off.json", "utf8");
  const parsed = JSON.parse(raw);
  expect(Array.isArray(parsed)).toBe(false);
  expect(parsed.type).toBe("result");

  const events = normalizeStreamEnvelope(parsed);
  expect(events).toHaveLength(1);
  const ev = findResultEvent(events);
  expect(typeof ev.result).toBe("string");
  expect(extractUsage(ev).output_tokens).toBeGreaterThan(0);
});

test("[12] the REAL verbose-on capture is an event array ending in a result", () => {
  const parsed = JSON.parse(
    readFileSync("tests/fixtures/claude-envelope/verbose-on.json", "utf8"),
  );
  expect(Array.isArray(parsed)).toBe(true);
  const events = normalizeStreamEnvelope(parsed);
  expect(events.length).toBeGreaterThan(1);
  expect(typeof findResultEvent(events).result).toBe("string");
  // The event-type collision that forced `classifierStdout` to exist is real
  // in this capture, not invented for the test.
  expect(events.some((e) => e.type === "rate_limit_event")).toBe(true);
});

test("[12] both real captures yield the same result text (shape differs, content does not)", () => {
  const off = findResultEvent(
    normalizeStreamEnvelope(
      JSON.parse(readFileSync("tests/fixtures/claude-envelope/verbose-off.json", "utf8")),
    ),
  );
  const on = findResultEvent(
    normalizeStreamEnvelope(
      JSON.parse(readFileSync("tests/fixtures/claude-envelope/verbose-on.json", "utf8")),
    ),
  );
  expect(off.result?.trim().length).toBeGreaterThan(0);
  expect(on.result?.trim().length).toBeGreaterThan(0);
});

// ── Cross-site invariant: the sibling paths must not drift apart again ───────
// [12] shipped because ONE site was fixed in review while two others built the
// same argv untouched (explain's `claude -p`, and chat's `stream-json`, which
// exits 1 outright without --verbose). Scan every argv literal in src/ rather
// than hand-listing the files.

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * Collect each argv array literal that starts with a `"claude"` element.
 *
 * Line-scanned, not bracket-matched: the first version used a regex that
 * stopped at the first `]`, and the `]` inside a `// Defect [12]` comment
 * truncated every literal just before the flag it was checking for — a
 * scanner that reported violations it had itself created.
 */
/**
 * Strip `//` line comments so the flag checks below run over CODE only.
 *
 * Without this, a comment inside the literal that quotes `"--verbose"` makes
 * the site read as compliant — and `chat-stream.ts`'s own comment is one
 * re-wrap away from producing that exact substring. A guard that a comment can
 * satisfy is not a guard.
 */
function stripLineComments(block: string): string {
  return block
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

function claudeArgvLiterals(src: string): string[] {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Key on `"-p",` and treat the binary element as a wildcard: the first
    // version keyed on a literal `"claude",` line, so a site written as
    // `const bin = resolveAgentBinary("claude"); const argv = [bin, "-p", …]`
    // was invisible to it — and the `>= 3` floor below would still have been
    // satisfied by the surviving three, so the guard would pass while the new
    // site shipped the exact bug. That shape already exists in this repo
    // (`src/cli/bootstrap.ts` calls `resolveAgentBinary("claude")`).
    if (!/^\s*"-p",\s*$/.test(lines[i]!)) continue;
    const collected: string[] = [];
    // Walk back to the opening bracket so the binary element is captured
    // whatever it is spelled as.
    let start = i;
    for (let k = i; k >= Math.max(0, i - 6); k--) {
      collected.unshift(lines[k]!);
      start = k;
      if (/\[\s*$/.test(lines[k]!) || /=\s*\[/.test(lines[k]!)) break;
    }
    void start;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
      collected.push(lines[j]!);
      if (/^\s*\]/.test(lines[j]!)) break;
    }
    out.push(stripLineComments(collected.join("\n")));
  }
  return out;
}

/**
 * CLIs other than `claude` that siltpoke drives with `-p --output-format json`.
 *
 * They are NOT required to pass `--verbose`: the measurement behind defect
 * [12] was made against `claude` only, and these are different binaries whose
 * flag behaviour is unmeasured. They are listed rather than pattern-excluded
 * so that a NEW fork — or an argv whose binary arrives in a variable — fails
 * this test and forces someone to decide, instead of slipping through.
 *
 * Worth recording: `ccfork-reviewer.ts:100-102` already accepts BOTH the event
 * array and a bare `type:"result"` object. The fork path carried the defense
 * `brain.ts` was missing.
 */
const NON_CLAUDE_P_BINARIES = ['"qodercli"', '"codebuddy"'];

test("[12] every `claude -p` argv in src/ passes --verbose", () => {
  const offenders: string[] = [];
  const unknownBinary: string[] = [];
  let claudeSites = 0;
  for (const file of tsFilesUnder("src")) {
    for (const literal of claudeArgvLiterals(readFileSync(file, "utf8"))) {
      // Both spellings: separate element, and the combined `=json` form the
      // first scanner could not see.
      if (!/"--output-format"|--output-format=/.test(literal)) continue;
      const flat = literal.replace(/\s+/g, " ");
      if (flat.includes('"claude",')) {
        claudeSites++;
        // Own-element match, the same shape the `"-p",` anchor uses — a
        // stray `"--verbose"` inside another string cannot stand in for the
        // real argument.
        if (!/^\s*"--verbose",?\s*$/m.test(literal)) {
          offenders.push(`${file}: ${flat.slice(0, 140)}`);
        }
        continue;
      }
      if (!NON_CLAUDE_P_BINARIES.some((b) => flat.includes(b))) {
        unknownBinary.push(`${file}: ${flat.slice(0, 140)}`);
      }
    }
  }
  expect(offenders).toEqual([]);
  // A `-p --output-format` site whose binary this test does not recognise —
  // a new fork, or one reached through a variable. Decide explicitly.
  expect(unknownBinary).toEqual([]);
  // EXACT, not a floor. An empty set matches an empty set, so the scan must be
  // asserted non-empty — but a `>= 3` floor is still satisfied when a fourth
  // site appears that the scanner cannot see. Pinning the count means a new
  // `claude -p` site forces someone to look at this line.
  expect(claudeSites).toBe(3);
});

test("[12] the invariant scanner can actually see a violation (device check)", () => {
  // Positive control, including a bracketed defect id in a comment — the exact
  // input that broke the first scanner.
  const bad = [
    "  const argv = [",
    '    "claude",',
    '    "-p",',
    '    "--model",',
    "    model,",
    '    "--output-format",',
    "    // note: defect [12] lives here",
    '    "json",',
    "  ];",
  ].join("\n");
  const found = claudeArgvLiterals(bad);
  expect(found.length).toBe(1);
  expect(found[0]!.includes('"--verbose"')).toBe(false);

  // Negative control: the same literal WITH the flag must pass.
  const good = bad.replace('    "json",', '    "json",\n    "--verbose",');
  const foundGood = claudeArgvLiterals(good);
  expect(foundGood.length).toBe(1);
  expect(foundGood[0]!.includes('"--verbose"')).toBe(true);

  // A comment that quotes the flag must NOT count as having it.
  const commented = [
    "  const argv = [",
    '    "claude",',
    '    "-p",',
    '    // exits 1 without "--verbose" on some hosts',
    '    "--output-format",',
    '    "json",',
    "  ];",
  ].join("\n");
  const foundCommented = claudeArgvLiterals(commented);
  expect(foundCommented.length).toBe(1);
  expect(/^\s*"--verbose",?\s*$/m.test(foundCommented[0]!)).toBe(false);

  // The evasion the first scanner was blind to: the binary arrives in a
  // variable instead of as a `"claude"` literal.
  const indirect = [
    '  const bin = resolveAgentBinary("claude");',
    "  const argv = [",
    "    bin,",
    '    "-p",',
    '    "--output-format",',
    '    "json",',
    "  ];",
  ].join("\n");
  const foundIndirect = claudeArgvLiterals(indirect);
  expect(foundIndirect.length).toBe(1);
  expect(foundIndirect[0]!.includes('"--verbose"')).toBe(false);
});
