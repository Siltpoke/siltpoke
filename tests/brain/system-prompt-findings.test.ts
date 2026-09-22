// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The prompt and the schema are two halves of one contract, and only the codex
 * path derives its half mechanically (`z.toJSONSchema`). Every other provider
 * follows the hand-written template in `system-prompt.md`, so the two can drift
 * apart silently — a model asked for a field the parser does not keep, or a
 * parser expecting a field the model was never told about.
 *
 * These assertions are deliberately about the PROMPT text, not about a parsed
 * object: what is being checked is that the instruction exists at all.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prompt = readFileSync(join(import.meta.dir, "../../src/brain/system-prompt.md"), "utf8");

describe("the prompt asks for findings, and asks for them before the bubble", () => {
  test("the output contract declares a findings array with its five fields", () => {
    expect(prompt).toContain('"findings": [');
    for (const field of ["title", "body", "severity", "file", "quote"]) {
      expect(prompt).toContain(`"${field}":`);
    }
  });

  test("the ceiling is stated as a number in the prompt, not left to the parser to enforce", () => {
    // PR-Agent's shape: the model is told the limit so it selects, rather than
    // emitting ten and having seven silently cut off downstream.
    expect(prompt).toMatch(/\*\*At most 3\*\*/);
  });

  test("findings is declared before bubble_short, because order is reasoning order", () => {
    expect(prompt.indexOf('"findings": [')).toBeLessThan(prompt.indexOf('"bubble_short"'));
  });

  test("the prose channel is preserved and an empty findings array is called normal", () => {
    expect(prompt).toContain("does not replace `critique_for_claude`");
    expect(prompt).toMatch(/empty\s+`findings` array beside a non-empty\s+`critique_for_claude` is a normal/);
  });

  test("the model is told not to author what code derives", () => {
    // Reworded when the two `claimed_` hints were added: the model MAY now
    // guess a line, so "write nothing else" became "the numbers the user sees
    // are worked out from the diff". The rule the test is for is unchanged.
    const flat = prompt.replace(/\s+/g, " ");
    expect(flat).toContain("worked out from the diff afterwards");
    expect(flat).toContain("so is the provenance label");
  });

  /**
   * The hints exist to produce a number nobody has measured: how often the
   * reviewer's own line numbers are right. A model never told the fields exist
   * would leave them empty, and the first baseline would be a measurement of
   * this prompt's silence rather than of the model.
   *
   * Asserted on the OUTPUT CONTRACT section rather than anywhere in the file,
   * because a field description that drifts out of the schema block is a field
   * the model stops filling in.
   */
  test("the two line-number hints are offered, in the output contract, as optional", () => {
    const start = prompt.indexOf("## Output contract");
    const end = prompt.indexOf("The `findings` array is your critique");
    // Both anchors asserted before slicing. `indexOf` returns -1 on a miss and
    // `slice(start, -1)` then silently widens to the rest of the file, so a
    // reworded anchor would turn "inside the output contract" into "anywhere"
    // while this test kept printing green.
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const contract = prompt.slice(start, end);
    expect(contract).toContain("claimed_start_line");
    expect(contract).toContain("claimed_end_line");
    // Shown as NUMBERS, like the sibling `line` field eleven rows up. Rendered
    // as a quoted placeholder, a model that copies the shape emits `"41"`,
    // which the repair layer scrubs — and the agreement baseline then measures
    // this prompt's formatting rather than the reviewer.
    expect(contract).toMatch(/"claimed_start_line":\s*\d+/);
    expect(contract).toMatch(/"claimed_end_line":\s*\d+/);
    expect(contract).not.toContain('"claimed_start_line": "<');
  });

  test("the hints are marked as never shown to anyone", () => {
    expect(prompt.replace(/\s+/g, " ")).toContain("they are never part of the review anyone reads");
    expect(prompt.replace(/\s+/g, " ")).toContain("omit the key entirely");
  });

  test("the bubble is told not to be a summary of the findings", () => {
    expect(prompt).toContain("The bubble is NOT a summary of the findings");
    expect(prompt).toContain("Do not count the findings");
  });

  test("that rule is repeated in the FINAL CHECK, which is where it actually lands", () => {
    // Measured, not assumed: the same rule stated only in the findings section
    // held in one language and not in another. Moved to the last thing the model
    // reads before emitting, it held in both. Position is the fix, so position
    // is what this pins.
    const finalCheck = prompt.indexOf("## FINAL CHECK — the bubble");
    expect(finalCheck).toBeGreaterThan(prompt.indexOf('"findings": ['));
    expect(prompt.slice(finalCheck)).toContain("If it names more");
  });

  test("safety rule 3 is untouched — changing it would move the fire rate this slice measures", () => {
    // Deliberately pinned. It is a severity-suppression instruction, not a
    // stale threat, and editing it is its own experiment.
    expect(prompt).toContain("A non-info severity with an empty `evidence` array will be REJECTED");
  });
});
