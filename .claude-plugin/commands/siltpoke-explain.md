---
description: Explain a file / function / symbol using siltpoke's code-map + Brain.
argument-hint: <target> [--depth 1|2] [--force] [--json]
---

The user wants siltpoke to explain a specific symbol or file in plain
English, grounded in the structural code-map built by
`/siltpoke-index`. The explain layer runs Brain (`claude -p`) on top of the
A's deterministic graph.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/explain.ts $ARGUMENTS
```

Target can be:

- bare symbol           — `runDoctor`
- file path             — `src/cli/doctor.ts`
- qualified path:symbol — `src/cli/doctor.ts:runDoctor` (disambiguator)

What happens:

1. Pre-check: `~/.siltpoke/repo-memory/{proj-hash}/meta.json` must
   exist. If not, prints "Run `/siltpoke-index` first" + exits 1.
2. Loads graph + queryIndex, builds symbol table.
3. Resolves target:
   - **0 matches** → suggests 3 closest via Levenshtein, exits 2.
   - **>1 matches** → emits ranked menu (`file:line`), exits 1. Re-run
     with the qualified `path:symbol` form to disambiguate.
   - **1 match** → continues.
4. Cache lookup (skipped when `--force`): if `meta.graph_indexed_ts`
   matches the cached explanation's, returns the cached markdown
   without re-spawning Brain.
5. Builds an N-hop subgraph (default depth=1; `--depth 2` for
   transitive callers).
6. Loads source files for nodes in the subgraph + scans target source
   for callee identifiers (query-time `calls` resolution since
   the graph's `calls` edges are empty).
7. Assembles a 16KB Brain prompt with target source + neighbor
   snippets (each capped at 600 chars, truncation marker inserted).
8. Spawns `claude -p` (model `claude-haiku-4-5` by default; override
   via `SILTPOKE_EXPLAIN_MODEL`).
9. Cost-cap gate: soft $0.005 (warn), hard $0.02 (abort + exit 3, no
   file written).
10. Scores citations: each `[file:line]` must reference a file in the
    graph + line within the file's known range. < 0.9 grounded =
    `low_confidence: true` banner.
11. If depth=1, appends footer hint "💡 Try `--depth 2` for transitive
    callers".
12. Writes markdown + sidecar JSON to
    `{cwd}/.siltpoke/explanations/{sha256(node_id)[:12]}.md`.

Show the CLI output verbatim. It contains:

- target H1 + plain-English summary
- "Defined in", "Calls", "Called by", "Imports" sections with inline
  `[file:line]` citations
- evidence score + Brain cost + cache path
- optional `⚠ low confidence` banner if grounding < 0.9
- optional `💡 Try --depth 2` footer when depth=1

For programmatic / scripting use: `bun ... explain.ts <target> --json`.

This is a **single-shot Brain call** per target. Hybrid
retrieval (fastembed over node summaries) + ReMindRAG-style edge
memory land in Phase C.
