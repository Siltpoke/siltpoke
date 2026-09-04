import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // Seeds a fixture repo-graph into the e2e SILTPOKE_HOME before the daemon
  // starts so /repo-graph specs can drive the real cytoscape render.
  globalSetup: "./tests/e2e/_setup/seed-repo-graph.ts",
  fullyParallel: false, // sequential — single shared daemon
  forbidOnly: !!process.env.CI,
  retries: 0, // no retries — flake-mask is forbidden
  workers: 1, // single worker, no port conflicts
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:9877", // dedicated e2e port
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  timeout: 15_000,
  expect: { timeout: 10_000 },
  webServer: {
    // SILTPOKE_TEST_KNOWLEDGE_DOCS_ROOT points the daemon's built-in "repo"
    // knowledge source at a small seeded fixture tree (see
    // tests/e2e/_setup/knowledge-e2e-fixtures.ts) instead of this repo's own
    // docs/ (850+ files, ~19s cold walk locally -- was blowing past
    // knowledge.spec.ts's 30s cold-index ceiling on CI). Read in
    // src/daemon/server.ts, double-gated there on SILTPOKE_ENV === "test" so
    // this var alone can never repoint a production daemon.
    //
    // `bun tests/e2e/_setup/seed-progress-fixture.ts &&` runs FIRST, before
    // the daemon starts: `/progress`'s nav entry is decided ONCE at daemon
    // boot (src/web/routes/nav.ts), so its ROADMAP.md fixture must exist in
    // SILTPOKE_TEST_KNOWLEDGE_DOCS_ROOT before this process starts, not by
    // the time any spec's test.beforeAll or the declared globalSetup file
    // runs (both measured to run AFTER the daemon is already answering
    // requests — see that script's doc comment).
    command: "bun run build:web && PORT=9877 SILTPOKE_ENV=test SILTPOKE_HOME=./.playwright-tmp/siltpoke SILTPOKE_TEST_MOCK_STREAM=1 SILTPOKE_TEST_KNOWLEDGE_DOCS_ROOT=./.playwright-tmp/knowledge-fixture bun src/cli/daemon.ts start",
    port: 9877,
    timeout: 60_000,
    // FOOTGUN: `command` (which runs build:web → rebuilds public/static/index.js)
    // only runs when Playwright STARTS the server. With reuse=true, an already-
    // running 9877 daemon is reused and the rebuild is skipped — so after editing
    // a client island (src/web/client/**), the e2e runs against the STALE bundle
    // from the previous build. Symptom: your UI change/fix "doesn't work" in e2e.
    // Fix: `lsof -ti :9877 | xargs kill -9` (or `bun run build:client`) before re-running.
    reuseExistingServer: !process.env.CI,
  },
});
