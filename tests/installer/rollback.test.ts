// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, test, expect } from "bun:test";
import { RollbackStack } from "../../src/installer/rollback";

describe("RollbackStack", () => {
  test("unwinds LIFO", async () => {
    const order: string[] = [];
    const s = new RollbackStack();
    s.push({ label: "a", undo: () => { order.push("a"); } });
    s.push({ label: "b", undo: () => { order.push("b"); } });
    await s.unwind();
    expect(order).toEqual(["b", "a"]);
  });

  test("a throwing undo does not abort the unwind", async () => {
    const order: string[] = [];
    const s = new RollbackStack();
    s.push({ label: "first", undo: () => { order.push("first"); } });
    s.push({ label: "boom", undo: () => { throw new Error("x"); } });
    const unwound = await s.unwind();
    expect(order).toEqual(["first"]);
    expect(unwound).toContain("boom");
  });
});
