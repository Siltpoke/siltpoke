/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { FewShotPanel } from "../../../src/web/primitives/FewShotPanel";
import type { FewShotStats } from "../../../src/web/primitives/FewShotPanel";

const STATS: FewShotStats = {
  entries: 7,
  dim: 384,
  embedder: "stub",
};

const FASTEMBED_STATS: FewShotStats = {
  entries: 12,
  dim: 384,
  embedder: "fastembed",
};

describe("FewShotPanel", () => {
  test("renders FEW-SHOT header", () => {
    const html = String(<FewShotPanel fewShotStats={null} />);
    expect(html).toContain("FEW-SHOT");
  });

  test("has few-shot-panel class on root element", () => {
    const html = String(<FewShotPanel fewShotStats={null} />);
    expect(html).toContain('class="few-shot-panel"');
  });

  test("renders empty state when null", () => {
    const html = String(<FewShotPanel fewShotStats={null} />);
    expect(html).toContain("no index found");
  });

  test("shows explore link", () => {
    const html = String(<FewShotPanel fewShotStats={null} />);
    expect(html).toContain('href="/few-shot"');
    expect(html).toContain("explore");
  });

  test("shows entry count when data provided", () => {
    const html = String(<FewShotPanel fewShotStats={STATS} />);
    expect(html).toContain("entries");
    expect(html).toContain("7");
  });

  test("shows embedding dim", () => {
    const html = String(<FewShotPanel fewShotStats={STATS} />);
    expect(html).toContain("dim");
    expect(html).toContain("384");
  });

  test("shows stub embedder status", () => {
    const html = String(<FewShotPanel fewShotStats={STATS} />);
    expect(html).toContain("embedder:");
    expect(html).toContain("stub");
  });

  test("shows fastembed (local) when embedder is fastembed", () => {
    const html = String(<FewShotPanel fewShotStats={FASTEMBED_STATS} />);
    expect(html).toContain("fastembed (local)");
  });
});
