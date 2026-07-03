// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface FixtureAssertion {
  type: string;
  value: unknown;
  rule_id?: string;
}

export interface Fixture {
  id: string;
  description: string;
  intent_expected: string;
  input: Record<string, unknown>;
  assertions: FixtureAssertion[];
}

export async function loadFixtures(dir: string): Promise<Fixture[]> {
  const files = await readdir(dir);
  return Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(
        async (f) =>
          JSON.parse(await readFile(join(dir, f), "utf8")) as Fixture,
      ),
  );
}

export interface FixtureResult {
  fixture_id: string;
  passed: boolean;
  failures: string[];
}

function checkAssertion(
  a: FixtureAssertion,
  output: Record<string, unknown>,
): string | null {
  const evidence = output.evidence as Array<{ rule_id: string }> | undefined;
  const critique =
    typeof output.critique_for_claude === "string"
      ? output.critique_for_claude
      : "";

  switch (a.type) {
    case "intent_classification_equals": {
      const got = (output.intent as { classification?: string })
        ?.classification;
      return got !== a.value
        ? `intent: expected ${a.value}, got ${got}`
        : null;
    }
    case "critique_does_not_contain_word":
      return critique.toLowerCase().includes(String(a.value).toLowerCase())
        ? `critique contains forbidden word "${a.value}"`
        : null;
    case "trigger_rule_id":
      return evidence?.some((e) => e.rule_id === a.value)
        ? null
        : `expected rule_id ${a.value} not in evidence`;
    case "trigger_rule_id_prefix":
      return evidence?.some((e) => e.rule_id.startsWith(String(a.value)))
        ? null
        : `expected rule_id starting with ${a.value} not in evidence`;
    case "critique_contains_substring":
      return critique.toLowerCase().includes(String(a.value).toLowerCase())
        ? null
        : `critique missing required substring "${a.value}"`;
    default:
      return `unknown assertion type: ${a.type}`;
  }
}

export async function runFixture(
  fixture: Fixture,
  runCritique: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
): Promise<FixtureResult> {
  const output = await runCritique(fixture.input);
  const failures: string[] = [];

  for (const a of fixture.assertions) {
    const failure = checkAssertion(a, output);
    if (failure !== null) failures.push(failure);
  }

  return { fixture_id: fixture.id, passed: failures.length === 0, failures };
}
