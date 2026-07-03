// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * `/siltpoke-index` CLI.
 *
 * On-demand structural repo-graph builder. Walks ts/tsx/js/jsx/py source
 * under the current project root, extracts a 5-node + 2-edge graph
 * (other edge kinds added later), persists JSON to
 * `~/.siltpoke/repo-memory/{proj-hash}/`.
 *
 * Usage:
 *   bun src/cli/index-repo.ts            # incremental rebuild
 *   bun src/cli/index-repo.ts --force    # full rebuild (ignores cache)
 *   bun src/cli/index-repo.ts --json     # structured output
 *   bun src/cli/index-repo.ts --progress # emit NDJSON progress lines (daemon)
 */
import { runIndexBuild, type IndexBuildResult } from "../repo-graph/builder";
import { ensureProject } from "../memory/project";
import { siltpokeRoot } from "../installer/paths";

export interface CliOptions {
  force: boolean;
  json: boolean;
  /** Stream `{"type":"progress","done","total"}` NDJSON to stdout. */
  progress: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  return {
    force: argv.includes("--force"),
    json: argv.includes("--json"),
    progress: argv.includes("--progress"),
  };
}

export function formatHuman(result: IndexBuildResult): string {
  const c = result.counters;
  const lines: string[] = [];
  lines.push(`siltpoke-index — built repo-graph for ${result.project_root}`);
  lines.push(`  walked ${c.files_walked} files (${c.files_cached} cached, ${c.files_walked} re-walked)`);
  lines.push(
    `  extracted ${c.nodes.file + c.nodes.function + c.nodes.class + c.nodes.module + c.nodes.symbol} nodes ` +
      `(${c.nodes.file} files, ${c.nodes.function} functions, ${c.nodes.class} classes, ${c.nodes.module} modules, ${c.nodes.symbol} symbols)`,
  );
  lines.push(
    `  extracted ${c.edges.contains + c.edges.imports + c.edges.calls} edges ` +
      `(${c.edges.contains} contains, ${c.edges.imports} imports, ${c.edges.calls} calls)`,
  );
  const skippedTotal =
    c.skipped.tree_sitter_failed + c.skipped.too_large + c.skipped.not_a_source_file + c.skipped.file_cap;
  if (skippedTotal > 0) {
    const capNote = c.skipped.file_cap > 0 ? `, ${c.skipped.file_cap} over file cap` : "";
    lines.push(
      `  skipped ${skippedTotal} files ` +
        `(${c.skipped.tree_sitter_failed} parse failed, ${c.skipped.too_large} too large, ${c.skipped.not_a_source_file} non-source${capNote})`,
    );
  }
  lines.push(`  duration: ${(result.duration_ms / 1000).toFixed(2)}s`);
  lines.push("");
  lines.push(`Graph saved to ${result.storage_dir}/`);
  return `${lines.join("\n")}\n`;
}

export function formatJson(result: IndexBuildResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runIndexBuild({
    cwd: process.cwd(),
    force: opts.force,
    onProgress: opts.progress
      ? (done, total) => process.stdout.write(`${JSON.stringify({ type: "progress", done, total })}\n`)
      : undefined,
  });
  // Unify repo stores — register the indexed repo in the memory-project store so
  // it also appears in the dashboard Memory rail. Best-effort + isolated: the index
  // already succeeded; a failed register (fs error) must never fail the index run,
  // and is self-healing (next index/chat writes it). Create-only inside ensureProject
  // so a re-index never clobbers a fact-bearing store.
  try {
    await ensureProject(siltpokeRoot(), result.project_root);
  } catch (err) {
    process.stderr.write(
      `siltpoke-index: could not register repo in Memory rail (index unaffected): ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
  if (opts.json) {
    process.stdout.write(formatJson(result));
  } else {
    process.stdout.write(formatHuman(result));
  }
  process.exit(0);
}
