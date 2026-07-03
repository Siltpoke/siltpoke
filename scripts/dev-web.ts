#!/usr/bin/env bun
/**
 * Dashboard dev loop — `bun run dev:web`.
 *
 * Why this exists: the daemon is a singleton (process-lock + pid + port-evict),
 * so Bun's in-process `--hot`/`--watch` can't reload it (the reloaded module
 * re-acquires its OWN lock → LockHeldError, and re-evicts its OWN port). Instead
 * this harness owns the daemon as a CHILD and does a clean full restart on every
 * edit: SIGTERM the child (its handler releases lock+pid+port) → wait exit →
 * respawn via the normal start path. No core-daemon change, no stale state.
 *
 * On each edit it also rebuilds Tailwind once (a one-shot CLI run, ~200ms) so
 * utility classes regenerate — driven by THIS file watcher rather than the
 * Tailwind `--watch` daemon, because the CLI's inode-based watcher misses the
 * atomic-rename writes most editors (and `sed -i`) use, whereas a recursive
 * `fs.watch` on the dir catches them. Net loop: edit a .tsx → save → (auto
 * rebuild + restart ~1-2s) → refresh browser (a NORMAL refresh — tailwind.css
 * + index.js are served no-store).
 *
 * Chat replies are MOCKED by default (SILTPOKE_TEST_MOCK_STREAM=1) so styling
 * iteration never spends on Brain. Unset it in your env to talk to the real LLM.
 */
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_ENTRY = join(repoRoot, "src", "cli", "daemon.ts");
const WATCH_DIR = join(repoRoot, "src", "web");
const DEBOUNCE_MS = 250;

/**
 * Default to mocked chat so UI iteration never hits the paid Brain path.
 * (No browser auto-reload: it forced a full page reload that dropped the
 * repo-graph's client-only drill state — refresh manually when you want to
 * pick up a UI change. A URL-state fix for repo-graph is the proper answer.)
 */
const childEnv = {
  ...process.env,
  SILTPOKE_TEST_MOCK_STREAM: process.env.SILTPOKE_TEST_MOCK_STREAM ?? "1",
};

let daemon: ReturnType<typeof Bun.spawn> | null = null;
let restarting = false;
let debounce: ReturnType<typeof setTimeout> | null = null;

function log(msg: string): void {
  process.stdout.write(`[dev:web] ${msg}\n`);
}

async function startDaemon(): Promise<void> {
  daemon = Bun.spawn(["bun", DAEMON_ENTRY, "start"], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function rebuildTailwind(): Promise<void> {
  const proc = Bun.spawn(
    ["bunx", "@tailwindcss/cli", "-i", "src/web/tokens/tailwind.css", "-o", "public/static/tailwind.css", "--minify"],
    { cwd: repoRoot, env: childEnv, stdio: ["ignore", "ignore", "inherit"] },
  );
  await proc.exited;
}

async function rebuildAndRestart(): Promise<void> {
  if (restarting) return;
  restarting = true;
  await rebuildTailwind(); // regenerate CSS first so the restarted daemon serves it fresh
  if (daemon) {
    daemon.kill(); // SIGTERM → daemon's handler releases lock+pid+port
    await daemon.exited;
  }
  await startDaemon();
  restarting = false;
  log("rebuilt + restarted — refresh the browser");
}

// 1. Build CSS once, then start the daemon child.
await rebuildTailwind();
await startDaemon();
log("dashboard at http://127.0.0.1:9876/repo-graph (chat MOCKED — unset SILTPOKE_TEST_MOCK_STREAM for real Brain)");

// 2. Watch src/web for .tsx/.ts edits → debounced rebuild + restart.
watch(WATCH_DIR, { recursive: true }, (_event, filename) => {
  if (!filename || !/\.(tsx|ts)$/.test(filename)) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    log(`change: ${filename} → rebuild + restart`);
    rebuildAndRestart().catch((err) => {
      log(`rebuild/restart failed: ${err instanceof Error ? err.message : String(err)}`);
      restarting = false; // don't wedge the loop on a transient failure
    });
  }, DEBOUNCE_MS);
});

// 3. Clean shutdown.
function shutdown(): void {
  log("shutting down");
  daemon?.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
