import { describe, expect, test } from "bun:test";
import { exportFileName } from "../../../src/web/client/export/file-name";

describe("exportFileName", () => {
  test("code-map-<source>-<date>.<ext>, no repo name (AC31)", () => {
    const d = new Date(2026, 8, 26, 12, 0, 0); // local noon: same calendar day in every zone
    expect(exportFileName("generated", d, "png")).toBe("code-map-generated-2026-09-26.png");
    expect(exportFileName("authored", d, "md")).toBe("code-map-authored-2026-09-26.md");
    expect(exportFileName("subset", d, "html")).toBe("code-map-subset-2026-09-26.html");
  });
  test("zero-pads month and day", () => {
    expect(exportFileName("subset", new Date(2026, 0, 5, 9), "png")).toBe("code-map-subset-2026-01-05.png");
  });
});
