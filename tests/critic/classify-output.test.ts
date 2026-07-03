import { test, expect, describe } from "bun:test";
import {
  classifyToolOutput,
  type GateDecision,
} from "../../src/critic/classify-output";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";

// ---------------------------------------------------------------------------
// Helpers — build minimal ToolResult fixtures
// ---------------------------------------------------------------------------

function tscOk(diagCount: number): Extract<ToolResult, { tool: "tsc" }> {
  return {
    tool: "tsc",
    status: "ok",
    parsed: Array.from({ length: diagCount }, (_, i) => ({
      file: `src/file${i}.ts`,
      line: i + 1,
      col: 1,
      severity: "error" as const,
      code: `TS${2000 + i}`,
      message: `error ${i}`,
    })),
    raw: "",
  };
}

function eslintOk(
  findingCount: number,
): Extract<ToolResult, { tool: "eslint" }> {
  return {
    tool: "eslint",
    status: "ok",
    parsed: Array.from({ length: findingCount }, (_, i) => ({
      file: `src/file${i}.ts`,
      line: i + 1,
      col: 1,
      severity: "error" as const,
      ruleId: `rule/${i}`,
      message: `finding ${i}`,
    })),
    raw: "",
  };
}

function gitDiffOk(
  hunkCount: number,
): Extract<ToolResult, { tool: "git-diff" }> {
  return {
    tool: "git-diff",
    status: "ok",
    parsed: Array.from({ length: hunkCount }, (_, i) => ({
      file: `src/file${i}.ts`,
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      header: `@@ -1,3 +1,3 @@`,
      body: `-old\n+new`,
    })),
    raw: "",
  };
}

function ripgrepOk(
  matchCount: number,
): Extract<ToolResult, { tool: "ripgrep" }> {
  return {
    tool: "ripgrep",
    status: "ok",
    parsed: Array.from({ length: matchCount }, (_, i) => ({
      file: `src/file${i}.ts`,
      line: i + 1,
      text: `TODO: fix this`,
      pattern: "TODO",
    })),
    raw: "",
  };
}

function makeResults(
  overrides: Partial<Record<ToolName, ToolResult>>,
): Record<ToolName, ToolResult> {
  return {
    tsc: tscOk(0),
    eslint: eslintOk(0),
    "git-diff": gitDiffOk(0),
    ripgrep: ripgrepOk(0),
    ...overrides,
  };
}

function notInstalled(tool: "tsc"): Extract<ToolResult, { tool: "tsc" }>;
function notInstalled(
  tool: "eslint",
): Extract<ToolResult, { tool: "eslint" }>;
function notInstalled(
  tool: "git-diff",
): Extract<ToolResult, { tool: "git-diff" }>;
function notInstalled(
  tool: "ripgrep",
): Extract<ToolResult, { tool: "ripgrep" }>;
function notInstalled(tool: ToolName): ToolResult {
  switch (tool) {
    case "tsc":
      return { tool: "tsc", status: "not_installed", parsed: [], raw: "" };
    case "eslint":
      return { tool: "eslint", status: "not_installed", parsed: [], raw: "" };
    case "git-diff":
      return { tool: "git-diff", status: "not_installed", parsed: [], raw: "" };
    case "ripgrep":
      return { tool: "ripgrep", status: "not_installed", parsed: [], raw: "" };
  }
}

function timeout(tool: "tsc"): Extract<ToolResult, { tool: "tsc" }>;
function timeout(tool: "eslint"): Extract<ToolResult, { tool: "eslint" }>;
function timeout(tool: "git-diff"): Extract<ToolResult, { tool: "git-diff" }>;
function timeout(tool: "ripgrep"): Extract<ToolResult, { tool: "ripgrep" }>;
function timeout(tool: ToolName): ToolResult {
  switch (tool) {
    case "tsc":
      return { tool: "tsc", status: "timeout", parsed: [], raw: "" };
    case "eslint":
      return { tool: "eslint", status: "timeout", parsed: [], raw: "" };
    case "git-diff":
      return { tool: "git-diff", status: "timeout", parsed: [], raw: "" };
    case "ripgrep":
      return { tool: "ripgrep", status: "timeout", parsed: [], raw: "" };
  }
}

