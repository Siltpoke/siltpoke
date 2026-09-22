// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `budgetCutFiles` — which files the review budget removed ENTIRELY.
 *
 * It exists so the evidence guard can tell "siltpoke dropped this file" from
 * "siltpoke never had it". Those produce an identical corpus (no bytes for the
 * cited file) and need different sentences: one is siltpoke's own limit and the
 * user can act on it by making a smaller change; the other they cannot.
 *
 * The distinction this file pins hardest is ENTIRELY vs PARTLY. A file with one
 * surviving hunk still has bytes in the corpus, so a citation into it CAN be
 * checked — listing it here would make the guard call a checkable review
 * unchecked. Mutating the filter to `omitted.map(h => h.file)` (dropping the
 * `!shownFiles.has(f)` clause) left the whole suite green before this existed.
 */
import { test, expect, describe } from "bun:test";
import { buildToolOutputSection } from "../../src/brain/prompt-tools";
import { GIT_DIFF_HUNK_BUDGET } from "../../src/brain/hunk-selection";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";

/** One diff hunk, in the shape the git-diff parser emits. */
function hunk(file: string, n: number) {
  return {
    file,
    header: `@@ -${n},3 +${n},3 @@`,
    body: `-const old${n} = ${n};\n+const new${n} = ${n};`,
  };
}

function sectionFor(hunks: ReturnType<typeof hunk>[]) {
  const nonOk = (tool: ToolName): ToolResult =>
    ({ tool, status: "not_applicable", parsed: [], raw: "" }) as ToolResult;
  return buildToolOutputSection({
    tsc: nonOk("tsc"),
    eslint: nonOk("eslint"),
    "git-diff": {
      tool: "git-diff",
      status: "ok",
      parsed: hunks,
      // REAL `git diff` shape, not the formatted `#### file` one. The scoper
      // keys on `diff --git a/<p> b/<p>` and deliberately passes through any
      // text it cannot parse rather than emptying a corpus it failed to read —
      // so a fixture in the wrong shape takes that pass-through path and the
      // corpus keeps every file, which makes the assertion below unfailable.
      raw: hunks
        .map(
          (h) =>
            `diff --git a/${h.file} b/${h.file}\n--- a/${h.file}\n+++ b/${h.file}\n${h.header}\n${h.body}`,
        )
        .join("\n"),
    } as ToolResult,
    ripgrep: nonOk("ripgrep"),
  });
}

describe("budgetCutFiles", () => {
  test("empty when nothing was cut", () => {
    const { budgetCutFiles } = sectionFor([hunk("src/a.ts", 1), hunk("src/b.ts", 2)]);
    expect(budgetCutFiles.size).toBe(0);
  });

  test("a file cut ENTIRELY is listed", () => {
    // Enough hunks to overflow the budget, spread so at least one file loses
    // all of its own.
    const hunks = Array.from({ length: GIT_DIFF_HUNK_BUDGET + 10 }, (_, i) =>
      hunk(`src/file-${i}.ts`, i + 1),
    );
    const { budgetCutFiles, evidenceCorpus } = sectionFor(hunks);

    expect(budgetCutFiles.size).toBeGreaterThan(0);
    // The property that matters: a listed file really is absent from the
    // corpus. Without this the set could name anything and still "pass".
    for (const f of budgetCutFiles) {
      expect(evidenceCorpus).not.toContain(f);
    }
  });

  test("a file that only lost SOME hunks is NOT listed", () => {
    // The mutation guard. One file with many hunks: the budget keeps some and
    // cuts the rest, so the file is in `omitted` AND in `shownFiles`. It still
    // has bytes in the corpus, so a citation into it is checkable and calling
    // it cut would make the guard report a checkable review as unchecked.
    const many = Array.from({ length: GIT_DIFF_HUNK_BUDGET + 10 }, (_, i) =>
      hunk("src/one-big-file.ts", i + 1),
    );
    const { budgetCutFiles } = sectionFor(many);

    expect(budgetCutFiles.has("src/one-big-file.ts")).toBe(false);
    expect(budgetCutFiles.size).toBe(0);
  });
});
