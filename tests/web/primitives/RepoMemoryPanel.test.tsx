/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { RepoMemoryPanel } from "../../../src/web/primitives/RepoMemoryPanel";
import type { RepoMemoryStats } from "../../../src/web/primitives/RepoMemoryPanel";

const STATS: RepoMemoryStats = {
  files: 42,
  topConvention: { id: "naming-kebab-case-files", confidence: 0.92 },
};

const STATS_NO_CONVENTION: RepoMemoryStats = {
  files: 10,
  topConvention: null,
};

describe("RepoMemoryPanel", () => {
  test("renders REPO MEMORY header", () => {
    const html = String(<RepoMemoryPanel repoMemoryStats={null} />);
    expect(html).toContain("REPO MEMORY");
  });

  test("has repo-memory-panel class on root element", () => {
    const html = String(<RepoMemoryPanel repoMemoryStats={null} />);
    expect(html).toContain('class="repo-memory-panel"');
  });

  test("renders CTA when null (no index built)", () => {
    const html = String(<RepoMemoryPanel repoMemoryStats={null} />);
    expect(html).toContain("Run /repo-memory to build");
  });

  test("shows view link", () => {
    const html = String(<RepoMemoryPanel repoMemoryStats={null} />);
    expect(html).toContain('href="/repo-memory"');
    expect(html).toContain("view");
  });

  test("shows files indexed count when data provided", () => {
    const html = String(<RepoMemoryPanel repoMemoryStats={STATS} />);
    expect(html).toContain("files indexed");
    expect(html).toContain("42");
  });

  test("shows top convention id and confidence", () => {
    const html = String(<RepoMemoryPanel repoMemoryStats={STATS} />);
    expect(html).toContain("naming-kebab-case-files");
    expect(html).toContain("92%");
  });

  test("shows no conventions yet when topConvention is null", () => {
    const html = String(<RepoMemoryPanel repoMemoryStats={STATS_NO_CONVENTION} />);
    expect(html).toContain("no conventions yet");
    expect(html).toContain("10");
  });
});
