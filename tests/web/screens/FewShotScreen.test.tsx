/** @jsxImportSource hono/jsx */
/**
 * FewShotScreen smoke tests
 */
import { test, expect, describe } from "bun:test";
import { FewShotScreen } from "../../../src/web/screens/FewShotScreen";

describe("FewShotScreen", () => {
  test("renders Dashboard shell and header", () => {
    const html = String(
      <FewShotScreen
        totalEntries={0}
        embeddingDim={384}
        oldestTs={null}
        newestTs={null}
        query={null}
        neighbors={[]}
      />,
    );
    expect(html).toContain("data-sidebar");
    expect(html).toContain("Anti-Example Index");
  });

  test("renders stats strip with totalEntries and dim", () => {
    const html = String(
      <FewShotScreen
        totalEntries={17}
        embeddingDim={384}
        oldestTs="2026-01-01T00:00:00Z"
        newestTs="2026-05-20T00:00:00Z"
        query={null}
        neighbors={[]}
      />,
    );
    expect(html).toContain("17");
    expect(html).toContain("384");
  });

  test("renders query form", () => {
    const html = String(
      <FewShotScreen
        totalEntries={0}
        embeddingDim={384}
        oldestTs={null}
        newestTs={null}
        query={null}
        neighbors={[]}
      />,
    );
    expect(html).toContain('action="/few-shot"');
    expect(html).toContain('name="q"');
  });

  test("shows neighbors when query present", () => {
    const html = String(
      <FewShotScreen
        totalEntries={5}
        embeddingDim={384}
        oldestTs={null}
        newestTs={null}
        query="magic number"
        neighbors={[
          {
            id: "c-xyz",
            critique_summary: "Magic number 42 found",
            reason_text: "too picky",
            ts: "2026-05-01T00:00:00Z",
            similarity: 0.87,
          },
        ]}
      />,
    );
    expect(html).toContain("magic number");
    expect(html).toContain("Magic number 42 found");
    expect(html).toContain("0.870");
    expect(html).toContain("too picky");
  });

  test.skip("activeSection is few-shot", () => {
    const html = String(
      <FewShotScreen
        totalEntries={0}
        embeddingDim={384}
        oldestTs={null}
        newestTs={null}
        query={null}
        neighbors={[]}
      />,
    );
    expect(html).toContain('href="/few-shot"');
  });
});
