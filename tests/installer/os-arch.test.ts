import { describe, test, expect } from "bun:test";
import { describePlatform } from "../../src/installer/os-arch";

describe("describePlatform", () => {
  test("macOS arm64 reads as Apple Silicon", () => {
    expect(describePlatform("darwin", "arm64")).toBe("macOS · Apple Silicon (arm64)");
  });
  test("Windows x64", () => {
    expect(describePlatform("win32", "x64")).toBe("Windows · x64");
  });
  test("linux arm64 is not called Apple Silicon", () => {
    expect(describePlatform("linux", "arm64")).toBe("Linux · arm64");
  });
});
