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
