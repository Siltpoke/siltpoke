import { test, expect, describe } from "bun:test";
import { relativeTime, shortenPath } from "../../../src/web/primitives/active-repos-format";

const NOW = new Date("2026-06-27T12:00:00Z");

describe("relativeTime", () => {
  test("under a minute → just now", () => {
    expect(relativeTime("2026-06-27T11:59:30Z", NOW)).toBe("just now");
  });
  test("minutes / hours / days / weeks / months / years", () => {
    expect(relativeTime("2026-06-27T11:40:00Z", NOW)).toBe("20m ago");
    expect(relativeTime("2026-06-27T09:00:00Z", NOW)).toBe("3h ago");
    expect(relativeTime("2026-06-24T12:00:00Z", NOW)).toBe("3d ago");
    expect(relativeTime("2026-06-13T12:00:00Z", NOW)).toBe("2w ago");
    expect(relativeTime("2026-04-27T12:00:00Z", NOW)).toBe("2mo ago");
    expect(relativeTime("2025-06-27T12:00:00Z", NOW)).toBe("1y ago");
  });
  test("future timestamp clamps to just now", () => {
    expect(relativeTime("2026-06-27T13:00:00Z", NOW)).toBe("just now");
  });
  test("unparseable input → empty string", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("");
  });
});

describe("shortenPath", () => {
  test("collapses home prefix to ~", () => {
    expect(shortenPath("/Users/x/Projects/app", "/Users/x")).toBe("~/Projects/app");
  });
  test("leaves non-home paths untouched when short", () => {
    expect(shortenPath("/code/app", "/Users/x")).toBe("/code/app");
  });
  test("middle-truncates deep paths", () => {
    const out = shortenPath(
      "/Users/x/code/workspace/team/backend/service/service",
      "/Users/x",
    );
    expect(out.startsWith("~/…/")).toBe(true);
    expect(out.endsWith("service/service")).toBe(true);
  });
  test("no home match still truncates deep absolute paths", () => {
    const out = shortenPath(
      "/var/folders/abcdefgh/Projects/ai-agents/deep/nested/repo",
      "/Users/x",
    );
    expect(out).toBe("/…/nested/repo");
  });
});
