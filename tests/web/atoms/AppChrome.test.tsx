/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { AppChrome } from "../../../src/web/atoms/AppChrome";
import { tokens } from "../../../src/web/tokens/tokens";

/**
 * AppChrome's "siltpoked · 127.0.0.1:9876 / connected" top
 * status bar was dropped. Daemon identity now lives in the sidebar footer.
 * AppChrome remains as a thin cream-background container so existing
 * call sites compile unchanged.
 */
describe("AppChrome", () => {
  test("renders cream background", () => {
    const html = String(<AppChrome>content</AppChrome>);
    expect(html).toContain(tokens.color.cream);
  });

  test("renders children inside container", () => {
    const html = String(<AppChrome>screen content</AppChrome>);
    expect(html).toContain("screen content");
  });

  test("accepts title / subtitle / accent props for back-compat (no longer rendered)", () => {
    const html = String(
      <AppChrome title=" / inbox" subtitle="syncing" accent={tokens.color.moss}>
        body
      </AppChrome>,
    );
    expect(html).toContain("body");
    expect(html).not.toContain("siltpoked");
    expect(html).not.toContain("127.0.0.1");
    expect(html).not.toContain("connected");
  });
});
