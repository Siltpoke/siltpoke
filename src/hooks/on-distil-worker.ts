// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { runDistilWorker } from "../memory/distil-worker";

export function parseWorkerArgs(argv: string[]): { home: string; state: string; cwd: string } {
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    if (i === -1 || i + 1 >= argv.length) throw new Error(`missing ${flag}`);
    return argv[i + 1];
  };
  return { home: get("--home"), state: get("--state"), cwd: get("--cwd") };
}

async function main(): Promise<void> {
  const { home, state, cwd } = parseWorkerArgs(Bun.argv.slice(2));
  await runDistilWorker(home, state, cwd).catch(() => {});
  process.exit(0);
}

// Only run when invoked as the bundled entrypoint, not when imported by tests.
if (import.meta.main) {
  void main();
}
