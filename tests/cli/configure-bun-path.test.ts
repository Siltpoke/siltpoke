// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Its own file rather than a case inside tests/cli/configure.test.ts: that file
// sits at its length pin and the ratchet only lets pins move down.
import { describe, expect, test } from "bun:test";
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, parseArgs } from "../../src/cli/configure";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "siltpoke-cfg-bun-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const noAutostart = {
  installAutostart: async () => ({ status: "skipped" as const, platform: "test" }),
};

describe("configure records the bun interpreter", () => {
  // Defect [20]/[21] delivery half: hooks/lib/resolve-bun.sh and both shims read
  // ~/.siltpoke/bun-path, and setup is the ONLY writer. Without this the whole
  // fix rests on the ~/.bun/bin fallback, so anyone whose bun came from
  // Homebrew / asdf / a custom prefix would stay broken — while every test of
  // the readers passed.
  test("records the absolute path of bun, so the hooks can find it without PATH", async () => {
    await configure(parseArgs(["--name", "Silty", "--species", "slime"]), home, noAutostart);
    const recorded = readFileSync(join(home, ".siltpoke", "bun-path"), "utf8").trim();
    expect(recorded).toBe(process.execPath);
    // An absolute path is the entire point — a bare name would just be PATH again.
    expect(recorded.startsWith("/")).toBe(true);
  });
});
