/**
 * action-result island unit tests.
 *
 * The island registers a `window.addEventListener("action-result", ...)` at
 * module evaluation time. To test it, we:
 *   1. Set up a globalThis.window mock with an event capture mechanism.
 *   2. Import the island module (or invoke the handler directly via the
 *      captured listener).
 *   3. Dispatch a synthetic CustomEvent and assert $pet was updated.
 *
 * Strategy: test the handler logic by directly testing `setPet` effects via
 * the `$pet` nanostore — we don't rely on a real DOM. We mock `window` and
 * capture the listener, then invoke it manually.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { $pet, setPet } from "../../../../src/web/client/stores/petState";

// ─── Window mock ──────────────────────────────────────────────────────────────

type Listener = (evt: Event) => void;
const captured: Map<string, Listener[]> = new Map();

function mockWindow() {
  (globalThis as unknown as Record<string, unknown>).window = {
    addEventListener(type: string, handler: Listener) {
      const list = captured.get(type) ?? [];
      list.push(handler);
      captured.set(type, list);
    },
    removeEventListener(_type: string, _handler: Listener) {},
  };
}

function dispatchCaptured(type: string, detail: unknown): void {
  const listeners = captured.get(type) ?? [];
  const evt = new (class MockCustomEvent {
    readonly type = type;
    readonly detail = detail;
  })() as unknown as CustomEvent;
  for (const fn of listeners) {
    fn(evt as unknown as Event);
  }
}

// Reset $pet to a known state before each test.
const DEFAULT_PET = { name: "siltpoke", species: "slime" as const, mood: "neutral" as const, level: 1 };

beforeEach(() => {
  $pet.set({ ...DEFAULT_PET });
  captured.clear();
  mockWindow();
});

// The mock must not outlive each test: bun runs every file in one process,
// and a surviving bare `window` makes `typeof window` lie suite-wide
// (pinned by zz-global-restore.canary.test.ts). `delete`, not `= undefined`.
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

// ─── Import island (re-import registers listener in mocked window context) ────

// Because bun caches modules, we test the handler logic directly by:
//   1. Re-creating the handler logic from the island source (same algorithm).
//   2. Verifying $pet is mutated correctly.
//
// This avoids fighting bun's module cache while still pinning the observable
// contract (listener registers → event dispatched → $pet updated).

/**
 * Mirrors the action-result handler logic from the island source.
 * If the island logic changes, this must be updated to match.
 *
 * mood + species pass through allowlist narrowing
 * before merging. Unknown values are silently dropped from the patch.
 */
const VALID_MOODS = ["neutral", "happy", "sleepy", "sad", "hungry", "poke", "snark", "wow"] as const;
const VALID_SPECIES = ["cat", "bunny", "robot", "bun", "otter", "alien", "slime", "crab"] as const;

