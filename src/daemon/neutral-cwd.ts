// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Move the daemon into the filesystem root before it serves anything.
 *
 * Every `claude -p` the daemon spawns inherits its folder, and claude loads
 * that folder's project settings — CLAUDE.md into context, and
 * `.claude/settings.json` hooks that RUN, with no trust prompt in print mode.
 *
 * Under launchd the daemon already sits in `/` (measured 2026-10-18: the live
 * 9876 daemon's cwd was `/`), and the daemon's own code assumes that
 * (`src/memory/memory.ts`, `src/web/routes/memory.tsx`). But it is also
 * started by `/siltpoke:siltpoke-dashboard`, by `daemon-restart`, and by a Stop
 * hook that finds it down (`src/hooks/on-stop.ts`) — and none of those pass a
 * cwd, so the daemon lived in whatever project the user was in. From a codex
 * or agy session, that is a folder claude never asked the user to trust.
 *
 * One move at the entry covers every start path, including ones added later.
 * The root of the CURRENT path, not a literal "/": on Windows that is the
 * drive root (`C:\`).
 *
 * A relative path in the environment meant "relative to where I started you"
 * — the e2e suite starts the daemon with `SILTPOKE_HOME=./.playwright-tmp/…`.
 * After the move it would mean "relative to /", so each path-valued variable
 * is made absolute FIRST. That covers values read after the move; values a
 * module read at import time are covered by `siltpokeRoot()` returning an
 * absolute path. `tests/daemon/neutral-cwd.test.ts` fails if src/ names a
 * `SILTPOKE_*` variable that is in neither this list nor its non-path list.
 */

import { isAbsolute, parse, resolve } from "node:path";

export const PATH_ENV_VARS = [
  "SILTPOKE_HARNESS_OUT",
  "SILTPOKE_HOME",
  "SILTPOKE_ICEBOX_MD",
  "SILTPOKE_MARKER_DIR",
  "SILTPOKE_QUESTS_YAML",
  "SILTPOKE_TEST_KNOWLEDGE_DOCS_ROOT",
  "SILTPOKE_WASM_DIR",
] as const;

export function moveToNeutralCwd(
  chdir: (dir: string) => void = process.chdir,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const name of PATH_ENV_VARS) {
    const value = env[name];
    if (value && !isAbsolute(value)) env[name] = resolve(cwd, value);
  }
  const root = parse(cwd).root;
  chdir(root);
  return root;
}
