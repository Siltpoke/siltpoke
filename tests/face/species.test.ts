import { test, expect } from "bun:test";
import {
  getSpecies,
  listSpeciesNames,
  DEFAULT_SPECIES,
} from "../../src/face/species";

test("getSpecies returns named species when found", () => {
  const cat = getSpecies("cat");
  expect(cat.name).toBe("cat");
  expect(cat.art.base.length).toBeGreaterThan(0);
});

test("getSpecies falls back to default when name is unknown", () => {
  const result = getSpecies("nonexistent");
  expect(result.name).toBe(DEFAULT_SPECIES);
});

test("getSpecies falls back to default when name is undefined", () => {
  const result = getSpecies(undefined);
  expect(result.name).toBe(DEFAULT_SPECIES);
});

test("listSpeciesNames includes the default", () => {
  expect(listSpeciesNames()).toContain(DEFAULT_SPECIES);
});

test("every species exposes base / concerned / sleeping art", () => {
  for (const name of listSpeciesNames()) {
    const sp = getSpecies(name);
    expect(typeof sp.art.base).toBe("string");
    expect(typeof sp.art.concerned).toBe("string");
    expect(typeof sp.art.sleeping).toBe("string");
  }
});

test("every variant has consistent line widths within itself", () => {
  for (const name of listSpeciesNames()) {
    const sp = getSpecies(name);
    for (const variant of ["base", "concerned", "sleeping"] as const) {
      const lines = sp.art[variant].split("\n");
      const widths = new Set(lines.map((l) => l.length));
      expect(widths.size).toBe(1);
    }
  }
});

test("base and concerned variants share the same width per species", () => {
  for (const name of listSpeciesNames()) {
    const sp = getSpecies(name);
    const baseW = sp.art.base.split("\n")[0]?.length;
    const concernedW = sp.art.concerned.split("\n")[0]?.length;
    expect(concernedW).toBe(baseW);
  }
});
