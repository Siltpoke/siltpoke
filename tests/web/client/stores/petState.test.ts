/**
 * Pure store tests for petState — no DOM required.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { $pet, setPet } from "../../../../src/web/client/stores/petState";

const DEFAULT_PET = { name: "siltpoke", species: "slime", mood: "neutral", level: 1 } as const;

beforeEach(() => {
  // Reset the atom to its initial value before each test.
  // cleanStores() only clears listeners — we must reset the value explicitly.
  $pet.set({ ...DEFAULT_PET });
});

describe("$pet default state", () => {
  it("returns default pet on first get()", () => {
    const pet = $pet.get();
    expect(pet.name).toBe("siltpoke");
    expect(pet.species).toBe("slime");
    expect(pet.mood).toBe("neutral");
    expect(pet.level).toBe(1);
  });
});

describe("setPet", () => {
  it("shallow-merges a single field", () => {
    setPet({ mood: "happy" });
    const pet = $pet.get();
    expect(pet.mood).toBe("happy");
    // other fields preserved
    expect(pet.name).toBe("siltpoke");
    expect(pet.species).toBe("slime");
    expect(pet.level).toBe(1);
  });

  it("updates multiple keys at once", () => {
    setPet({ name: "Bangbang", level: 2 });
    const pet = $pet.get();
    expect(pet.name).toBe("Bangbang");
    expect(pet.level).toBe(2);
    // unspecified keys preserved
    expect(pet.species).toBe("slime");
    expect(pet.mood).toBe("neutral");
  });

  it("ignores explicit undefined values (no field overwrite)", () => {
    // `Partial<Pet>` permits `undefined` at the type level; setPet must
    // NOT overwrite a real value with `undefined`. Important once a caller
    // builds the patch from a form / API and forwards optional keys.
    setPet({ mood: undefined, name: "Bangbang" });
    const pet = $pet.get();
    expect(pet.mood).toBe("neutral"); // preserved
    expect(pet.name).toBe("Bangbang"); // applied
  });
});

describe("subscribe", () => {
  it("fires callback when state changes", () => {
    const calls: string[] = [];
    const unsub = $pet.subscribe((pet) => {
      calls.push(pet.mood);
    });
    try {
      setPet({ mood: "sleepy" });
      // nanostores fires immediately on subscribe + again on set
      expect(calls).toContain("sleepy");
    } finally {
      unsub();
    }
  });

  it("returns an unsubscribe function that stops further callbacks", () => {
    const calls: string[] = [];
    const unsub = $pet.subscribe((pet) => {
      calls.push(pet.mood);
    });
    // Record initial call count
    const countAfterSubscribe = calls.length;
    unsub();
    setPet({ mood: "sad" });
    // No new calls after unsub
    expect(calls.length).toBe(countAfterSubscribe);
  });
});
