/** @jsxImportSource hono/jsx */
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The per-review feedback box must not claim the reviewer learns from it —
 * defect [36] (install audit §51.1). A note written here is kept with the
 * review for the user; nothing routes it to the reviewer yet.
 */
import { expect, test } from "bun:test";
import { FeedbackSection } from "../../../src/web/screens/critic/feedback-section";

test("[36] the feedback box says the note is kept, not learned from", () => {
  const html = String(<FeedbackSection critiqueId="cq-fb" />);
  expect(html).toContain('data-feedback-textarea="cq-fb"');
  expect(html).toContain("the reviewer does not read it yet");
  expect(html).toContain("does not change future reviews yet");
  expect(html).not.toContain("saved to siltpoke memory");
  expect(html).not.toContain("learn your preferences");
});
