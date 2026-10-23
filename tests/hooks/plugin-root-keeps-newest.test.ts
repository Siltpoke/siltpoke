// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [91] (audit §104): with several hosts installed, every host's hook
// wrote ITS plugin copy into `<siltpoke home>/plugin-root`, and the dashboard
// daemon restarts from that pointer. So the daemon ran whichever copy belonged
// to the host that last opened a session — on the maintainer's machine a
// codex cache built 2026-09-26 while Claude Code's copy was built 2026-10-16.
// All copies said version 1.3.0, so the version could not tell them apart.
//
// The rule now: a hook moves the pointer only to a copy whose daemon bundle is
// at least as new as the one the pointer names, or when the named copy is gone.
// Both writers are pinned — the Unix `hooks/session-start.sh` and the
// TypeScript `writePluginRootPointer` the Windows guard uses.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePluginRootPointer } from "../../src/hooks/hook-guard-core";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const SCRIPT = join(REPO, "hooks", "session-start.sh");

let sandbox: string;
let sp: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "siltpoke-root-newest-"));
  sp = join(sandbox, "siltpoke");
  mkdirSync(sp, { recursive: true });
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

/** A plugin copy whose daemon bundle was built at `when` (or has no bundle). */
function copy(name: string, when: Date | null): string {
  const root = join(sandbox, name);
  mkdirSync(join(root, "dist"), { recursive: true });
  if (when !== null) {
    const bundle = join(root, "dist", "siltpoke-daemon.js");
    writeFileSync(bundle, "// bundle\n");
    utimesSync(bundle, when, when);
  }
  return root;
}

const OLD = new Date("2026-09-26T11:59:00Z");
const NEW = new Date("2026-10-16T09:18:00Z");

const pointer = (): string | null => (existsSync(join(sp, "plugin-root")) ? readFileSync(join(sp, "plugin-root"), "utf8") : null);
const setPointer = (root: string): void => writeFileSync(join(sp, "plugin-root"), root);

type Writer = (root: string) => void;

const viaShell: Writer = (root) => {
  const r = Bun.spawnSync(["/bin/sh", SCRIPT], {
    stdin: new TextEncoder().encode("{}"),
    env: { PATH: "/usr/bin:/bin", HOME: join(sandbox, "home"), SILTPOKE_HOME: sp, CLAUDE_PLUGIN_ROOT: root },
  });
  expect(r.exitCode).toBe(0);
};

const viaGuard: Writer = (root) => {
  writePluginRootPointer({ SILTPOKE_HOME: sp, HOME: join(sandbox, "home"), CLAUDE_PLUGIN_ROOT: root }, "");
};

for (const [name, write] of [
  ["hooks/session-start.sh", viaShell],
  ["writePluginRootPointer (Windows guard)", viaGuard],
] as const) {
  describe(`[91] ${name}: the pointer keeps the newest copy`, () => {
    test("an older copy's hook does not move the pointer off a newer one", () => {
      const newer = copy("claude-cache", NEW);
      const older = copy("codex-cache", OLD);
      setPointer(newer);
      write(older);
      expect(pointer()).toBe(newer);
    });

    test("a newer copy's hook moves the pointer forward", () => {
      const newer = copy("claude-cache", NEW);
      const older = copy("codex-cache", OLD);
      setPointer(older);
      write(newer);
      expect(pointer()).toBe(newer);
    });

    test("equally new: the hook that ran last wins, as before", () => {
      const a = copy("a", NEW);
      const b = copy("b", NEW);
      setPointer(a);
      write(b);
      expect(pointer()).toBe(b);
    });

    test("no pointer yet: written", () => {
      const a = copy("a", OLD);
      write(a);
      expect(pointer()).toBe(a);
    });

    test("the named copy is gone: replaced even by an older one", () => {
      const older = copy("codex-cache", OLD);
      setPointer(join(sandbox, "removed-copy"));
      write(older);
      expect(pointer()).toBe(older);
    });

    test("the named copy lost its bundle: replaced", () => {
      const broken = copy("broken", null);
      const older = copy("codex-cache", OLD);
      setPointer(broken);
      write(older);
      expect(pointer()).toBe(older);
    });

    test("a copy without a bundle does not displace one that has it", () => {
      const good = copy("good", OLD);
      const broken = copy("broken", null);
      setPointer(good);
      write(broken);
      expect(pointer()).toBe(good);
    });
  });
}