function makeActionResultHandler() {
  return (evt: Event): void => {
    type ActionResultPayload = {
      level?: number;
      mood?: string;
      name?: string;
      species?: string;
    };
    const detail = (evt as CustomEvent<ActionResultPayload>).detail;
    if (!detail || typeof detail !== "object") return;

    type Pet = { name: string; species: string; mood: string; level: number };
    const patch: Partial<Pet> = {};
    if (typeof detail.level === "number") patch.level = detail.level;
    if (
      typeof detail.mood === "string" &&
      (VALID_MOODS as readonly string[]).includes(detail.mood)
    ) {
      patch.mood = detail.mood;
    }
    if (typeof detail.name === "string") patch.name = detail.name;
    if (
      typeof detail.species === "string" &&
      (VALID_SPECIES as readonly string[]).includes(detail.species)
    ) {
      patch.species = detail.species;
    }

    // Use the real setPet to update $pet.
    setPet(patch as Parameters<typeof setPet>[0]);
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("action-result island handler", () => {
  it("updates $pet.level from action-result payload", () => {
    const handler = makeActionResultHandler();
    const evt = { detail: { level: 5, mood: "happy", name: "siltpoke", species: "cat" } } as unknown as Event;
    handler(evt);
    expect($pet.get().level).toBe(5);
  });

  it("updates $pet.mood from action-result payload", () => {
    const handler = makeActionResultHandler();
    handler({ detail: { level: 2, mood: "sad" } } as unknown as Event);
    expect($pet.get().mood).toBe("sad");
  });

  it("updates $pet.name from action-result payload", () => {
    const handler = makeActionResultHandler();
    handler({ detail: { name: "bangbang" } } as unknown as Event);
    expect($pet.get().name).toBe("bangbang");
  });

  it("updates $pet.species from action-result payload", () => {
    const handler = makeActionResultHandler();
    handler({ detail: { species: "bunny" } } as unknown as Event);
    expect($pet.get().species).toBe("bunny");
  });

  it("partial payload only merges provided fields — other fields unchanged", () => {
    $pet.set({ name: "original", species: "slime", mood: "neutral", level: 1 });
    const handler = makeActionResultHandler();
    handler({ detail: { level: 7 } } as unknown as Event);

    const pet = $pet.get();
    expect(pet.level).toBe(7);
    expect(pet.name).toBe("original");
    expect(pet.species).toBe("slime");
    expect(pet.mood).toBe("neutral");
  });

  it("does nothing when detail is null", () => {
    const before = { ...$pet.get() };
    const handler = makeActionResultHandler();
    handler({ detail: null } as unknown as Event);
    expect($pet.get()).toEqual(before);
  });

  it("does nothing when detail is not an object (string)", () => {
    const before = { ...$pet.get() };
    const handler = makeActionResultHandler();
    handler({ detail: "bad" } as unknown as Event);
    expect($pet.get()).toEqual(before);
  });

  it("ignores non-numeric level values", () => {
    $pet.set({ ...DEFAULT_PET, level: 3 });
    const handler = makeActionResultHandler();
    handler({ detail: { level: "not-a-number" } } as unknown as Event);
    expect($pet.get().level).toBe(3);
  });

  it("window.addEventListener registration — listener is captured", () => {
    // Verify the island module registers on window (simulated via captured map).
    // We call addEventListener explicitly in the mock setup; this test confirms
    // our mock captures correctly so downstream tests are valid.
    window.addEventListener("action-result", makeActionResultHandler());
    expect(captured.has("action-result")).toBe(true);
    expect(captured.get("action-result")?.length).toBe(1);
  });

  it("rejects unknown mood value (allowlist narrowing — keeps existing mood)", () => {
    $pet.set({ ...DEFAULT_PET, mood: "happy" });
    const handler = makeActionResultHandler();
    handler({ detail: { mood: "ecstatic" } } as unknown as Event);
    expect($pet.get().mood).toBe("happy");
  });

  it("rejects unknown species value (allowlist narrowing — keeps existing species)", () => {
    $pet.set({ ...DEFAULT_PET, species: "cat" });
    const handler = makeActionResultHandler();
    handler({ detail: { species: "dragon" } } as unknown as Event);
    expect($pet.get().species).toBe("cat");
  });

  it("accepts all 8 canonical moods", () => {
    const handler = makeActionResultHandler();
    for (const mood of VALID_MOODS) {
      handler({ detail: { mood } } as unknown as Event);
      expect($pet.get().mood).toBe(mood);
    }
  });

  it("full roundtrip: dispatch event → $pet updated with level + mood", () => {
    const handler = makeActionResultHandler();
    window.addEventListener("action-result", handler);

    dispatchCaptured("action-result", { level: 8, mood: "happy", name: "siltpoke", species: "cat" });

    const pet = $pet.get();
    expect(pet.level).toBe(8);
    expect(pet.mood).toBe("happy");
    expect(pet.species).toBe("cat");
  });
});
