// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import patternsJson from "./secrets-patterns.json";
import type { RubricTrigger } from "../rubric/types";

interface SecretsPattern {
  id: string;
  regex: string;
  description: string;
}

interface CompiledPattern extends SecretsPattern {
  re: RegExp;
}

const PATTERNS: SecretsPattern[] = (
  patternsJson as { patterns: SecretsPattern[] }
).patterns;

// The aws-secret-key pattern uses (?i) inline flag which JS doesn't support.
// Compile with case-insensitive flag for that pattern; others are case-sensitive.
const COMPILED: CompiledPattern[] = PATTERNS.map((p) => {
  const hasInlineFlag = p.regex.startsWith("(?i)");
  const cleanRegex = hasInlineFlag ? p.regex.slice(4) : p.regex;
  const re = hasInlineFlag
    ? new RegExp(cleanRegex, "gi")
    : new RegExp(p.regex, "g");
  return { ...p, re };
});

export interface SecretsScanInput {
  file: string;
  addedLines: Array<{ line: number; text: string }>;
}

export function scanSecrets(input: SecretsScanInput): RubricTrigger[] {
  const triggers: RubricTrigger[] = [];

  for (const { line, text } of input.addedLines) {
    for (const p of COMPILED) {
      p.re.lastIndex = 0;
      if (p.re.test(text)) {
        triggers.push({
          rule_id: p.id,
          tier: 1,
          severity: "high",
          file: input.file,
          line,
          snippet: text.slice(0, 200),
          message: `Possible ${p.description} detected. Even test/example values leak into git history.`,
          suggested_fix:
            "Move to environment variable; add real value to .env (gitignored).",
        });
      }
    }
  }

  return triggers;
}
