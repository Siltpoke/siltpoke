import { test, expect, describe } from "bun:test";
import { CANONICAL_NAV } from "../../../src/web/routes/nav";
import type { NavEntry, NavSection } from "../../../src/web/routes/nav";
import { ICON_NAMES } from "../../../src/web/atoms/Icon";

describe("CANONICAL_NAV (sectioned)", () => {
  test("exports exactly 2 sections", () => {
    expect(CANONICAL_NAV).toHaveLength(2);
  });

  test("section ids are 'pet' and 'work' in order", () => {
    const ids = CANONICAL_NAV.map((s) => s.id);
    expect(ids).toEqual(["pet", "work"]);
  });

  test("section labels are 'PET' and 'WORK' in order", () => {
    const labels = CANONICAL_NAV.map((s) => s.label);
    expect(labels).toEqual(["PET", "WORK"]);
  });

  // This one is a genuine count test by design (a change detector for
  // accidental additions/removals to CANONICAL_NAV), not a stand-in for a
  // named assertion — kept as a count per the file's own convention, bumped
  // 4 → 5 for the "knowledge" WORK entry added in Task 12, then 5 → 6 for
  // "decisions" (Task 8 of the Decisions-log view, 2026-08-13), then 6 → 7
  // for "progress" (progress-page-slice-1 Task 7, 2026-08-14), then back to 6
  // when "decisions" was removed with its route (2026-08-17): that view is a
  // sheet on /knowledge now, so a nav entry would point at a dead path.
  test("total flat entry count is 4 (Knowledge added 2026-08-06; Progress added 2026-08-14; Decisions removed 2026-08-17 with its route; Quests + Settings removed 2026-08-06 with their unmounts)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    expect(allEntries).toHaveLength(4);
  });

  test("PET section contains home only", () => {
    const pet = CANONICAL_NAV.find((s) => s.id === "pet");
    expect(pet?.entries.map((e) => e.id)).toEqual(["home"]);
  });

  test("WORK section contains timeline / memory / repo-graph in order", () => {
    const work = CANONICAL_NAV.find((s) => s.id === "work");
    expect(work?.entries.map((e) => e.id)).toEqual([
      "timeline",
      "memory",
      "repo-graph",
    ]);
  });

  // The removal, asserted rather than merely implied by the count above: a
  // nav entry pointing at a route nobody mounts renders a link to a 404.
  test("no nav entry points at the retired /knowledge/decisions page", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    expect(allEntries.map((e) => e.id)).not.toContain("decisions");
    expect(allEntries.map((e) => e.href)).not.toContain("/knowledge/decisions");
  });

  test("reinternalize/Restate nav entry stays removed (spec §5, shelved surface stripped)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    // `id: Section` no longer has a "reinternalize" member (removed with the
    // surface) — the type system now enforces this at compile time. The
    // runtime check that still makes sense is on the plain-string fields.
    expect(allEntries.find((e) => e.href === "/reinternalize")).toBeUndefined();
    expect(allEntries.find((e) => e.label === "Restate")).toBeUndefined();
  });

  test("no entry is disabled (placeholders were removed, not parked)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    expect(allEntries.filter((e) => e.disabled === true)).toHaveLength(0);
  });

  test("each entry has id, label, href fields", () => {
    for (const section of CANONICAL_NAV) {
      for (const entry of section.entries) {
        expect(entry.id).toBeTruthy();
        expect(entry.label).toBeTruthy();
        expect(entry.href).toBeTruthy();
      }
    }
  });

  test("home entry has href '/'", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    const home = allEntries.find((e) => e.id === "home");
    expect(home?.href).toBe("/");
  });

  /**
   * `NavEntry.icon` is a plain `string` and `Icon` renders an unknown name as
   * raw TEXT rather than failing, so a typo here reaches the sidebar as a word.
   * This is the only check between that and a shipped page.
   */
  test("every nav icon names a glyph the registry actually has", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    const named = allEntries.filter((e) => e.icon !== undefined);
    // Non-empty, or the loop below asserts nothing at all.
    expect(named.length).toBeGreaterThan(0);
    for (const e of named) {
      expect({ id: e.id, known: ICON_NAMES.has(e.icon as string) }).toEqual({ id: e.id, known: true });
    }
  });

  test("memory entry has href '/memory'", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    const mem = allEntries.find((e) => e.id === "memory");
    expect(mem?.href).toBe("/memory");
  });

  test("chat entry removed from nav (floating chat replaces standalone tab)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    expect(allEntries.find((e) => e.id === "chat")).toBeUndefined();
  });

  // "settings" was re-added in Slice C (the review-brain selector), then hidden again
  // 2026-08-06 with its route's unmount. It is covered by the entry-count and
  // unmounted-route guards above rather than by this removed-set list, which predates it.
  test("removed surfaces stay removed (help/inventory/friends/commands)", () => {
    const ids = CANONICAL_NAV.flatMap((s) => s.entries).map((e) => e.id as string);
    for (const gone of ["help", "inventory", "friends", "commands"]) {
      expect(ids).not.toContain(gone);
    }
  });

  test("stats nav entry removed (diagnostic panels moved into Home)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    const ids: string[] = allEntries.map((e) => e.id);
    expect(ids).not.toContain("stats");
  });

  test("timeline is enabled and points at /timeline (merged /history + /traces page)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    const t = allEntries.find((e) => e.id === "timeline");
    expect(t?.disabled).not.toBe(true);
    expect(t?.href).toBe("/timeline");
    expect(t?.label).toBe("Timeline");
  });

  test("history and traces nav entries removed (no dead entries; /history + /traces are redirects now)", () => {
    const ids = CANONICAL_NAV.flatMap((s) => s.entries).map((e) => e.id);
    expect(ids).not.toContain("history");
    expect(ids).not.toContain("traces");
  });

  test("home is NOT disabled (active route)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    expect(allEntries.find((e) => e.id === "home")?.disabled).not.toBe(true);
  });

  test("memory is NOT disabled (active route)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    expect(allEntries.find((e) => e.id === "memory")?.disabled).not.toBe(true);
  });

  test("NavEntry interface: disabled is optional boolean", () => {
    // Compile-time shape check — if NavEntry type is wrong, tsc will catch it.
    // This runtime test confirms a disabled-less entry is valid.
    const entry: NavEntry = { id: "home", label: "Home", href: "/" };
    expect(entry.disabled).toBeUndefined();
  });

  test("NavSection interface shape compile-check", () => {
    // If NavSection type is wrong, tsc will catch it.
    const section: NavSection = {
      id: "pet",
      label: "PET",
      entries: [{ id: "home", label: "Home", href: "/" }],
    };
    expect(section.id).toBe("pet");
    expect(section.entries).toHaveLength(1);
  });

  test("no nav entry points at an unmounted route", () => {
    // The nav is the only thing that made a retired page discoverable, so this is the guard
    // that keeps the hide honest: a link to a route the daemon does not mount is a 404
    // the user finds, not a page.
    const hrefs = CANONICAL_NAV.flatMap((s) => s.entries).map((e) => e.href);
    expect(hrefs).not.toContain("/derived-view");
    expect(hrefs).not.toContain("/settings");
  });
});
