// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import { extractAnswer } from "../../src/quiz/extract";

const modules = ["src/daemon/", "src/web/", "src/brain/"];

describe("extractAnswer", () => {
  test("parses 'A depends on B' and resolves both", () => {
    const out = extractAnswer("the daemon depends on web", modules);
    expect(out.relations).toEqual([{ aName: "daemon", bName: "web" }]);
    expect(out.entities.map((e) => e.resolve.kind)).toEqual(["found", "found"]);
  });
  test("parses arrow form", () => {
    const out = extractAnswer("daemon -> brain", modules);
    expect(out.relations).toEqual([{ aName: "daemon", bName: "brain" }]);
  });
  test("multi-part answer yields multiple relations", () => {
    const out = extractAnswer("daemon uses web and daemon calls brain", modules);
    expect(out.relations).toEqual([
      { aName: "daemon", bName: "web" },
      { aName: "daemon", bName: "brain" },
    ]);
  });
  test("an unresolvable name surfaces as a phantom resolve, not dropped", () => {
    const out = extractAnswer("payments depends on web", modules);
    const payments = out.entities.find((e) => e.name === "payments");
    expect(payments?.resolve.kind).toBe("phantom");
  });
});
