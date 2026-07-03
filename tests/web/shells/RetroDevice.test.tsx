/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { RetroDevice } from "../../../src/web/shells/RetroDevice";
import { tokens } from "../../../src/web/tokens/tokens";

describe("RetroDevice", () => {
  test("renders children inside LCD screen", () => {
    const html = String(
      <RetroDevice>
        <pre id="creature">creature art</pre>
      </RetroDevice>,
    );
    expect(html).toContain('id="creature"');
    expect(html).toContain("creature art");
  });

  test("shell uses egg radial gradient", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    expect(html).toContain(tokens.color.egg);
    expect(html).toContain(tokens.color.egg2);
    expect(html).toContain("radial-gradient");
  });

  test("LCD screen uses lcd background color", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    expect(html).toContain(tokens.color.lcd);
  });

  test("renders A, B, C button labels", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    expect(html).toContain(">A<");
    expect(html).toContain(">B<");
    expect(html).toContain(">C<");
  });

  test("A and C buttons use terra color", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    // terra appears in button backgrounds
    expect(html).toContain(tokens.color.terra);
  });

  test("B button uses amber color", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    expect(html).toContain(tokens.color.amber);
  });

  test("lanyard ring is INSIDE the egg at canonical top:32 (16×22)", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    expect(html).toContain("width:16");
    expect(html).toContain("height:22");
    expect(html).toContain("top:32");
  });

  test("default dimensions 280×340 applied (canonical)", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    expect(html).toContain("width:280");
    expect(html).toContain("height:340");
  });

  test("LCD fixed 200×160 at canonical top:85", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    expect(html).toContain("width:200");
    expect(html).toContain("height:160");
    expect(html).toContain("top:85");
  });

  test("button captions render as a separate row (not stacked under buttons)", () => {
    const html = String(
      <RetroDevice buttonCaptions={{ a: "feed", b: "play", c: "scold" }}>
        <span>x</span>
      </RetroDevice>,
    );
    // captions row tight under buttons at bottom:28
    expect(html).toContain("bottom:28");
  });

  test("custom dimensions respected", () => {
    const html = String(
      <RetroDevice width={220} height={300}><span>x</span></RetroDevice>,
    );
    expect(html).toContain("width:220");
    expect(html).toContain("height:300");
  });

  test("outer shell has egg-shaped border radius", () => {
    const html = String(<RetroDevice><span>x</span></RetroDevice>);
    // Asymmetric egg shape border-radius
    expect(html).toContain("46%");
  });

  test("optional chrome title renders above LCD", () => {
    const html = String(
      <RetroDevice chrome="SILTPOKE · v0.4.1"><span>x</span></RetroDevice>,
    );
    expect(html).toContain("SILTPOKE · v0.4.1");
  });

  test("button captions render under each toy button", () => {
    const html = String(
      <RetroDevice buttonCaptions={{ a: "feed", b: "play", c: "scold" }}>
        <span>x</span>
      </RetroDevice>,
    );
    expect(html).toContain("feed");
    expect(html).toContain("play");
    expect(html).toContain("scold");
  });

  test("button captions are optional per-slot", () => {
    const html = String(
      <RetroDevice buttonCaptions={{ b: "ok" }}><span>x</span></RetroDevice>,
    );
    expect(html).toContain("ok");
  });

  test("ToyButton NOT exported (private helper)", () => {
    // ToyButton must not be in the module exports; only RetroDevice is exported.
    // We verify by checking the import of the module only exposes RetroDevice.
    const mod = require("../../../src/web/shells/RetroDevice");
    expect(typeof mod.RetroDevice).toBe("function");
    expect(mod.ToyButton).toBeUndefined();
  });
});
