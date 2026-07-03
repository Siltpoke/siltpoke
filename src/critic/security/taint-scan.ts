// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { RubricTrigger } from "../rubric/types";

export interface TaintScanInput {
  file: string;
  source: string;
  addedLines?: Set<number>; // optional: only flag added lines (else flag all)
}

interface SinkPattern {
  name: string;
  regex: RegExp;
  kind: "cmd" | "ssrf" | "path" | "sqli" | "xss";
}

const SINKS: SinkPattern[] = [
  { name: "exec/spawn", regex: /\b(exec|spawn|execSync|spawnSync)\s*\(/, kind: "cmd" },
  { name: "fetch", regex: /\bfetch\s*\(/, kind: "ssrf" },
  {
    name: "fs.read/write",
    regex: /\bfs\.(readFile|writeFile|unlink|readFileSync|writeFileSync)\s*\(/,
    kind: "path",
  },
  {
    name: "db.raw",
    regex: /\b(db|knex|sequelize|prisma)\.raw\s*\(/,
    kind: "sqli",
  },
  { name: "innerHTML", regex: /(dangerouslySetInnerHTML|\.innerHTML\s*=)/, kind: "xss" },
  { name: "eval", regex: /\beval\s*\(/, kind: "cmd" },
];

const SOURCE_REGEX =
  /\b(req\.(body|query|params|headers)|process\.env|argv|userInput|searchParams\.get)\b/;

const SANITIZER_REGEX =
  /\b(sanitize|escape|normalize|parse|encodeURI|encodeURIComponent|validator\.|joi\.|zod\.)\b/;

export function scanTaint(input: TaintScanInput): RubricTrigger[] {
  const triggers: RubricTrigger[] = [];
  const lines = input.source.split("\n");

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;
    if (input.addedLines && !input.addedLines.has(lineNum)) return;

    for (const sink of SINKS) {
      if (!sink.regex.test(line)) continue;

      // Check window: sink line ± 1 (in case source is on adjacent line)
      const window = [lines[idx - 1] ?? "", line, lines[idx + 1] ?? ""].join(" ");

      if (!SOURCE_REGEX.test(window)) continue;
      if (SANITIZER_REGEX.test(window)) continue;

      triggers.push({
        rule_id: `taint-${sink.kind}`,
        tier: 2,
        severity: "high",
        file: input.file,
        line: lineNum,
        snippet: line.slice(0, 200),
        message: `Potential ${sink.kind} via ${sink.name}: untrusted source flows to sink without sanitizer.`,
        suggested_fix: `Sanitize/validate input before passing to ${sink.name}.`,
      });
    }
  });

  return triggers;
}
