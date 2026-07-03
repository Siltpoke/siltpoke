/** @jsxImportSource hono/jsx */
/**
 * RepoMemoryScreen smoke tests
 */
import { test, expect, describe } from "bun:test";
import { RepoMemoryScreen } from "../../../src/web/screens/RepoMemoryScreen";
import type { RepoMemoryIndex } from "../../../src/repo-memory/types";

const MOCK_INDEX: RepoMemoryIndex = {
  built_at: "2026-05-20T10:00:00Z",
  files: [
    { path: "src/foo/bar.ts", sha256: "abc", lang: "ts", summary_path: "abc.md" },
    { path: "src/foo/baz.ts", sha256: "def", lang: "ts", summary_path: "def.md" },
  ],
  conventions: [
    {
      id: "naming-kebab-case-files",
      description: "File names use kebab-case",
      pattern: "^[a-z]+(-[a-z]+)*\\.(ts|tsx|js|jsx)$",
      example_files: ["src/foo/bar.ts"],
      confidence: 0.9,
    },
  ],
};

describe("RepoMemoryScreen", () => {
  test("renders Dashboard shell and header", () => {
    const html = String(<RepoMemoryScreen index={null} />);
    expect(html).toContain("data-sidebar");
    expect(html).toContain("Repo Memory");
  });

  test("shows CTA when index is null", () => {
    const html = String(<RepoMemoryScreen index={null} />);
    expect(html).toContain("Run build to create repo-memory index");
    expect(html).toContain("Build now");
    expect(html).toContain('action="/api/repo-memory/build"');
  });

  test("renders index stats when index present", () => {
    const html = String(<RepoMemoryScreen index={MOCK_INDEX} />);
    expect(html).toContain("2");
    expect(html).toContain("Files indexed");
  });

  test("renders conventions when present", () => {
    const html = String(<RepoMemoryScreen index={MOCK_INDEX} />);
    expect(html).toContain("naming-kebab-case-files");
    expect(html).toContain("File names use kebab-case");
    expect(html).toContain("90%");
  });

  test("shows Rebuild button when index exists", () => {
    const html = String(<RepoMemoryScreen index={MOCK_INDEX} />);
    expect(html).toContain("Rebuild index");
  });

  test.skip("activeSection is repo-memory", () => {
    const html = String(<RepoMemoryScreen index={null} />);
    expect(html).toContain('href="/repo-memory"');
  });
});
