/** @jsxImportSource hono/jsx */
/**
 * JsonView — collapsible JSON pretty-print
 */
import { describe, test, expect } from "bun:test";
import { JsonView } from "../../../src/web/primitives/JsonView";

describe("JsonView", () => {
  test("renders a label when provided", () => {
    const html = String(<JsonView value={{ key: "val" }} label="Input" />);
    expect(html).toContain("Input");
  });

  test("renders string values", () => {
    const html = String(<JsonView value="hello world" />);
    expect(html).toContain("hello world");
  });

  test("renders numeric values", () => {
    const html = String(<JsonView value={42} />);
    expect(html).toContain("42");
  });

  test("renders null value", () => {
    const html = String(<JsonView value={null} />);
    expect(html).toContain("null");
  });

  test("renders boolean values", () => {
    const html = String(<JsonView value={true} />);
    expect(html).toContain("true");
  });

  test("parses JSON string and renders as object", () => {
    const json = JSON.stringify({ foo: "bar", count: 3 });
    const html = String(<JsonView value={json} />);
    expect(html).toContain("foo");
    expect(html).toContain("bar");
    expect(html).toContain("count");
    expect(html).toContain("3");
  });

  test("renders object keys with key color styling", () => {
    const html = String(<JsonView value={{ myKey: "myVal" }} />);
    // Key color is tokens.color.sky — SSR renders the var() indirection.
    expect(html).toContain("var(--color-sky)");
    expect(html).toContain("myKey");
  });

  test("renders array items", () => {
    const html = String(<JsonView value={["a", "b", "c"]} />);
    expect(html).toContain("a");
    expect(html).toContain("b");
    expect(html).toContain("c");
    expect(html).toContain("3 items");
  });

  test("uses <details> for collapsible behavior", () => {
    const html = String(<JsonView value={{ nested: { deep: true } }} />);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
  });

  test("renders collapse/expand affordance", () => {
    const html = String(<JsonView value={{ key: "val" }} />);
    expect(html).toContain("collapse");
  });

  test("collapsed=true renders expand label", () => {
    const html = String(<JsonView value={{ key: "val" }} collapsed />);
    expect(html).toContain("expand");
  });

  test("renders empty object without error", () => {
    const html = String(<JsonView value={{}} />);
    expect(html).toContain("{}");
  });

  test("renders empty array without error", () => {
    const html = String(<JsonView value={[]} />);
    expect(html).toContain("[]");
  });

  test("handles invalid JSON string gracefully (renders as string)", () => {
    const html = String(<JsonView value="not {valid json}" />);
    expect(html).toContain("not {valid json}");
  });
});
