/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { ModelsPanel } from "../../../src/web/primitives/ModelsPanel";
import type { ModelsInfo } from "../../../src/web/primitives/ModelsPanel";

const BASE_INFO: ModelsInfo = {
  primary: { name: "Claude Haiku 4.5", provider: "Anthropic" },
  biasAudit: { name: "Qwen2.5-Coder-7B-Q4", provider: "Local Ollama", enabled: false },
  verifierMode: "conditional",
};

describe("ModelsPanel", () => {
  test("renders MODELS header", () => {
    const html = String(<ModelsPanel modelsInfo={BASE_INFO} />);
    expect(html).toContain("MODELS");
  });

  test("has models-panel class on root element", () => {
    const html = String(<ModelsPanel modelsInfo={BASE_INFO} />);
    expect(html).toContain('class="models-panel"');
  });

  test("shows primary model name and provider", () => {
    const html = String(<ModelsPanel modelsInfo={BASE_INFO} />);
    expect(html).toContain("Claude Haiku 4.5");
    expect(html).toContain("Anthropic");
  });

  test("shows bias audit model name and provider", () => {
    const html = String(<ModelsPanel modelsInfo={BASE_INFO} />);
    expect(html).toContain("Qwen2.5-Coder-7B-Q4");
    expect(html).toContain("Local Ollama");
  });

  test("shows verifier mode", () => {
    const html = String(<ModelsPanel modelsInfo={BASE_INFO} />);
    expect(html).toContain("verifier: conditional");
  });

  test("shows disabled status when bias audit is disabled", () => {
    const html = String(<ModelsPanel modelsInfo={BASE_INFO} />);
    expect(html).toContain("disabled");
  });

  test("shows enabled status when bias audit is enabled", () => {
    const enabled: ModelsInfo = {
      ...BASE_INFO,
      biasAudit: { ...BASE_INFO.biasAudit, enabled: true },
    };
    const html = String(<ModelsPanel modelsInfo={enabled} />);
    expect(html).toContain("enabled");
  });

  test("shows verifier mode: off when configured off", () => {
    const offMode: ModelsInfo = { ...BASE_INFO, verifierMode: "off" };
    const html = String(<ModelsPanel modelsInfo={offMode} />);
    expect(html).toContain("verifier: off");
  });
});
