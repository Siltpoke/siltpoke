import { test, expect } from "bun:test";
import { resolveArt } from "../../src/state/pose";
import { getSpecies } from "../../src/face/species";

test("happy mood resolves to base variant", () => {
  const cat = getSpecies("cat");
  expect(resolveArt(cat, "happy")).toBe(cat.art.base);
});

test("annoyed mood resolves to concerned variant", () => {
  const cat = getSpecies("cat");
  expect(resolveArt(cat, "annoyed")).toBe(cat.art.concerned);
});

test("concerned mood resolves to concerned variant", () => {
  const cat = getSpecies("cat");
  expect(resolveArt(cat, "concerned")).toBe(cat.art.concerned);
});

test("tired mood resolves to concerned variant", () => {
  const cat = getSpecies("cat");
  expect(resolveArt(cat, "tired")).toBe(cat.art.concerned);
});

test("sleeping_quiet resolves to sleeping variant", () => {
  const cat = getSpecies("cat");
  expect(resolveArt(cat, "sleeping_quiet")).toBe(cat.art.sleeping);
});

test("sleeping_broke resolves to sleeping variant", () => {
  const cat = getSpecies("cat");
  expect(resolveArt(cat, "sleeping_broke")).toBe(cat.art.sleeping);
});

test("unknown mood falls back to base", () => {
  const cat = getSpecies("cat");
  expect(resolveArt(cat, "nonsense")).toBe(cat.art.base);
});

test("works for every species", () => {
  for (const name of ["slime", "cat", "owl", "robot", "bunny"]) {
    const sp = getSpecies(name);
    expect(resolveArt(sp, "annoyed")).toBe(sp.art.concerned);
    expect(resolveArt(sp, "happy")).toBe(sp.art.base);
  }
});

test("idle mood accepts nowMs param without throwing", () => {
  const cat = getSpecies("cat");
  expect(resolveArt(cat, "idle", undefined, undefined, 0)).toBe(cat.art.base);
  expect(resolveArt(cat, "idle", undefined, undefined, 2_000)).toBe(cat.art.base);
  expect(resolveArt(cat, "idle", undefined, undefined, 4_000)).toBe(cat.art.base);
});

test("watching mood is animated-eligible but v1 species return base", () => {
  const slime = getSpecies("slime");
  for (let t = 0; t < 10_000; t += 1000) {
    expect(resolveArt(slime, "watching", undefined, undefined, t)).toBe(slime.art.base);
  }
});

test("non-animated mood ignores nowMs", () => {
  const owl = getSpecies("owl");
  expect(resolveArt(owl, "annoyed", undefined, undefined, 12_345)).toBe(owl.art.concerned);
  expect(resolveArt(owl, "annoyed", undefined, undefined, 67_890)).toBe(owl.art.concerned);
});
