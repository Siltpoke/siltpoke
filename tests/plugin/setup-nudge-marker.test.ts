// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The setup nudge's once-ever marker, after defect [33].
//
// Before the fix, the nudge went to a channel no Claude Code session shows,
// and `.nudged` was written anyway. The marker was renamed to `.setup-nudged`
// so the users burned that way — the ones the fix is for — still get the line
// once. Split out of hook-guard.test.ts, which sits at the file-length cap.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NUDGE_MARKER, NUDGE_TEXT, nudgeLine } from "../../src/hooks/hook-guard-core";

const REPO = process.cwd();
// dash over the platform sh, for the same reason as hook-guard.test.ts.
const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "sh";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-nudge-marker-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runStopSh() {
  return Bun.spawnSync([SHELL, join(REPO, "hooks", "stop.sh")], {
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: REPO },
    stdin: new TextEncoder().encode('{"session_id":"t"}'),
  });
}

describe("setup-nudge marker (defect [33])", () => {
  test("a user whose nudge was burned before the fix still gets it once", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", ".nudged"), "");
    const first = runStopSh();
    expect(first.exitCode).toBe(0);
    expect(new TextDecoder().decode(first.stdout)).toBe(nudgeLine(NUDGE_TEXT));
    expect(existsSync(join(home, ".siltpoke", NUDGE_MARKER))).toBe(true);
    // ...and only once: the new marker now silences it.
    expect(new TextDecoder().decode(runStopSh().stdout)).toBe("");
  });

  test("stop.sh and the Windows guard use the same marker name", () => {
    // Two names would let one platform's marker fail to suppress the other's
    // nudge on a machine that runs both, and the rename only helps if both
    // sides moved.
    expect(readFileSync(join(REPO, "hooks", "stop.sh"), "utf8")).toContain(
      `NUDGE_MARKER="\${SILTPOKE_DIR}/${NUDGE_MARKER}"`,
    );
  });
});
