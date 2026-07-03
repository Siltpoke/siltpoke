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
    command: "bun run build:web && PORT=9877 SILTPOKE_ENV=test SILTPOKE_HOME=./.playwright-tmp/siltpoke SILTPOKE_TEST_MOCK_STREAM=1 bun src/cli/daemon.ts start",
    port: 9877,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
  },
});
