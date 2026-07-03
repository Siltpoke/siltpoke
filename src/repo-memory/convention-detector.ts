// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { basename } from "node:path";
import { loadIndex } from "./index-builder.ts";
import type { RepoMemoryIndex, RepoMemoryConvention } from "./types.ts";
import type { RubricRule, RubricInput, RubricRuleResult, RubricTrigger } from "../critic/rubric/types.ts";

const SOURCE_EXTS = new Set(["ts", "tsx", "js", "jsx", "py"]);
const TEST_INFIX_RE = /\.(?:test|spec|golden|smoke|integration|e2e)(?=\.|$)/g;
const MIN_CONVENTION_CONFIDENCE = 0.8;

function getExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * Convention check: file name uses one of the project's accepted patterns,
 * after stripping common test/spec/golden infixes.
 *
 * Accepted:
 *  - kebab-case stem (`router-bash-parse.ts`, `dismiss.ts`)
 *  - dotted-kebab stem (`doctor.checks.ts`, `home-data.helpers.ts`) —
 *    used for "test-split sibling" pairs where one source file's tests
 *    split into multiple files (`doctor.test.ts` + `doctor.checks.test.ts`)
 *  - leading-underscore helper (`_doctor-fixtures.ts`, `_shared.ts`)
 *  - PascalCase root with optional dotted subnames (`Home`, `Home.data`,
 *    `Home.data.helpers`, `Critic.golden`). Applies to ALL source
 *    extensions, not just .tsx/.jsx — `Home.data.ts` is a legitimate
 *    sibling of `Home.tsx` and `Home.data.test.ts` is its test pair.
 *
 * Non-source extensions (.md, .json, system paths) are skipped — the
 * convention is detected against src/**\/*.{ts,tsx,js,jsx} only and
 * does not apply to docs or fixtures.
 */
function isAcceptableName(name: string): boolean {
  const ext = getExt(name);
  if (!SOURCE_EXTS.has(ext)) return true;

  const stem = name.slice(0, name.length - ext.length - 1).replace(TEST_INFIX_RE, "");
  if (stem.length === 0) return true;

  // kebab-case root with optional dotted-kebab subnames.
  // Matches: `dismiss`, `router-bash-parse`, `doctor.checks`,
  // `home-data.helpers`, `foo.bar.baz`.
  if (/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/.test(stem)) return true;

  // leading-underscore helper, kebab-case (with optional dotted subnames) inside
  if (/^_[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/.test(stem)) return true;

  // PascalCase root, optional dotted subnames (lowercase or camelCase OK)
  if (/^[A-Z][A-Za-z0-9]*(\.[A-Za-z0-9]+)*$/.test(stem)) return true;

  return false;
}

function checkFileAgainstConvention(
  filePath: string,
  convention: RepoMemoryConvention,
): RubricTrigger | null {
  if (convention.confidence < MIN_CONVENTION_CONFIDENCE) return null;

  const name = basename(filePath);
  if (!SOURCE_EXTS.has(getExt(name))) return null;

  if (convention.id === "naming-kebab-case-files") {
    if (!isAcceptableName(name)) {
      return {
        rule_id: "repo-memory-convention",
        tier: 1,
        severity: "med",
        file: filePath,
        line: 1,
        snippet: name,
        message: `File name "${name}" violates house convention: file names should use kebab-case (confidence: ${(convention.confidence * 100).toFixed(0)}%).`,
        suggested_fix: `Rename to ${name.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`).replace(/^-/, "")}.`,
      };
    }
  }

  return null;
}

export function makeConventionRule(indexLoader: (memoryDir?: string) => Promise<RepoMemoryIndex | null> = loadIndex): RubricRule {
  return {
    id: "repo-memory-convention",
    tier: 1,
    languages: ["ts", "tsx", "js", "jsx", "py"],
    async run(input: RubricInput): Promise<RubricRuleResult> {
      const t0 = performance.now();
      const triggers: RubricTrigger[] = [];

      const index = await indexLoader();
      if (!index || index.conventions.length === 0) {
        return { rule_id: "repo-memory-convention", triggers, duration_ms: performance.now() - t0 };
      }

      for (const file of input.changedFiles) {
        for (const convention of index.conventions) {
          const trigger = checkFileAgainstConvention(file, convention);
          if (trigger) {
            triggers.push(trigger);
            break; // one trigger per file
          }
        }
      }

      return { rule_id: "repo-memory-convention", triggers, duration_ms: performance.now() - t0 };
    },
  };
}

export const repoMemoryConventionRule: RubricRule = makeConventionRule();
