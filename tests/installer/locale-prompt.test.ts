import { describe, test, expect } from "bun:test";
import { askLocale } from "../../src/installer/locale-prompt";

function io(lines: string[]) {
  const out: string[] = [];
  return { out, io: { write: (s: string) => out.push(s), readLine: async () => lines.shift() ?? "" } };
}

describe("askLocale", () => {
  test("picks zh when the user selects 1", async () => {
    const { io: wio } = io(["1"]);
    expect(await askLocale(wio)).toBe("zh");
  });
  test("--yes skips the prompt and returns the default", async () => {
    const { out, io: wio } = io([]);
    expect(await askLocale(wio, { yes: true, default: "en" })).toBe("en");
    expect(out.join("")).toBe(""); // nothing written
  });
});
