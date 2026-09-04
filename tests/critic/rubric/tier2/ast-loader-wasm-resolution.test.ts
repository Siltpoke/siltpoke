import { describe, expect, test } from "bun:test";
import { parseSource, resolveWasmDir } from "../../../../src/critic/rubric/tier2/ast-loader";

describe("resolveWasmDir", () => {
  test("SILTPOKE_WASM_DIR wins over everything", () => {
    const dir = resolveWasmDir({ SILTPOKE_WASM_DIR: "/custom/wasm" }, "/plugin/dist");
    expect(dir).toBe("/custom/wasm");
  });

  test("falls back to <moduleDir>/wasm — the bundled plugin layout", () => {
    // /plugin/dist/wasm exists in the shipped plugin; node_modules does not.
    const dir = resolveWasmDir({}, "/plugin/dist");
    expect(dir).toBe("/plugin/dist/wasm");
  });
});

describe("graceful degradation", () => {
  test("parseSource returns null (does not throw) when the wasm dir is bogus", async () => {
    const result = await parseSource("const x = 1;", "ts", {
      SILTPOKE_WASM_DIR: "/nonexistent/path/wasm",
    });
    expect(result).toBeNull();
  });
});
