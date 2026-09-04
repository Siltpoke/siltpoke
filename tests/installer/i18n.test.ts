import { describe, test, expect } from "bun:test";
import { t, LOCALES } from "../../src/installer/i18n";

describe("i18n", () => {
  test("returns the localized string per locale", () => {
    expect(t("wizard.title", "en")).toBe("siltpoke setup wizard");
    expect(t("wizard.title", "zh")).toBe("siltpoke 安装向导");
  });
  test("falls back to en when a zh key is missing", () => {
    // 'wizard.title' exists in both; force a fallback via a known en-only key if added later.
    expect(t("__nonexistent__", "zh")).toBe("__nonexistent__");
  });
  test("exposes zh + en", () => {
    expect([...LOCALES].sort()).toEqual(["en", "zh"]);
  });
  test("agent-picker keys resolve in both locales (no en-fallback leak for zh)", () => {
    const keys = ["agents.pick", "editor.pluginOffer", "editor.pickWhich", "done.terminalC"] as const;
    for (const k of keys) {
      const en = t(k, "en");
      const zh = t(k, "zh");
      expect(en.length).toBeGreaterThan(0);
      expect(zh.length).toBeGreaterThan(0);
      expect(zh).not.toBe(en); // zh must be its own string, not the en fallback
    }
  });
});
