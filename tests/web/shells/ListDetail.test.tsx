/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { ListDetail } from "../../../src/web/shells/ListDetail";
import { tokens } from "../../../src/web/tokens/tokens";

describe("ListDetail", () => {
  test("renders list slot content", () => {
    const html = String(
      <ListDetail
        list={<div id="list-slot">list here</div>}
        detail={<div>detail</div>}
      />,
    );
    expect(html).toContain('id="list-slot"');
    expect(html).toContain("list here");
  });

  test("renders detail slot content", () => {
    const html = String(
      <ListDetail
        list={<div>list</div>}
        detail={<div id="detail-slot">detail here</div>}
      />,
    );
    expect(html).toContain('id="detail-slot"');
    expect(html).toContain("detail here");
  });

  test("default list width is 280px", () => {
    const html = String(
      <ListDetail
        list={<div>list</div>}
        detail={<div>detail</div>}
      />,
    );
    expect(html).toContain("width:280");
  });

  test("custom listWidth respected", () => {
    const html = String(
      <ListDetail
        listWidth={200}
        list={<div>list</div>}
        detail={<div>detail</div>}
      />,
    );
    expect(html).toContain("width:200");
  });

  test("list side has paper background with edge border", () => {
    const html = String(
      <ListDetail
        list={<div>list</div>}
        detail={<div>detail</div>}
      />,
    );
    expect(html).toContain(tokens.color.paper);
    expect(html).toContain(tokens.color.edge);
  });

  test("detail side has cream background", () => {
    const html = String(
      <ListDetail
        list={<div>list</div>}
        detail={<div>detail</div>}
      />,
    );
    expect(html).toContain(tokens.color.cream);
  });

  test("outer container is flex row", () => {
    const html = String(
      <ListDetail
        list={<div>list</div>}
        detail={<div>detail</div>}
      />,
    );
    // The outer div has display:flex with height:100% (no explicit flex-direction = row)
    expect(html).toContain("display:flex");
    expect(html).toContain("height:100%");
  });
});
