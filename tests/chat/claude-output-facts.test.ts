// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// What `claude -p --verbose` reports about itself, read from a REAL captured
// output (tests/fixtures/claude-envelope/verbose-on.json).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeOutputFacts } from "../../src/chat/claude-output-facts";

const events = JSON.parse(readFileSync("tests/fixtures/claude-envelope/verbose-on.json", "utf8")) as unknown[];
const lines = events.map((e) => JSON.stringify(e));

test("reads model, version, tools, tokens and cost from a real claude -p --verbose output", () => {
  const f = claudeOutputFacts(lines);
  expect(f.reportedModel).toBe("claude-haiku-4-5-20251001");
  expect(f.cliVersion).toBe("2.1.274");
  expect(f.permittedTools?.length).toBe(160);
  expect(f.tokens).toEqual({ input: 9, output: 67, cache_read: 34951, cache_write: 0, thinking: 61 });
  expect(f.costUsd).toBeCloseTo(0.0038391, 7);
});

test("no result event (killed mid-call): model falls back to init, tokens and cost are null", () => {
  const f = claudeOutputFacts(lines.filter((l) => !l.includes('"type":"result"')));
  expect(f.reportedModel).toBe("claude-haiku-4-5-20251001");
  expect(f.tokens).toBeNull();
  expect(f.costUsd).toBeNull();
});

test("garbage and empty input give all-null facts, never a throw", () => {
  expect(claudeOutputFacts(["not json", "{}", "", "[1,2]"])).toEqual({
    reportedModel: null,
    cliVersion: null,
    permittedTools: null,
    tokens: null,
    costUsd: null,
  });
});

test("two models in modelUsage are both named", () => {
  const two = JSON.stringify({ type: "result", modelUsage: { "a-1": {}, "b-2": {} } });
  expect(claudeOutputFacts([two]).reportedModel).toBe("a-1, b-2");
});
