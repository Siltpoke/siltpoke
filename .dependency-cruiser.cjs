/**
 * dependency-cruiser config — layer-boundary rules.
 *
 * Initially scaffolding only; boundaries locked incrementally:
 * - web/ → state/ boundary locked via state/api.ts port.
 * - web/routes/ → daemon/ boundary locked (web routes are pure SSR;
 *         daemon routes own all API + infra surfaces).
 *
 * Future candidates (deferred):
 *   - critic/ → brain/ via brain/api.ts port (deferred)
 *   - no cross-feature imports between domain folders
 *
 * Run: bun run audit:arch
 */
module.exports = {
  forbidden: [
    {
      name: "web-must-go-through-state-api",
      comment:
        "web/ layer must NOT import state/* directly. Use src/state/api.ts " +
        "as the read-write port. Adding a new export means: (a) add it to " +
        "api.ts, (b) audit read-write semantics for web consumption. " +
        "web/ must go through the state/api.ts port.",
      severity: "error",
      from: { path: "^src/web/" },
      to: {
        path: "^src/state/",
        pathNot: "^src/state/api\\.ts$",
      },
    },
    {
      name: "web-routes-no-daemon",
      comment:
        "web/routes/ must NOT import from daemon/* internals. Web routes " +
        "are pure SSR (render JSX, return HTML) and own no infrastructure. " +
        "API endpoints, hook ingestion, and infra surfaces live in " +
        "daemon/routes/. See src/web/routes/README.md + " +
        "src/daemon/routes/README.md for the ownership convention. " +
        "web routes are pure SSR; daemon wiring stays in daemon/.",
      severity: "error",
      from: { path: "^src/web/routes/" },
      to: { path: "^src/daemon/" },
    },
    {
      name: "seen-advance-human-origin-only-daemon-route",
      comment:
        "Only src/daemon/routes/seen.tsx may import " +
        "src/repo-graph/seen-advance.ts -- the module that owns " +
        "`withHumanOrigin`, the ONE exported way to mint the unforgeable " +
        "human-origin capability token that gates `advanceSeenFile`/" +
        "`markAllSeen` (slice 3, R13; see seen-advance.ts's file header). " +
        "(Fast-follow after slice ③ landed: the 3 seen handlers were " +
        "extracted out of repo-graph.tsx, which was 2x the 800-LOC hard " +
        "cap, into their own mount -- this rule's sole allowed importer " +
        "moved with them.) " +
        "depcruise resolves file-to-file edges, not individual named " +
        "imports, so this rule is deliberately a superset of the exact " +
        "guarantee: it blocks the WHOLE module from every other src/ file, " +
        "not just the `withHumanOrigin` binding specifically -- no other " +
        "producer (indexer, review runner, chat, ...) may mint its own " +
        "human_ui token by importing this file at all. There are no other " +
        "src/ importers today, so this costs nothing yet. If a future " +
        "module genuinely needs only the `SeenWriteOrigin` TYPE (not the " +
        "minting function), add a narrower re-export rather than loosening " +
        "this rule. (Scope note: `bun run audit:arch` only scans `src/`, so " +
        "tests/repo-graph/seen-advance.test.ts importing withHumanOrigin " +
        "directly -- to unit-test the capability mechanism itself -- is " +
        "out of this rule's reach by construction, not an oversight.)",
      severity: "error",
      from: { path: "^src/", pathNot: "^src/daemon/routes/seen\\.tsx$" },
      to: { path: "^src/repo-graph/seen-advance\\.ts$" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["main", "types"],
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/(@[^/]+/[^/]+|[^/]+)",
      },
    },
  },
};
