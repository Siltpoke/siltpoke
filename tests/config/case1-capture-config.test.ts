import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCase1CaptureConfig } from "../../src/config/case1-capture-config";

function tmpHome(configJson?: object): string {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-case1cfg-"));
  if (configJson) {
    writeFileSync(join(home, "config.json"), JSON.stringify(configJson));
  }
  return home;
}

describe("loadCase1CaptureConfig", () => {
  it("defaults capture_case1=false when config.json is absent", async () => {
    const cfg = await loadCase1CaptureConfig(tmpHome());
    expect(cfg.capture_case1).toBe(false);
  });

  it("defaults capture_case1=false when the case1 key is missing", async () => {
    const cfg = await loadCase1CaptureConfig(tmpHome({ daemon: {} }));
    expect(cfg.capture_case1).toBe(false);
  });

  it("reads capture_case1=true from the case1 section", async () => {
    const cfg = await loadCase1CaptureConfig(tmpHome({ case1: { capture_case1: true } }));
    expect(cfg.capture_case1).toBe(true);
  });

  it("falls back to defaults on a malformed case1 section", async () => {
    const cfg = await loadCase1CaptureConfig(tmpHome({ case1: { capture_case1: "yes" } }));
    expect(cfg.capture_case1).toBe(false);
  });

  it("falls back to defaults on malformed JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-case1cfg-"));
    writeFileSync(join(home, "config.json"), "{not json");
    const cfg = await loadCase1CaptureConfig(home);
    expect(cfg.capture_case1).toBe(false);
  });
});
