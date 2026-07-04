// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `/siltpoke-graph` CLI entry.
 *
 * Mirrors `src/cli/report.ts`: ensures the daemon is up (lazy-spawn),
 * then opens the user's default browser to `/repo-graph` with the
 * current cwd's proj_hash deep-linked so the multi-repo picker lands
 * on the right repo.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoGraphLocation } from "../repo-graph/proj-hash";

async function ensureDaemonUp(homeBase: string): Promise<void> {
  const pidPath = join(homeBase, "siltpoked.pid");
  let alive = false;
  if (existsSync(pidPath)) {
    try {
      const r = await fetch("http://127.0.0.1:9876/api/ping", {
        signal: AbortSignal.timeout(250),
      });
      alive = r.ok;
    } catch {
      alive = false;
    }
  }
  if (!alive) {
    const daemonScript = new URL("./daemon.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", daemonScript, "start"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const r = await fetch("http://127.0.0.1:9876/api/ping", {
          signal: AbortSignal.timeout(100),
        });
        if (r.ok) return;
      } catch {
        /* keep polling */
      }
    }
    throw new Error("siltpoked failed to start within 3s");
  }
}

if (import.meta.main) {
  const noOpen = process.argv.includes("--no-open");
  const homeBase = join(process.env.HOME ?? "", ".siltpoke");

  await ensureDaemonUp(homeBase);

  const { proj_hash } = resolveRepoGraphLocation(process.cwd());
  const url = `http://127.0.0.1:9876/repo-graph?repo=${encodeURIComponent(proj_hash)}`;
  process.stdout.write(`Siltpoke repo-graph: ${url}\n`);
  if (!noOpen) {
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    Bun.spawn([cmd, url], { stdio: ["ignore", "ignore", "ignore"] });
  }
  process.exit(0);
}