function errored(tool: "tsc"): Extract<ToolResult, { tool: "tsc" }>;
function errored(tool: "eslint"): Extract<ToolResult, { tool: "eslint" }>;
function errored(tool: "git-diff"): Extract<ToolResult, { tool: "git-diff" }>;
function errored(tool: "ripgrep"): Extract<ToolResult, { tool: "ripgrep" }>;
function errored(tool: ToolName): ToolResult {
  switch (tool) {
    case "tsc":
      return { tool: "tsc", status: "error", parsed: [], raw: "" };
    case "eslint":
      return { tool: "eslint", status: "error", parsed: [], raw: "" };
    case "git-diff":
      return { tool: "git-diff", status: "error", parsed: [], raw: "" };
    case "ripgrep":
      return { tool: "ripgrep", status: "error", parsed: [], raw: "" };
  }
}

function notApplicable(tool: "tsc"): Extract<ToolResult, { tool: "tsc" }>;
function notApplicable(
  tool: "eslint",
): Extract<ToolResult, { tool: "eslint" }>;
function notApplicable(
  tool: "git-diff",
): Extract<ToolResult, { tool: "git-diff" }>;
function notApplicable(
  tool: "ripgrep",
): Extract<ToolResult, { tool: "ripgrep" }>;
function notApplicable(tool: ToolName): ToolResult {
  switch (tool) {
    case "tsc":
      return { tool: "tsc", status: "not_applicable", parsed: [], raw: "" };
    case "eslint":
      return { tool: "eslint", status: "not_applicable", parsed: [], raw: "" };
    case "git-diff":
      return {
        tool: "git-diff",
        status: "not_applicable",
        parsed: [],
        raw: "",
      };
    case "ripgrep":
      return {
        tool: "ripgrep",
        status: "not_applicable",
        parsed: [],
        raw: "",
      };
  }
}

// ---------------------------------------------------------------------------
// Case 1 — All clean, no diff → HARD_SUPPRESS
// ---------------------------------------------------------------------------

describe("case 1: all-clean, no diff", () => {
  test("returns HARD_SUPPRESS", () => {
    const result = classifyToolOutput(makeResults({}));
    expect(result.decision).toBe("HARD_SUPPRESS" satisfies GateDecision);
  });

  test("reason mentions no diff", () => {
    const result = classifyToolOutput(makeResults({}));
    expect(result.reason).toMatch(/no diff/i);
  });

  test("usableTools includes all four ok tools", () => {
    const result = classifyToolOutput(makeResults({}));
    expect(result.usableTools).toContain("tsc");
    expect(result.usableTools).toContain("eslint");
    expect(result.usableTools).toContain("git-diff");
    expect(result.usableTools).toContain("ripgrep");
  });
});

// ---------------------------------------------------------------------------
// Case 2 — All clean, diff present → PASSIVE_BUBBLE
// ---------------------------------------------------------------------------

describe("case 2: all-clean, diff present", () => {
  test("returns PASSIVE_BUBBLE when diff has hunks", () => {
    const result = classifyToolOutput(
      makeResults({ "git-diff": gitDiffOk(1) }),
    );
    expect(result.decision).toBe("PASSIVE_BUBBLE" satisfies GateDecision);
  });

  test("reason mentions clean refactor or diff", () => {
    const result = classifyToolOutput(
      makeResults({ "git-diff": gitDiffOk(2) }),
    );
    expect(result.reason.length).toBeGreaterThan(0);
    // should reference refactor or diff
    expect(result.reason).toMatch(/refactor|diff/i);
  });

  test("usableTools includes git-diff", () => {
    const result = classifyToolOutput(
      makeResults({ "git-diff": gitDiffOk(1) }),
    );
    expect(result.usableTools).toContain("git-diff");
  });
});

// ---------------------------------------------------------------------------
// Case 3 — tsc has errors → NORMAL
// ---------------------------------------------------------------------------

