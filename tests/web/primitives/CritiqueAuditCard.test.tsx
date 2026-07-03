/** @jsxImportSource hono/jsx */
import { describe, test, expect } from "bun:test";
import { CritiqueAuditCard } from "../../../src/web/primitives/CritiqueAuditCard";

describe("CritiqueAuditCard", () => {
  test("renders intent, tier sections, evidence, reasoning, suggested fix", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-test",
          intent: { classification: "bugfix", confidence: 0.9 },
          evidence: [
            {
              rule_id: "secrets-scan",
              tier: 1,
              signal_source: "secrets-scan",
              file: "x.ts",
              line: 18,
              snippet: "AKIA...",
            },
          ],
          web_sources: [],
          reasoning: "AWS key in source.",
          category: "security",
          severity: "high",
          confidence: "high",
          critique_for_claude: "Move to env var.",
          suggested_fix: "process.env.AWS_KEY",
        }}
      />,
    );
    expect(html).toContain("bugfix");
    expect(html).toContain("Tier 1");
    expect(html).toContain("secrets-scan");
    expect(html).toContain("Move to env var");
  });

  test("renders id in header", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-abc",
          critique_for_claude: "fix it",
        }}
      />,
    );
    expect(html).toContain("c-abc");
  });

  test("renders data-critique-id attribute", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-xyz",
        }}
      />,
    );
    expect(html).toContain('data-critique-id="c-xyz"');
  });

  test("gracefully degrades when v2 fields absent — no crash, renders id", () => {
    const html = String(
      <CritiqueAuditCard critique={{ id: "c-v1" }} />,
    );
    expect(html).toContain("c-v1");
    expect(html).not.toContain("Evidence");
    expect(html).not.toContain("Reasoning");
  });

  test("renders severity badge", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-sev",
          severity: "high",
        }}
      />,
    );
    expect(html).toContain(">high<");
  });

  test("renders category badge", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-cat",
          category: "security",
        }}
      />,
    );
    expect(html).toContain(">security<");
  });

  test("renders reasoning paragraph", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-reason",
          reasoning: "This is a reasoning paragraph.",
        }}
      />,
    );
    expect(html).toContain("This is a reasoning paragraph.");
    expect(html).toContain("Reasoning");
  });

  test("renders suggested_fix in code block", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-fix",
          suggested_fix: "process.env.AWS_KEY",
        }}
      />,
    );
    expect(html).toContain("process.env.AWS_KEY");
    expect(html).toContain("Suggested Fix");
  });

  test("renders web sources list", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-web",
          web_sources: [
            {
              url: "https://example.com",
              title: "Example Doc",
              snippet: "some snippet",
              query: "how to fix",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Example Doc");
    expect(html).toContain("https://example.com");
    expect(html).toContain("Web Sources");
  });

  test("renders evidence file:line for each item", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-ev",
          evidence: [
            {
              rule_id: "god-file",
              tier: 1,
              signal_source: "rubric-tier1",
              file: "src/big.ts",
              line: 42,
              snippet: "export function hugeFile() { /* 800 lines */ }",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("src/big.ts:42");
    expect(html).toContain("god-file");
    expect(html).toContain("rubric-tier1");
    expect(html).toContain("Tier 1");
  });

  test("truncates snippet at 80 chars", () => {
    const longSnippet = "A".repeat(100);
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-snip",
          evidence: [
            {
              rule_id: "r",
              tier: 1,
              signal_source: "tsc",
              file: "f.ts",
              line: 1,
              snippet: longSnippet,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("…");
    expect(html).not.toContain("A".repeat(100));
  });

  test("renders multiple tiers grouped separately", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{
          id: "c-tiers",
          evidence: [
            { rule_id: "secrets-scan", tier: 1, signal_source: "secrets-scan", file: "a.ts", line: 1, snippet: "AKIA" + "1234567890123456" },
            { rule_id: "god-function", tier: 2, signal_source: "rubric-tier2", file: "b.ts", line: 5, snippet: "function large() { return 1; }" },
            { rule_id: "brain-check",  tier: 3, signal_source: "brain-semantic", file: "c.ts", line: 9, snippet: "const x = doSomethingSemantic();" },
          ],
        }}
      />,
    );
    expect(html).toContain("Tier 1");
    expect(html).toContain("Tier 2");
    expect(html).toContain("Tier 3");
    expect(html).toContain("deterministic");
    expect(html).toContain("heuristic AST");
    expect(html).toContain("semantic Brain");
  });

  test("does not render feedback slot when onFeedback is omitted", () => {
    const html = String(
      <CritiqueAuditCard critique={{ id: "c-nofeedback" }} />,
    );
    expect(html).not.toContain("critique-feedback-form");
  });

  test("renders feedback slot when onFeedback is provided", () => {
    const html = String(
      <CritiqueAuditCard
        critique={{ id: "c-withfeedback" }}
        onFeedback={() => {}}
      />,
    );
    expect(html).toContain("critique-feedback-form");
    expect(html).toContain('data-critique-id="c-withfeedback"');
  });
});
