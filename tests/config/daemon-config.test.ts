import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemonConfig } from "../../src/config/daemon-config";

function tmpHome(configJson?: object): string {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-daemoncfg-"));
  if (configJson) {
    writeFileSync(join(home, "config.json"), JSON.stringify(configJson));
  }
  return home;
}

describe("loadDaemonConfig", () => {
  it("defaults enabled=false when config.json is absent", async () => {
    const cfg = await loadDaemonConfig(tmpHome());
    expect(cfg.enabled).toBe(false);
  });

  it("defaults enabled=false when the daemon key is missing", async () => {
    const cfg = await loadDaemonConfig(tmpHome({ index: {} }));
    expect(cfg.enabled).toBe(false);
  });

  it("reads enabled=true from the daemon section", async () => {
    const cfg = await loadDaemonConfig(tmpHome({ daemon: { enabled: true } }));
    expect(cfg.enabled).toBe(true);
  });

  it("falls back to defaults on a malformed daemon section", async () => {
    const cfg = await loadDaemonConfig(tmpHome({ daemon: { enabled: "yes" } }));
    expect(cfg.enabled).toBe(false);
  });
});
