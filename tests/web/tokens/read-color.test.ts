import { describe, expect, test } from "bun:test";
import { readColor } from "../../../src/web/tokens/tokens";
import { palette } from "../../../src/web/tokens/palette";

describe("readColor", () => {
  test("returns the light literal when there is no document (SSR)", () => {
    // bun test has no DOM — this exercises the SSR guard directly.
    expect(typeof document).toBe("undefined");
    expect(readColor("ink")).toBe(palette.light.ink);
  });
});
