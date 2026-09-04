// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemonConfig } from "../../src/config/daemon-config";
import { setDaemonEnabled } from "../../src/config/write-daemon-enabled";

describe("setDaemonEnabled", () => {
  it("creates config.json with daemon.enabled=true when absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-setcfg-"));
    await setDaemonEnabled(home, true);
    expect((await loadDaemonConfig(home)).enabled).toBe(true);
  });

  it("preserves other sections when flipping the flag", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-setcfg-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ index: { timeoutMs: 123 } }),
    );
    await setDaemonEnabled(home, true);
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(raw.index.timeoutMs).toBe(123);
    expect(raw.daemon.enabled).toBe(true);
  });
});
