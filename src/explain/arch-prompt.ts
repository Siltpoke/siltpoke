// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Arch View LLM-derive — the C4 system prompt.
 *
 * Instructs the Brain to derive a grounded C4 container model from the whole-repo
 * signatures context. Hard rules: every claim carries ≥1 `[file:line]` (the `@
 * path:line` anchors in the context); emit strict JSON only; NO coordinates (code
 * lays out); NO `tier` field (grounding is the code's job, not the model's — the
 * model proposes + cites, code falsifies downstream).
 */

/** The output JSON contract, shown to the model verbatim. */
const OUTPUT_SHAPE = `{
  "boundary": "<repo name>",
  "bands": [
    { "id": "surfaces", "label": { "value": "Surfaces", "evidence": [{ "file": "src/x/y.ts", "line": 12 }] },
      "order": 0, "members": ["<container id>", ...] }
  ],
  "nodes": [
    { "id": "<container id: a subdir id, or comp:<subdir>/<short-name> when a subdir splits>", "kind": "cont",
      "title": { "value": "Daemon", "evidence": [{ "file": "src/daemon/server.ts", "line": 1 }] },
      "band": { "value": "surfaces", "evidence": [{ "file": "src/daemon/server.ts", "line": 1 }] },
      "desc": { "value": "local HTTP server", "evidence": [{ "file": "src/daemon/server.ts", "line": 8 }] },
      "drillTo": "<the subdir id>", "members": ["src/daemon/server.ts", ...] },
    { "id": "anthropic-api", "kind": "ext",
      "title": { "value": "Anthropic API", "evidence": [{ "file": "src/brain/brain.ts", "line": 81 }] },
      "band": { "value": "external", "evidence": [{ "file": "src/brain/brain.ts", "line": 81 }] } }
  ],
  "edges": [
    { "source": "critic", "target": "brain",
      "verb": { "value": "spawns claude -p", "evidence": [{ "file": "src/critic/run-critic.ts", "line": 140 }] } }
  ]
}`;

export const ARCH_SYSTEM_PROMPT = `You are deriving a C4 *container diagram* for a software repository from a signatures-only structural index. You produce a grounded architecture model — meaningful, but never invented.

GROUND TRUTH + EVIDENCE
- You are given, per subdirectory: its files (each as a "#### <file>" sub-block) and purpose, and every symbol's SIGNATURE (no bodies) under its file, each anchored with "@ path:line", plus cross-subdir import-edge counts. The per-file grouping shows you each directory's internal structure — use it to judge whether a directory is one component or several.
- EVERY claim you make (a band's label, a container's title/band/purpose, an edge's verb, an external system) MUST carry at least one "evidence" citation of the form {"file": "<repo-relative path>", "line": <n>} drawn from the "@ path:line" anchors you were shown. No citation → do not make the claim.
- Do NOT invent file paths or line numbers. Only cite anchors present in the context.

WHAT TO PRODUCE
1. CONTAINERS — default to COMPONENT granularity. A file or class that carries an independent responsibility is its own container. Merge multiple files into ONE container only when they are implementation details of a SINGLE responsibility — a main module together with its helpers, type-only files, tests, or an internal split of that same module. When in doubt, split. Decide purely from the code structure shown — NEVER from an assumed project type or any notion of what kind of system this is.
   - A directory that holds several independent responsibilities yields several containers: for each, id = "comp:<subdir>/<short-name>"; members = that component's own file path(s); title/desc grounded by citing those files; drillTo = the subdir id.
   - A directory whose files are one cohesive responsibility yields a single container: id = the subdir's last path segment; drillTo = the same subdir id; members = a few of its real file paths.
   - In all cases: title = a short human name; desc = a one-line purpose (use the given purpose when present, else infer from signatures and cite the file you inferred it from).
2. BANDS (layers): group containers into a few horizontal layers, ordered top→bottom from entry/surface (UI, hooks, CLI, server) down to infrastructure (config, utils, observability) and persistent state. List each band's member container ids. Give each band a short label. order = 0 at the top.
3. EDGES: for the important cross-subdir relationships, emit a VERB describing what the dependency MEANS (e.g. "spawns claude -p", "reads diff", "persists facts") — grounded in a signature/anchor that shows it. If you cannot find evidence for a specific verb, use "uses". Prefer the edges backed by the import-count summary.
4. EXTERNAL SYSTEMS: if a signature clearly reaches an external system (an HTTP API, a subprocess like "claude -p", the filesystem/git working tree), add an "ext" node citing the call site. Only when the evidence is unambiguous.

HARD RULES
- Output STRICT JSON matching the shape below, and nothing else. Wrapping it in a single \`\`\`json fence is permitted, but the JSON itself must be structurally valid and parseable.
- Do NOT output any "x", "y", "w", "h" coordinates — layout is done downstream.
- Do NOT output any "tier" field — grounding is verified downstream; you only propose + cite.
- Keep it legible: a handful of bands, containers at the granularity rule above (split a multi-responsibility directory, keep a cohesive one whole — never over-split), the meaningful edges (not every import).

OUTPUT SHAPE (exact keys):
${OUTPUT_SHAPE}`;
