import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPersonality,
  buildSystemPrompt,
  applyDrift,
  DEFAULT_PERSONALITY,
  SPECIES_PROFILES,
  speciesDefaults,
} from "../../src/brain/personality";
import { listSpeciesNames } from "../../src/face/species";

let tempBase: string;

beforeEach(() => {
  tempBase = mkdtempSync(join(tmpdir(), "siltpoke-pers-"));
});

afterEach(() => {
  rmSync(tempBase, { recursive: true, force: true });
});

test("missing config.json returns DEFAULT_PERSONALITY", async () => {
  const p = await loadPersonality(tempBase);
  expect(p).toEqual(DEFAULT_PERSONALITY);
});

test("malformed config.json returns DEFAULT_PERSONALITY silently", async () => {
  writeFileSync(join(tempBase, "config.json"), "not json");
  const p = await loadPersonality(tempBase);
  expect(p).toEqual(DEFAULT_PERSONALITY);
});

test("partial config merges over defaults", async () => {
  writeFileSync(
    join(tempBase, "config.json"),
    JSON.stringify({ name: "Yumi", snark: 9 }),
  );
  const p = await loadPersonality(tempBase);
  expect(p.name).toBe("Yumi");
  expect(p.snark).toBe(9);
  expect(p.patience).toBe(DEFAULT_PERSONALITY.patience);
});

test("buildSystemPrompt substitutes all placeholders", async () => {
  const template = "Hi {name}, you are a {species} with snark {snark}.";
  const templatePath = join(tempBase, "tmpl.md");
  writeFileSync(templatePath, template);
  const out = await buildSystemPrompt(
    { ...DEFAULT_PERSONALITY, name: "X", species: "cat", snark: 7 },
    templatePath,
  );
  expect(out).toBe("Hi X, you are a cat with snark 7.");
});

// Regression: the shipped system-prompt.md output-contract MUST instruct the
// structured `evidence` array. The Zod schema requires it and the NORMAL
// evidence-guard hard-rejects critiques with an empty evidence array, so a
// prompt that never mentions the field guarantees every NORMAL critique is
// silently dropped (the empty-Haiku bug). This test pins the contract.
test("buildSystemPrompt: shipped prompt instructs the evidence array contract", async () => {
  const out = await buildSystemPrompt(DEFAULT_PERSONALITY);
  // The output-contract JSON example must declare the evidence array field.
  expect(out).toContain('"evidence"');
  // NORMAL findings must be told to populate it with a verbatim tool snippet.
  expect(out.toLowerCase()).toContain("verbatim");
  // The field shape must reference the snippet key the guard checks.
  expect(out).toContain("snippet");
});

test("applyDrift: null drift returns identity", () => {
  const r = applyDrift(DEFAULT_PERSONALITY, null);
  expect(r).toEqual(DEFAULT_PERSONALITY);
});

test("applyDrift: positive drift adds + clamps to 10", () => {
  const r = applyDrift(
    { ...DEFAULT_PERSONALITY, snark: 9 },
    { snark: 3 },
  );
  expect(r.snark).toBe(10);
});

test("applyDrift: negative drift subtracts + clamps to 0", () => {
  const r = applyDrift(
    { ...DEFAULT_PERSONALITY, patience: 1 },
    { patience: -3 },
  );
  expect(r.patience).toBe(0);
});

test("applyDrift: out-of-range drift clamped to [-3, +3]", () => {
  const r = applyDrift(
    { ...DEFAULT_PERSONALITY, snark: 5 },
    { snark: 99 },
  );
  expect(r.snark).toBe(8); // 5 + clamp(99, -3, 3) = 5 + 3
});

test("buildSystemPrompt: applies drift to snark before substitution", async () => {
  const template = "snark={snark} patience={patience}";
  const templatePath = join(tempBase, "tmpl.md");
  writeFileSync(templatePath, template);
  const out = await buildSystemPrompt(
    { ...DEFAULT_PERSONALITY, snark: 5, patience: 5 },
    templatePath,
    { snark: 2, patience: -1 },
  );
  expect(out).toBe("snark=7 patience=4");
});

test("buildSystemPrompt substitutes every dial placeholder (no orphan braces)", async () => {
  const prompt = await buildSystemPrompt({ ...DEFAULT_PERSONALITY, name: "Zib", species: "cat", snark: 8 });
  // Placeholders are gone (substituted):
  for (const ph of ["{snark}", "{patience}", "{rigor}", "{chattiness}", "{curiosity}", "{name}", "{species}", "{language}"]) {
    expect(prompt).not.toContain(ph);
  }
  // The concrete values landed:
  expect(prompt).toContain("Zib");
  expect(prompt).toContain("cat");
  expect(prompt).toContain("8");
  // Each dial now carries a behavioral directive, not just a number legend.
  // Cue phrases below match the exact wording in system-prompt.md's personality block.
  for (const cue of ["Snark", "Patience", "Rigor", "Chattiness", "Curiosity"]) {
    expect(prompt).toContain(cue);
  }
});

describe("SPECIES_PROFILES", () => {
  test("every species has a profile with in-range dials", () => {
    for (const name of listSpeciesNames()) {
      const p = SPECIES_PROFILES[name];
      expect(p).toBeDefined();
      for (const v of Object.values(p!)) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(10);
      }
    }
  });

  test("slime is the all-5 anchor", () => {
    expect(SPECIES_PROFILES.slime).toEqual({ snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 });
  });

  test("cat is sassy + impatient (distinct from slime)", () => {
    expect(SPECIES_PROFILES.cat).toEqual({ snark: 8, patience: 2, rigor: 4, chattiness: 5, curiosity: 7 });
  });

  test("speciesDefaults falls back to slime for an unknown species", () => {
    expect(speciesDefaults("dragon")).toEqual(SPECIES_PROFILES.slime);
    expect(speciesDefaults("owl")).toEqual(SPECIES_PROFILES.owl);
  });
});
