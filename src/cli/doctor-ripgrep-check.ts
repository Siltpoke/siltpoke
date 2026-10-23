// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * "Can the review run ripgrep?" — the row for the checker every review uses.
 *
 * WHY — Windows Run 4 (install audit §110 W4, 2026-10-14): the box had no `rg`,
 * so the first review said "No checker ran (ripgrep unavailable)", and doctor
 * had passed every row a few minutes before. ripgrep is the one checker that
 * runs on every language; tsc and eslint only run on TS/JS. Without it a review
 * of a Python change runs with no checker at all.
 *
 * It RUNS `rg --version` and reads the answer, the same bare `rg` the review
 * spawns (`run-ripgrep.ts` defaults `rgBin` to "rg"), instead of asking whether
 * a file named rg is on PATH: a shim or a wrong program would pass that.
 *
 * Warn, never fail: reviews still run without it, they just lose the checker.
 */
import { spawnSync } from "node:child_process";
import type { CheckResult, DoctorOptions } from "./doctor";

export { TIMED_OUT as RIPGREP_TIMED_OUT };
export const RIPGREP_ROW = "ripgrep available (review checker)";

export interface RipgrepProbe {
  /** Run `rg --version`: its stdout, "timeout" when it did not answer in time, null when it could not start or failed. */
  version?: () => string | null | typeof TIMED_OUT;
}

const TIMED_OUT = Symbol("timed out");

function defaultVersion(): string | null | typeof TIMED_OUT {
  try {
    const r = spawnSync("rg", ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true, env: process.env });
    // A slow first start (antivirus scanning a fresh rg.exe) is not "missing".
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") return TIMED_OUT;
    if (r.error || r.status !== 0) return null;
    return r.stdout;
  } catch {
    return null;
  }
}

/** How to install ripgrep on this platform, in one command. */
export function ripgrepInstallHint(platform: NodeJS.Platform): string {
  if (platform === "win32") return "winget install BurntSushi.ripgrep.MSVC";
  if (platform === "darwin") return "brew install ripgrep";
  return "your package manager's `ripgrep` package (e.g. sudo apt install ripgrep)";
}

export function checkRipgrep(opts: DoctorOptions, probe: RipgrepProbe = {}): CheckResult {
  const answer = (probe.version ?? defaultVersion)();
  if (answer === TIMED_OUT) {
    return {
      name: RIPGREP_ROW,
      pass: true,
      status: "warn",
      detail: "`rg --version` did not answer within 10 seconds. Run doctor again; if it repeats, reviews will lose their search checker the same way.",
    };
  }
  const out = answer;
  const first = out?.split(/\r?\n/)[0]?.trim() ?? "";
  if (first.startsWith("ripgrep ")) {
    return { name: RIPGREP_ROW, pass: true, status: "pass", detail: first };
  }
  const hint = ripgrepInstallHint(opts.platform ?? process.platform);
  const what = out === null ? "`rg` could not be started" : `\`rg --version\` did not answer as ripgrep ("${first}")`;
  return {
    name: RIPGREP_ROW,
    pass: true,
    status: "warn",
    detail: `${what}, so reviews run without their search checker. Install it: ${hint} — then open a new terminal.`,
  };
}
