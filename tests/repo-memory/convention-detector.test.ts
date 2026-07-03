import { describe, test, expect } from "bun:test";
import { makeConventionRule } from "../../src/repo-memory/convention-detector.ts";
import type { RepoMemoryIndex } from "../../src/repo-memory/types.ts";

function makeIndexWithKebabConvention(confidence: number): RepoMemoryIndex {
  return {
    built_at: new Date().toISOString(),
    files: [],
    conventions: [
      {
        id: "naming-kebab-case-files",
        description: "File names use kebab-case",
        pattern: "^[a-z]+(-[a-z]+)*\\.(ts|tsx|js|jsx)$",
        example_files: ["src/foo-bar.ts", "src/baz-qux.ts"],
        confidence,
      },
    ],
  };
}

async function runAgainst(
  changedFiles: string[],
  confidence = 0.9,
  index?: RepoMemoryIndex | null,
): Promise<ReturnType<ReturnType<typeof makeConventionRule>["run"]>> {
  const loader = async () =>
    index === undefined ? makeIndexWithKebabConvention(confidence) : index;
  const rule = makeConventionRule(loader);
  return rule.run({ cwd: "/project", changedFiles, diffHunks: [] });
}

describe("convention-detector — kebab-case enforcement", () => {
  test("camelCase filename violates → MED trigger", async () => {
    const result = await runAgainst(["/project/src/myFile.ts"]);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].severity).toBe("med");
    expect(result.triggers[0].rule_id).toBe("repo-memory-convention");
    expect(result.triggers[0].message).toContain("myFile.ts");
  });

  test("kebab-case filename complies → no trigger", async () => {
    const result = await runAgainst(["/project/src/my-file.ts"]);
    expect(result.triggers).toHaveLength(0);
  });

  test("PascalCase .ts (non-tsx component pair) → no trigger", async () => {
    // Project convention: `Home.data.ts` is a legitimate sibling of `Home.tsx`.
    // Tests like `Home.data.test.ts` follow the same source case.
    const result = await runAgainst([
      "/project/src/Home.data.ts",
      "/project/src/Critic.ts",
    ]);
    expect(result.triggers).toHaveLength(0);
  });

  test("dotted PascalCase (Home.data.helpers) → no trigger", async () => {
    const result = await runAgainst([
      "/project/tests/web/screens/Home.data.helpers.test.ts",
      "/project/tests/web/screens/Home.data.shape.test.ts",
    ]);
    expect(result.triggers).toHaveLength(0);
  });

  test("dotted kebab-case test-split siblings (doctor.checks.test.ts) → no trigger", async () => {
    // Test-split convention: one CLI's tests grow large, split into
    // multiple files sharing the kebab-case root + dotted subname.
    const result = await runAgainst([
      "/project/tests/cli/doctor.checks.test.ts",
      "/project/tests/cli/doctor.test.ts",
      "/project/tests/cli/home-data.helpers.test.ts",
    ]);
    expect(result.triggers).toHaveLength(0);
  });

  test("leading-underscore helper (_doctor-fixtures.ts) → no trigger", async () => {
    const result = await runAgainst([
      "/project/tests/cli/_doctor-fixtures.ts",
      "/project/tests/web/screens/_home-data-fixtures.ts",
      "/project/tests/hooks/on-stop/_shared.ts",
    ]);
    expect(result.triggers).toHaveLength(0);
  });

  test("snake_case .ts (still invalid) → triggers", async () => {
    const result = await runAgainst(["/project/src/my_file.ts"]);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].message).toContain("my_file.ts");
  });

  test("camelCase .ts (still invalid) → triggers", async () => {
    const result = await runAgainst(["/project/src/badName.ts"]);
    expect(result.triggers).toHaveLength(1);
    expect(result.triggers[0].message).toContain("badName.ts");
  });
});

describe("convention-detector — guards (confidence + index state)", () => {
  test("low-confidence convention (< 0.8) → no trigger", async () => {
    const result = await runAgainst(["/project/src/myFile.ts"], 0.6);
    expect(result.triggers).toHaveLength(0);
  });

  test("no conventions in index → no trigger", async () => {
    const emptyIndex: RepoMemoryIndex = {
      built_at: new Date().toISOString(),
      files: [],
      conventions: [],
    };
    const result = await runAgainst(["/project/src/BadName.ts"], 0.9, emptyIndex);
    expect(result.triggers).toHaveLength(0);
  });

  test("null index → no trigger", async () => {
    const result = await runAgainst(["/project/src/BadName.ts"], 0.9, null);
    expect(result.triggers).toHaveLength(0);
  });
});

describe("convention-detector — exceptions (multi-dot, PascalCase, non-source)", () => {
  test("multi-dot test filename (foo.test.ts) → no trigger", async () => {
    const result = await runAgainst([
      "/project/tests/cli/report.golden.test.ts",
      "/project/tests/critic/run-critic.golden.test.ts",
      "/project/tests/cli/foo.test.ts",
      "/project/tests/critic/run-critic.integration.test.ts",
    ]);
    expect(result.triggers).toHaveLength(0);
  });

  test("PascalCase .tsx component-mirror test → no trigger", async () => {
    const result = await runAgainst([
      "/project/tests/web/screens/Critic.golden.test.tsx",
      "/project/tests/web/primitives/CritiqueAuditBlocks.golden.test.tsx",
      "/project/tests/web/atoms/Home.test.tsx",
    ]);
    expect(result.triggers).toHaveLength(0);
  });

  test("non-source extension (.md, /dev/null) → no trigger", async () => {
    const result = await runAgainst([
      "/project/RESUME.md",
      "/project/docs/notes/2026-05-21-notes.md",
      "/dev/null",
    ]);
    expect(result.triggers).toHaveLength(0);
  });
});
