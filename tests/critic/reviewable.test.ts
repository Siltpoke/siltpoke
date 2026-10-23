// `isReviewable` decides whether a changed file is something the AI reviewer
// must read (gate spec 2026-08-20 §4.3, D6): "would a mistake in this file
// change how the system behaves?" Exclusions are by extension or file-name
// shape, never by directory — except `dist/`, which the spec lists by name.
import { describe, expect, test } from "bun:test";
import { isReviewable, anyReviewable } from "../../src/critic/reviewable";

describe("isReviewable — included", () => {
  const included = [
    // code, any language (AC32: the rule exists for other people's repos)
    "src/billing.ts",
    "app/models/user.rb",
    "src/main/java/App.java",
    "app/src/main/kotlin/Main.kt",
    "server.go",
    "lib.rs",
    "tool.py",
    // tests are code
    "tests/billing.test.ts",
    // executables and scripts (AC8)
    "deploy.sh",
    "Makefile",
    "scripts/setup.ps1",
    // infrastructure / deploy
    "Dockerfile",
    "infra/main.tf",
    "docker-compose.yml",
    ".github/workflows/ci.yml",
    // schema / migrations
    "schema.sql",
    "migrations/0001_init.sql",
    // config with behaviour
    "tsconfig.json",
    "package.json",
    // executable code under a docs or agent-config directory (AC25)
    ".claude/hooks/stop.sh",
    "docs/samples/auth.py",
    // a file nobody can classify defaults to IN
    "weird.xyz",
    "LICENSE-NOTES",
    ".gitignore",
    // hand-written scripts under build/ or out/ — never excluded by directory
    "build/deploy.sh",
    "build/Dockerfile",
    "build/main.js",
    "cmd/tool/out/main.go",
    // .txt files that change behaviour outrank the .txt exclusion
    "requirements.txt",
    "requirements-dev.txt",
    "CMakeLists.txt",
  ];
  for (const p of included) {
    test(p, () => {
      expect(isReviewable(p)).toBe(true);
    });
  }
});

describe("isReviewable — excluded", () => {
  const excluded = [
    // documentation, by extension
    "README.md",
    "docs/guide.mdx",
    "notes.rst",
    // assets / binaries
    "logo.png",
    "photo.JPG",
    "paper.pdf",
    "font.woff2",
    // generated
    "dist/siltpoke-stop.js",
    "package-lock.json",
    "bun.lock",
    "yarn.lock",
    "vendor.min.js",
    "app.js.map",
    // data / logs / output
    "results.csv",
    "table.tsv",
    "run.log",
    "output.txt",
    ".env.example",
    // agent configuration: .md / .json under .claude/
    ".claude/settings.json",
    ".claude/CLAUDE.md",
    ".claude/hooks/hooks.json",
    // the generated shapes hunk-selection already demotes
    "vendor/lib/a.js",
    "vendor/requirements.txt",
    "node_modules/pkg/requirements.txt",
    "coverage/lcov-report/a.js",
    "node_modules/x/index.js",
    ".next/server/page.js",
    "tests/__snapshots__/a.test.ts.snap",
    "pnpm-lock.yaml",
    "go.sum",
    "styles.min.css",
    // case does not matter
    "README.MD",
    "DIST/app.js",
    "APP.MIN.JS",
    // nested
    "config/.env.example",
  ];
  for (const p of excluded) {
    test(p, () => {
      expect(isReviewable(p)).toBe(false);
    });
  }
});

describe("isReviewable — path shapes", () => {
  test("absolute paths are judged by the same rules", () => {
    expect(isReviewable("/Users/sam/proj/src/a.ts")).toBe(true);
    expect(isReviewable("/Users/sam/proj/README.md")).toBe(false);
  });

  test("Windows separators are judged by the same rules", () => {
    expect(isReviewable("C:\\proj\\.claude\\hooks\\stop.sh")).toBe(true);
    expect(isReviewable("C:\\proj\\.claude\\settings.json")).toBe(false);
    expect(isReviewable("C:\\proj\\dist\\a.js")).toBe(false);
  });

  test("a directory merely NAMED like an excluded extension does not exclude its code", () => {
    expect(isReviewable("notes.md/run.py")).toBe(true);
  });

  test("a dist directory nested inside a project is still generated output", () => {
    expect(isReviewable("packages/web/dist/index.js")).toBe(false);
  });
});

describe("anyReviewable", () => {
  test("true when at least one file is reviewable", () => {
    expect(anyReviewable(["README.md", "src/a.ts"])).toBe(true);
  });
  test("false when none is", () => {
    expect(anyReviewable(["README.md", "logo.png"])).toBe(false);
  });
  test("false for no files", () => {
    expect(anyReviewable([])).toBe(false);
  });
});
