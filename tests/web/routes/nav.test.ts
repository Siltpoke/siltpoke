import { test, expect, describe } from "bun:test";
import { CANONICAL_NAV } from "../../../src/web/routes/nav";
import type { NavEntry, NavSection } from "../../../src/web/routes/nav";

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

  test("total flat entry count is 4", () => {
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

  test("memory entry has href '/memory'", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    const mem = allEntries.find((e) => e.id === "memory");
    expect(mem?.href).toBe("/memory");
  });

  test("chat entry removed from nav (floating chat replaces standalone tab)", () => {
    const allEntries = CANONICAL_NAV.flatMap((s) => s.entries);
    expect(allEntries.find((e) => e.id === "chat")).toBeUndefined();
  });

  test("removed surfaces stay removed (settings/help/inventory/friends/commands)", () => {
    const ids = CANONICAL_NAV.flatMap((s) => s.entries).map((e) => e.id as string);
    for (const gone of ["settings", "help", "inventory", "friends", "commands"]) {
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
});
