import { describe, test, expect } from "bun:test";
import {
  checkOllamaInstalled,
  setupOllamaInteractive,
  OLLAMA_MODEL,
} from "../../src/installer/setup-ollama";

describe("setup-ollama", () => {
  test("checkOllamaInstalled false when binary missing", async () => {
    const result = await checkOllamaInstalled({ which: async () => null });
    expect(result).toBe(false);
  });

  test("checkOllamaInstalled true when binary present", async () => {
    const result = await checkOllamaInstalled({ which: async () => "/opt/homebrew/bin/ollama" });
    expect(result).toBe(true);
  });

  // sq-ollama-silent-pull (day-1): announce the pull so it isn't mistaken
  // for a silent multi-minute hang.
  test("emits a branded pulling notice before the pull when ollama is installed", async () => {
    const writes: string[] = [];
    const order: string[] = [];
    const result = await setupOllamaInteractive({
      io: {
        write: (s) => {
          writes.push(s);
          order.push("write");
        },
      },
      deps: {
        checkInstalled: async () => true,
        pull: async () => {
          order.push("pull");
        },
        validate: async () => true,
      },
    });
    expect(result.enabled).toBe(true);
    const joined = writes.join("");
    expect(joined).toContain(OLLAMA_MODEL); // names the model
    expect(joined.toLowerCase()).toContain("pulling"); // tells the user what's happening
    // The notice must precede the pull, not trail it.
    expect(order.indexOf("write")).toBeLessThan(order.indexOf("pull"));
  });

  test("does not announce 'ready' before validation, and stays quiet when validation fails", async () => {
    const writes: string[] = [];
    const result = await setupOllamaInteractive({
      io: { write: (s) => writes.push(s) },
      deps: {
        checkInstalled: async () => true,
        pull: async () => {},
        validate: async () => false, // pull ok, validation fails
      },
    });
    expect(result.enabled).toBe(false);
    // The pulling heads-up still fires, but "ready" must NOT — it would
    // contradict the validation-failed warning that follows.
    const joined = writes.join("").toLowerCase();
    expect(joined).toContain("pulling");
    expect(joined).not.toContain("ready");
  });

  test("no pulling notice when ollama is not installed", async () => {
    const writes: string[] = [];
    const result = await setupOllamaInteractive({
      io: { write: (s) => writes.push(s) },
      deps: {
        checkInstalled: async () => false,
        pull: async () => {
          throw new Error("pull must not run when ollama absent");
        },
        validate: async () => false,
      },
    });
    expect(result.enabled).toBe(false);
    expect(writes.join("").toLowerCase()).not.toContain("pulling");
  });
});
