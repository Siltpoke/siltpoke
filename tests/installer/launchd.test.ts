import { describe, test, expect } from "bun:test";
import { renderPlist } from "../../src/installer/launchd";

describe("renderPlist", () => {
  test("includes absolute bun path", () => {
    const xml = renderPlist({
      bunPath: "/Users/x/.bun/bin/bun",
      daemonScript: "/abs/cli/daemon.ts",
    });
    expect(xml).toContain("<string>/Users/x/.bun/bin/bun</string>");
    expect(xml).toContain("<string>/abs/cli/daemon.ts</string>");
  });

  test("sets ThrottleInterval to 10", () => {
    const xml = renderPlist({ bunPath: "/x", daemonScript: "/y" });
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  test("KeepAlive=true and RunAtLoad=true", () => {
    const xml = renderPlist({ bunPath: "/x", daemonScript: "/y" });
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test("escapes XML special characters in paths", () => {
    const xml = renderPlist({
      bunPath: "/Users/a&b/bin/bun",
      daemonScript: "/abs/<dir>/daemon.ts",
    });
    expect(xml).toContain("<string>/Users/a&amp;b/bin/bun</string>");
    expect(xml).toContain("<string>/abs/&lt;dir&gt;/daemon.ts</string>");
    // Raw unescaped characters must not appear in the path strings.
    expect(xml).not.toContain("<string>/Users/a&b/bin/bun</string>");
    expect(xml).not.toContain("<string>/abs/<dir>/daemon.ts</string>");
  });
});