describe("case 3: tsc has errors", () => {
  test("returns NORMAL", () => {
    const result = classifyToolOutput(makeResults({ tsc: tscOk(3) }));
    expect(result.decision).toBe("NORMAL" satisfies GateDecision);
  });

  test("usableTools includes tsc", () => {
    const result = classifyToolOutput(makeResults({ tsc: tscOk(3) }));
    expect(result.usableTools).toContain("tsc");
  });

  test("reason mentions tsc", () => {
    const result = classifyToolOutput(makeResults({ tsc: tscOk(3) }));
    expect(result.reason).toMatch(/tsc/i);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — eslint has findings → NORMAL
// ---------------------------------------------------------------------------

describe("case 4: eslint has findings", () => {
  test("returns NORMAL", () => {
    const result = classifyToolOutput(makeResults({ eslint: eslintOk(2) }));
    expect(result.decision).toBe("NORMAL" satisfies GateDecision);
  });

  test("reason mentions eslint", () => {
    const result = classifyToolOutput(makeResults({ eslint: eslintOk(2) }));
    expect(result.reason).toMatch(/eslint/i);
  });
});

// ---------------------------------------------------------------------------
// Case 5 — ripgrep found TODOs only, rest clean (no diff) → NORMAL
// ---------------------------------------------------------------------------

describe("case 5: ripgrep matches, rest clean (no diff)", () => {
  test("returns NORMAL — ripgrep counts as non-diff signal", () => {
    const result = classifyToolOutput(
      makeResults({ ripgrep: ripgrepOk(3) }),
    );
    expect(result.decision).toBe("NORMAL" satisfies GateDecision);
  });

  test("reason mentions ripgrep", () => {
    const result = classifyToolOutput(
      makeResults({ ripgrep: ripgrepOk(3) }),
    );
    expect(result.reason).toMatch(/ripgrep/i);
  });
});

// ---------------------------------------------------------------------------
// Case 6 — All tools failed → HARD_SUPPRESS (abstention)
// ---------------------------------------------------------------------------

describe("case 6: all tools failed", () => {
  test("returns HARD_SUPPRESS (abstention)", () => {
    const result = classifyToolOutput({
      tsc: timeout("tsc"),
      eslint: notInstalled("eslint"),
      "git-diff": errored("git-diff"),
      ripgrep: notInstalled("ripgrep"),
    });
    expect(result.decision).toBe("HARD_SUPPRESS" satisfies GateDecision);
  });

  test("reason mentions abstaining or no usable tools", () => {
    const result = classifyToolOutput({
      tsc: timeout("tsc"),
      eslint: notInstalled("eslint"),
      "git-diff": errored("git-diff"),
      ripgrep: notInstalled("ripgrep"),
    });
    expect(result.reason).toMatch(/abstain|no.*tool|no.*usable/i);
  });

  test("usableTools is empty", () => {
    const result = classifyToolOutput({
      tsc: timeout("tsc"),
      eslint: notInstalled("eslint"),
      "git-diff": errored("git-diff"),
      ripgrep: notInstalled("ripgrep"),
    });
    expect(result.usableTools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 7 — Partial: tsc ok+[err], eslint timeout, git-diff ok+[hunk], rg ok+[]
// → NORMAL (signal from tsc; failed eslint doesn't block)
// ---------------------------------------------------------------------------

describe("case 7: partial — tsc errors, eslint timeout, diff hunks, rg clean", () => {
  test("returns NORMAL", () => {
    const result = classifyToolOutput({
      tsc: tscOk(2),
      eslint: timeout("eslint"),
      "git-diff": gitDiffOk(1),
      ripgrep: ripgrepOk(0),
    });
    expect(result.decision).toBe("NORMAL" satisfies GateDecision);
  });

  test("usableTools does NOT include eslint (failed)", () => {
    const result = classifyToolOutput({
      tsc: tscOk(2),
      eslint: timeout("eslint"),
      "git-diff": gitDiffOk(1),
      ripgrep: ripgrepOk(0),
    });
    expect(result.usableTools).not.toContain("eslint");
  });

  test("usableTools includes tsc, git-diff, ripgrep", () => {
    const result = classifyToolOutput({
      tsc: tscOk(2),
      eslint: timeout("eslint"),
      "git-diff": gitDiffOk(1),
      ripgrep: ripgrepOk(0),
    });
    expect(result.usableTools).toContain("tsc");
    expect(result.usableTools).toContain("git-diff");
    expect(result.usableTools).toContain("ripgrep");
  });
});

// ---------------------------------------------------------------------------
// Case 8 — Partial: tsc not_applicable, eslint not_applicable, git-diff ok+[hunk], rg ok+[]
// → PASSIVE_BUBBLE (clean refactor; rg clean, only diff)
// ---------------------------------------------------------------------------

describe("case 8: tsc+eslint not_applicable, diff has hunks, rg clean", () => {
  test("returns PASSIVE_BUBBLE", () => {
    const result = classifyToolOutput({
      tsc: notApplicable("tsc"),
      eslint: notApplicable("eslint"),
      "git-diff": gitDiffOk(1),
      ripgrep: ripgrepOk(0),
    });
    expect(result.decision).toBe("PASSIVE_BUBBLE" satisfies GateDecision);
  });

  test("usableTools includes git-diff and ripgrep only", () => {
    const result = classifyToolOutput({
      tsc: notApplicable("tsc"),
      eslint: notApplicable("eslint"),
      "git-diff": gitDiffOk(1),
      ripgrep: ripgrepOk(0),
    });
    expect(result.usableTools).toContain("git-diff");
    expect(result.usableTools).toContain("ripgrep");
    expect(result.usableTools).not.toContain("tsc");
    expect(result.usableTools).not.toContain("eslint");
  });
});

// ---------------------------------------------------------------------------
// Case 9 — All not_applicable → HARD_SUPPRESS (abstention)
// ---------------------------------------------------------------------------

describe("case 9: all tools not_applicable", () => {
  test("returns HARD_SUPPRESS (abstention — no usable tools)", () => {
    const result = classifyToolOutput({
      tsc: notApplicable("tsc"),
      eslint: notApplicable("eslint"),
      "git-diff": notApplicable("git-diff"),
      ripgrep: notApplicable("ripgrep"),
    });
    expect(result.decision).toBe("HARD_SUPPRESS" satisfies GateDecision);
  });

  test("usableTools is empty", () => {
    const result = classifyToolOutput({
      tsc: notApplicable("tsc"),
      eslint: notApplicable("eslint"),
      "git-diff": notApplicable("git-diff"),
      ripgrep: notApplicable("ripgrep"),
    });
    expect(result.usableTools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 10 — Mixed not_applicable + signal: tsc=N/A, eslint ok+[finding], git-diff=N/A, rg ok+[]
// → NORMAL
// ---------------------------------------------------------------------------

describe("case 10: mixed not_applicable + eslint signal", () => {
  test("returns NORMAL", () => {
    const result = classifyToolOutput({
      tsc: notApplicable("tsc"),
      eslint: eslintOk(1),
      "git-diff": notApplicable("git-diff"),
      ripgrep: ripgrepOk(0),
    });
    expect(result.decision).toBe("NORMAL" satisfies GateDecision);
  });

  test("usableTools includes eslint and ripgrep, not tsc/git-diff", () => {
    const result = classifyToolOutput({
      tsc: notApplicable("tsc"),
      eslint: eslintOk(1),
      "git-diff": notApplicable("git-diff"),
      ripgrep: ripgrepOk(0),
    });
    expect(result.usableTools).toContain("eslint");
    expect(result.usableTools).toContain("ripgrep");
    expect(result.usableTools).not.toContain("tsc");
    expect(result.usableTools).not.toContain("git-diff");
  });
});

// ---------------------------------------------------------------------------
// Case 11 — usableTools list correctness (only status==="ok" tools)
// ---------------------------------------------------------------------------

describe("case 11: usableTools correctness", () => {
  test("only includes tools with status === 'ok'", () => {
    const result = classifyToolOutput({
      tsc: tscOk(0),
      eslint: timeout("eslint"),
      "git-diff": gitDiffOk(1),
      ripgrep: notInstalled("ripgrep"),
    });
    const sorted = [...result.usableTools].sort();
    expect(sorted).toEqual(["git-diff", "tsc"]);
  });

  test("all four ok → all four usable", () => {
    const result = classifyToolOutput(makeResults({}));
    expect(result.usableTools).toHaveLength(4);
  });

  test("none ok → empty usableTools", () => {
    const result = classifyToolOutput({
      tsc: timeout("tsc"),
      eslint: timeout("eslint"),
      "git-diff": timeout("git-diff"),
      ripgrep: timeout("ripgrep"),
    });
    expect(result.usableTools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Case 12 — reason string is non-empty for every decision branch
// ---------------------------------------------------------------------------

describe("case 12: reason string non-empty for every branch", () => {
  test("HARD_SUPPRESS (no-op: all clean, no diff)", () => {
    const r = classifyToolOutput(makeResults({}));
    expect(r.reason.length).toBeGreaterThan(0);
  });

  test("HARD_SUPPRESS (abstention: all failed)", () => {
    const r = classifyToolOutput({
      tsc: timeout("tsc"),
      eslint: timeout("eslint"),
      "git-diff": timeout("git-diff"),
      ripgrep: timeout("ripgrep"),
    });
    expect(r.reason.length).toBeGreaterThan(0);
  });

  test("PASSIVE_BUBBLE (clean refactor)", () => {
    const r = classifyToolOutput(makeResults({ "git-diff": gitDiffOk(1) }));
    expect(r.reason.length).toBeGreaterThan(0);
  });

  test("NORMAL (tsc signal)", () => {
    const r = classifyToolOutput(makeResults({ tsc: tscOk(1) }));
    expect(r.reason.length).toBeGreaterThan(0);
  });

  test("NORMAL (multiple signals)", () => {
    const r = classifyToolOutput(
      makeResults({ tsc: tscOk(1), eslint: eslintOk(2) }),
    );
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("git-diff ok with hunks, all other tools failed → PASSIVE_BUBBLE", () => {
    // Only git-diff is ok (with hunks), all others are failed/not-installed.
    // usableTools = [git-diff], no non-diff signal, allClean is vacuously true → PASSIVE_BUBBLE
    const result = classifyToolOutput({
      tsc: timeout("tsc"),
      eslint: errored("eslint"),
      "git-diff": gitDiffOk(3),
      ripgrep: notInstalled("ripgrep"),
    });
    expect(result.decision).toBe("PASSIVE_BUBBLE" satisfies GateDecision);
  });

  test("tsc ok+empty, eslint not_applicable, git-diff ok+hunks, ripgrep ok+empty → PASSIVE_BUBBLE", () => {
    // Verifies the path where
    // tsc ran clean (positive evidence) rather than not_applicable.
    const result = classifyToolOutput({
      tsc: tscOk(0),
      eslint: notApplicable("eslint"),
      "git-diff": gitDiffOk(2),
      ripgrep: ripgrepOk(0),
    });
    expect(result.decision).toBe("PASSIVE_BUBBLE" satisfies GateDecision);
    expect(result.usableTools).toContain("tsc");
    expect(result.usableTools).toContain("git-diff");
    expect(result.usableTools).toContain("ripgrep");
  });

  test("output_too_large status is treated as non-ok (not usable)", () => {
    const result = classifyToolOutput({
      tsc: { tool: "tsc", status: "output_too_large", parsed: [], raw: "" },
      eslint: {
        tool: "eslint",
        status: "output_too_large",
        parsed: [],
        raw: "",
      },
      "git-diff": gitDiffOk(0),
      ripgrep: ripgrepOk(0),
    });
    // tsc + eslint are output_too_large (not ok), git-diff + rg are ok+clean
    expect(result.usableTools).not.toContain("tsc");
    expect(result.usableTools).not.toContain("eslint");
    expect(result.usableTools).toContain("git-diff");
    expect(result.usableTools).toContain("ripgrep");
    expect(result.decision).toBe("HARD_SUPPRESS" satisfies GateDecision);
  });

  test("NORMAL: multiple non-diff signal tools both listed in reason", () => {
    const result = classifyToolOutput(
      makeResults({ tsc: tscOk(1), ripgrep: ripgrepOk(5) }),
    );
    expect(result.decision).toBe("NORMAL" satisfies GateDecision);
    expect(result.reason).toMatch(/tsc/i);
    expect(result.reason).toMatch(/ripgrep/i);
  });
});
