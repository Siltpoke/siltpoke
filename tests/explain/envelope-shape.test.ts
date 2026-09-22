// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [12], explain's half. Same root cause as the critic path: the
 * array envelope exists only when the USER's settings have verbose on.
 * Here the old code did not even fail cleanly — `events.slice()` on the bare
 * result object threw a raw `TypeError: events.slice is not a function`.
 */
import { test, expect } from "bun:test";
import { parseExplainEnvelope } from "../../src/explain/providers";

const usage = {
  cache_creation_input_tokens: 11,
  cache_read_input_tokens: 22,
  input_tokens: 33,
  output_tokens: 44,
};

test("[12] explain reads the bare result object (verbose OFF)", () => {
  const out = parseExplainEnvelope(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "# It does X",
      total_cost_usd: 0.05,
      usage,
    }),
  );
  expect(out.markdown).toBe("# It does X");
  expect(out.usage.output_tokens).toBe(44);
  expect(out.usage.total_cost_usd).toBe(0.05);
});

test("[12] explain still reads the event array (positive control)", () => {
  const out = parseExplainEnvelope(
    JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "result", result: "# It does X", total_cost_usd: 0.05, usage },
    ]),
  );
  expect(out.markdown).toBe("# It does X");
  expect(out.usage.input_tokens).toBe(33);
});

test("[12] an envelope with no result event is a named error, not a TypeError", () => {
  let caught: unknown;
  try {
    parseExplainEnvelope(JSON.stringify({ hello: "world" }));
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  const msg = (caught as Error).message;
  expect(msg).not.toContain("slice is not a function");
  expect(msg.toLowerCase()).toContain("result");
});
