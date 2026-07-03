/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { NoChrome } from "../../../src/web/shells/NoChrome";
import { tokens } from "../../../src/web/tokens/tokens";

describe("NoChrome", () => {
  test("renders children", () => {
    const html = String(
      <NoChrome>
        <div id="inner">hello</div>
      </NoChrome>,
    );
    expect(html).toContain('id="inner"');
    expect(html).toContain("hello");
  });

  test("uses cream background", () => {
    const html = String(<NoChrome><span>x</span></NoChrome>);
    expect(html).toContain(tokens.color.cream);
  });

  test("has height:100%", () => {
    const html = String(<NoChrome><span>x</span></NoChrome>);
    expect(html).toContain("height:100%");
  });

  test("default align=start uses stretch align-items", () => {
    const html = String(<NoChrome><span>x</span></NoChrome>);
    expect(html).toContain("align-items:stretch");
  });

  test("align=center uses center align-items and justify-content", () => {
    const html = String(<NoChrome align="center"><span>x</span></NoChrome>);
    expect(html).toContain("align-items:center");
    expect(html).toContain("justify-content:center");
  });

  test("default align=start uses flex-start justify-content", () => {
    const html = String(<NoChrome><span>x</span></NoChrome>);
    expect(html).toContain("justify-content:flex-start");
  });

  test("default pad=0 renders padding:0", () => {
    const html = String(<NoChrome><span>x</span></NoChrome>);
    expect(html).toContain("padding:0");
  });

  test("custom pad applied", () => {
    const html = String(<NoChrome pad={24}><span>x</span></NoChrome>);
    expect(html).toContain("padding:24");
  });

  test("no AppChrome chrome elements present", () => {
    const html = String(<NoChrome><span>x</span></NoChrome>);
    // No siltpoked address bar — NoChrome has no AppChrome wrapper
    expect(html).not.toContain("siltpoked");
    expect(html).not.toContain("127.0.0.1");
  });
});
