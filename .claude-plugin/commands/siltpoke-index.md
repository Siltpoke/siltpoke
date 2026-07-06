---
description: Build / refresh siltpoke's structural code-map for this project (deterministic, no LLM).
argument-hint: [--force]
---

The user wants to (re)build siltpoke's structural index of their repo
— the substrate that `/siltpoke-explain` queries.

Run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/src/cli/index-repo.ts $ARGUMENTS
```

What happens:

1. Walks `*.ts/*.tsx/*.js/*.jsx/*.py` under the project root (skips
   `node_modules`, `dist`, `.git`, `.next`, `build`, `.siltpoke`,
   `.playwright-tmp`, `playwright-report`, `test-results`, `local_cache`,
   `coverage`, hidden dirs, files > 1MB).
2. Parses each file via tree-sitter, extracts a 5-node + 5-edge graph
   (the indexer populates `file`, `function`, `class`, `symbol` nodes
   plus `contains` + `imports` edges; `calls`, `extends`, `references`,
   `module` nodes layer on later).
3. Stores `graph.json` + `queryIndex.json` + `fingerprints.json` +
   `meta.json` under `~/.siltpoke/repo-memory/{proj-hash}/`.
4. Incremental: re-running only re-parses files whose content sha256
   changed. Pass `--force` to ignore the cache and rebuild from scratch.

Show the CLI output verbatim. It includes:
- counter breakdown (files walked vs cached, nodes by type, edges by
  type, files skipped + why)
- duration
- where the graph was saved

If output contains "files_walked: 0" AFTER an incremental run, that's
normal — all files matched cached fingerprints, no parse needed.

For programmatic / scripting use: `bun ... index-repo.ts --json`.

This is a **deterministic structural index** — no LLM involved. The
`/siltpoke-explain` slash consumes this graph.
