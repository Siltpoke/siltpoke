import { describe, expect, test } from "bun:test";
import { speciesDefaults } from "../../src/brain/personality";
import { runPersonalityWizard } from "../../src/installer/personality-wizard";
import type { WizardIO } from "../../src/installer/wizard";

/**
 * Scripted IO matching the real WizardIO shape (readLine/write) — see
 * src/installer/wizard.ts. Each entry is consumed in the order the wizard
 * asks; "" (Enter) picks whatever default the prompt offers.
 */
function fakeIO(answers: string[]): WizardIO {
  let i = 0;
  return {
    async readLine() {
      return answers[i++] ?? "";
    },
    write(_s: string) {},
  };
}

describe("wizard seeds dials from the species profile", () => {
  test("a fresh cat via 'defaults' method starts with the cat profile, not all-5", async () => {
    // name Enter (random), species=cat, language Enter (en), method=defaults.
    const io = fakeIO(["", "cat", "", "defaults"]);
    const p = await runPersonalityWizard({ io, claudeHome: "/tmp/nohome" });
    expect(p.species).toBe("cat");
    expect({
      snark: p.snark,
      patience: p.patience,
      rigor: p.rigor,
      chattiness: p.chattiness,
      curiosity: p.curiosity,
    }).toEqual(speciesDefaults("cat"));
    // Sanity: cat is NOT the old flat all-5 default.
    expect(p.snark).not.toBe(5);
  });

  test("a fresh slime via 'defaults' method is still all-5 (slime profile == old flat default)", async () => {
    const io = fakeIO(["", "slime", "", "defaults"]);
    const p = await runPersonalityWizard({ io, claudeHome: "/tmp/nohome" });
    expect(p.species).toBe("slime");
    expect({
      snark: p.snark,
      patience: p.patience,
      rigor: p.rigor,
      chattiness: p.chattiness,
      curiosity: p.curiosity,
    }).toEqual({ snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 });
  });

  test("existing config's saved dials are preserved through the manual path (base-init d.x ?? prof.x)", async () => {
    // name Enter (keep existing), species Enter (keep "cat"), language Enter,
    // method=manual, then Enter through all 5 dial prompts to keep the
    // base-init values (which must come from `d`, not the species profile,
    // since `d` supplies every dial here).
    const io = fakeIO(["", "", "", "manual", "", "", "", "", ""]);
    const p = await runPersonalityWizard({
      io,
      claudeHome: "/tmp/nohome",
      defaults: {
        name: "Mochi",
        species: "cat",
        snark: 0,
        patience: 10,
        rigor: 0,
        chattiness: 0,
        curiosity: 0,
      },
    });
    expect(p.species).toBe("cat");
    expect(p.snark).toBe(0);
    expect(p.patience).toBe(10);
    expect(p.rigor).toBe(0);
    expect(p.chattiness).toBe(0);
    expect(p.curiosity).toBe(0);
  });

  test("the 'defaults' method re-seeds from the species profile even over an existing config (explicit user re-roll choice)", async () => {
    const io = fakeIO(["", "", "", "defaults"]);
    const p = await runPersonalityWizard({
      io,
      claudeHome: "/tmp/nohome",
      defaults: {
        name: "Mochi",
        species: "cat",
        snark: 0,
        patience: 10,
        rigor: 0,
        chattiness: 0,
        curiosity: 0,
      },
    });
    expect(p.species).toBe("cat");
    expect({
      snark: p.snark,
      patience: p.patience,
      rigor: p.rigor,
      chattiness: p.chattiness,
      curiosity: p.curiosity,
    }).toEqual(speciesDefaults("cat"));
  });
});
