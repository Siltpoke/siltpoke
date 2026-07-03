/** @jsxImportSource hono/jsx */
/**
 * Tests for CritiqueFeedbackInput
 */
import { describe, test, expect } from "bun:test";
import { CritiqueFeedbackInput } from "../../../src/web/primitives/CritiqueFeedbackInput";

describe("CritiqueFeedbackInput", () => {
  test("renders a textarea", () => {
    const html = String(
      <CritiqueFeedbackInput critiqueId="c-test" onSubmit={() => {}} />,
    );
    expect(html).toContain("<textarea");
  });

  test("renders a submit button", () => {
    const html = String(
      <CritiqueFeedbackInput critiqueId="c-test" onSubmit={() => {}} />,
    );
    expect(html.toLowerCase()).toContain('type="submit"');
  });

  test("renders the critique id as data attribute", () => {
    const html = String(
      <CritiqueFeedbackInput critiqueId="c-abc" onSubmit={() => {}} />,
    );
    expect(html).toContain('data-critique-id="c-abc"');
  });

  test("renders Feedback section label", () => {
    const html = String(
      <CritiqueFeedbackInput critiqueId="c-label" onSubmit={() => {}} />,
    );
    expect(html).toContain("Feedback");
  });

  test("renders form element wrapping textarea and button", () => {
    const html = String(
      <CritiqueFeedbackInput critiqueId="c-form" onSubmit={() => {}} />,
    );
    expect(html).toContain("<form");
    expect(html).toContain("</form>");
  });

  test("accepts different critiqueIds without crash", () => {
    const ids = ["c-abc", "c-def", "c-xyz-123"];
    for (const id of ids) {
      const html = String(
        <CritiqueFeedbackInput critiqueId={id} onSubmit={() => {}} />,
      );
      expect(html).toContain(`data-critique-id="${id}"`);
    }
  });
});
