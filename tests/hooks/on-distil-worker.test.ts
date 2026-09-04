import { describe, it, expect } from "bun:test";
import { parseWorkerArgs } from "../../src/hooks/on-distil-worker";

describe("parseWorkerArgs", () => {
  it("parses --home/--state/--cwd", () => {
    const r = parseWorkerArgs(["--home", "/h", "--state", "/s", "--cwd", "/c"]);
    expect(r).toEqual({ home: "/h", state: "/s", cwd: "/c" });
  });
  it("throws on a missing required flag", () => {
    expect(() => parseWorkerArgs(["--home", "/h"])).toThrow();
  });
});
