// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { ArmResults } from "./runner";
import { ARMS } from "./runner";
import {
  mcnemarExact,
  type Verdict,
  verdict,
  wilsonInterval,
} from "./stats";

export interface VerdictReport {
  results: ArmResults;
  verdict: Verdict;
  body: string;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/**
 * Render a `verdict.md` body: per-arm catch table + Wilson CIs + McNemar b/c/p
 * + FP-rates + the explicit `graph earns keep` line + honest-limits note.
 *
 * Pure: computes the verdict from `results` and returns markdown. No I/O.
 */
export function writeVerdictMd(
  results: ArmResults,
  discordantFloor = 6,
): VerdictReport {
  if (!results.ok) {
    const body = [
      "# Caller-Impact Eval — verdict",
      "",
      `**ABORTED**: ${results.reason ?? "frozen-set guard failed (INV2)"}`,
      "",
      "No arms were run. Re-freeze the example set and recompute the manifest hash before retrying.",
      "",
    ].join("\n");
    return {
      results,
      verdict: {
        earnsKeep: "underpowered",
        rationale: "aborted: frozen-set guard failed",
      },
      body,
    };
  }

  const graph = results.armTables["graph-sigdelta"];
  const grep = results.armTables["grep-sigdelta"];
  const control = results.armTables["coherent-irrelevant"];

  const mcnemar = mcnemarExact(graph.caught, grep.caught);
  const v = verdict({
    mcnemar,
    graphCatch: graph.catchCount,
    grepCatch: grep.catchCount,
    controlCatch: control.catchCount,
    fpRates: Object.fromEntries(
      ARMS.map((a) => [a, results.armTables[a].fpRate]),
    ),
    discordantFloor,
  });

  const lines: string[] = [];
  lines.push("# Caller-Impact Eval — verdict");
  lines.push("");
  lines.push(
    `Frozen set; ${graph.caught.length} planted-bug examples; ${graph.controlCount} clean controls; ${results.repeats} repeat(s)/arm.`,
  );
  lines.push("");

  // Per-arm catch table with Wilson CIs.
  lines.push("## Per-arm catch (planted bugs)");
  lines.push("");
  lines.push("| arm | caught | n | rate | Wilson 95% CI |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const arm of ARMS) {
    const t = results.armTables[arm];
    const n = t.caught.length;
    const w = wilsonInterval(t.catchCount, n);
    lines.push(
      `| ${arm} | ${t.catchCount} | ${n} | ${pct(w.point)} | [${pct(w.lo)}, ${pct(w.hi)}] |`,
    );
  }
  lines.push("");

  // False-positive rates on controls.
  lines.push("## False-positive rate (clean controls)");
  lines.push("");
  lines.push("| arm | false positives | controls | FP rate |");
  lines.push("| --- | --- | --- | --- |");
  for (const arm of ARMS) {
    const t = results.armTables[arm];
    lines.push(
      `| ${arm} | ${t.falsePositiveCount} | ${t.controlCount} | ${pct(t.fpRate)} |`,
    );
  }
  lines.push("");

  // McNemar graph vs grep.
  lines.push("## McNemar — graph-sigdelta vs grep-sigdelta");
  lines.push("");
  lines.push(`- b (graph-caught, grep-missed): ${mcnemar.b}`);
  lines.push(`- c (grep-caught, graph-missed): ${mcnemar.c}`);
  lines.push(`- discordant pairs: ${mcnemar.discordant}`);
  lines.push(`- exact two-sided p: ${mcnemar.pValue.toFixed(4)}`);
  lines.push("");

  // The headline.
  lines.push(`**graph earns keep: ${v.earnsKeep}**`);
  lines.push("");
  lines.push(`> ${v.rationale}`);
  lines.push("");

  // Honest limits — OQ4.
  lines.push("## Honest limits");
  lines.push("");
  lines.push(
    "- **Grader is a different TIER, not a different FAMILY (OQ4).** Claude-only infra means the blind semantic grader runs on a different Claude tier than the arm under test, not a different model family. Cross-family confirmation is logged as an open question, not claimed.",
  );
  lines.push(
    "- The deterministic catch oracle is primary; semantic confirmation is secondary and only annotates.",
  );
  lines.push(
    "- Verdict semantics are pre-registered; `underpowered` (discordant < floor) is reported honestly and never massaged into a loss.",
  );
  lines.push("");

  return { results, verdict: v, body: lines.join("\n") };
}
