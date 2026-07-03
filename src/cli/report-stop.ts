// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const BASE = join(homedir(), ".siltpoke");
const PID_PATHS = [join(BASE, "siltpoked.pid"), join(BASE, "report.pid")];

export interface StopResult {
  killed: boolean;
  pid: number | null;
  source: string | null;
  error: string | null;
}

export function stopReport(pidPaths: string[] = PID_PATHS): StopResult {
  for (const p of pidPaths) {
    if (!existsSync(p)) continue;
    let pid: number;
    try {
      pid = Number(readFileSync(p, "utf8").trim());
    } catch (err) {
      return {
        killed: false,
        pid: null,
        source: p,
        error: `failed to read pidfile: ${(err as Error).message}`,
      };
    }
    if (!Number.isFinite(pid) || pid <= 0) {
      return { killed: false, pid: null, source: p, error: "pidfile empty or invalid" };
    }
    try {
      process.kill(pid, "SIGTERM");
      return { killed: true, pid, source: p, error: null };
    } catch (err) {
      return {
        killed: false,
        pid,
        source: p,
        error: `kill failed: ${(err as Error).message}`,
      };
    }
  }
  return { killed: false, pid: null, source: null, error: "no pidfile found" };
}

if (import.meta.main) {
  const result = stopReport();
  if (result.killed) {
    process.stdout.write(`Sent SIGTERM to pid=${result.pid} (${result.source})\n`);
    process.exit(0);
  }
  process.stderr.write(`siltpoke-report-stop: ${result.error}\n`);
  process.exit(1);
}
