// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Its own file rather than a describe inside tests/installer/shim.test.ts:
// that file's top-level block sits at its function-length pin, and the ratchet
// only lets pins move down.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeShim } from "../../src/installer/shim";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "siltpoke-shim-bun-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("statusline shim, bun not on PATH", () => {
// Defect [21]: a user whose bun PATH lives only in ~/.bash_profile got a blank
  // statusline — the pet never appeared and nothing said why. The statusline is
  // the surface the user looks at every turn, so it is where this is reported;
  // the hook guards stay silent by rule.
  describe("bun not on PATH", () => {
    // A PATH with the system bins and no bun: the shell Claude Code actually
    // hands the statusline on the reporter's machine. `cat` still resolves, so
    // this is NOT the "nothing resolves at all" case above.
    const PATH_WITHOUT_BUN = "/usr/bin:/bin:/usr/sbin:/sbin";

    function liveRoot(): string {
      const root = join(home, "cache", "siltpoke-9.9.9");
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "siltpoke-card.js"), 'console.log("FACE");');
      writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
      return root;
    }

    test("recorded in ~/.siltpoke/bun-path → renders the card anyway", async () => {
      const shim = await writeShim(home);
      liveRoot();
      writeFileSync(join(home, ".siltpoke", "bun-path"), `${process.execPath}\n`);
      const r = Bun.spawnSync(["/bin/sh", shim], {
        env: { HOME: home, PATH: PATH_WITHOUT_BUN },
      });
      expect(new TextDecoder().decode(r.stdout).trim()).toBe("FACE");
    });

    test("genuinely unreachable → says so, rather than rendering blank", async () => {
      const shim = await writeShim(home);
      liveRoot();
      const r = Bun.spawnSync(["/bin/sh", shim], {
        env: { HOME: home, PATH: PATH_WITHOUT_BUN },
      });
      expect(r.exitCode).toBe(0);
      const out = new TextDecoder().decode(r.stdout);
      expect(out).toContain("bun");
      // Names the next step, and names a command this host really has — the
      // mistake defects [16] / [19] were both about.
      expect(out).toContain("/siltpoke-doctor");
      // One line: the statusline has exactly one.
      expect(out.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
    });
  });
});
