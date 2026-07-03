import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFirstRun } from "../../src/cli/first-run";
import type { WizardIO } from "../../src/installer/wizard";

let tmp: string;
let env: NodeJS.ProcessEnv;

function fakeIO(answers: string[]): WizardIO {
  let i = 0;
  return {
    async readLine() {
      return answers[i++] ?? "";
    },
    write(_s: string) {},
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-fr-"));
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  env = { HOME: tmp } as NodeJS.ProcessEnv;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("first-run: refuses when SILTPOKE_INTERNAL=1", async () => {
  const r = await runFirstRun({
    env: { ...env, SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv,
    io: fakeIO([]),
  });
  expect(r.status).toBe("internal_subprocess");
});

test("first-run: noninteractive writes config with defaults", async () => {
  const r = await runFirstRun({
    env,
    noninteractive: true,
    io: fakeIO([]),
  });
  expect(r.status).toBe("written");
  const cfg = JSON.parse(readFileSync(r.config_path, "utf8"));
  expect(cfg.name).toBe("Siltpoke");
  expect(cfg.species).toBe("slime");
  expect(cfg.language).toBe("en");
});

test("first-run: wizard answers flow through to config", async () => {
  const r = await runFirstRun({
    env,
    noninteractive: false,
    io: fakeIO(["Mochi", "cat", "zh-CN"]),
  });
  const cfg = JSON.parse(readFileSync(r.config_path, "utf8"));
  expect(cfg.name).toBe("Mochi");
  expect(cfg.species).toBe("cat");
  expect(cfg.language).toBe("zh-CN");
});

test("first-run: noninteractive fresh install seeds dials from the species profile (not flat 5)", async () => {
  // No existing config.json → existing is undefined → species falls back to
  // DEFAULT_SPECIES ("slime"), which IS the flat all-5 profile — this test
  // asserts the wiring reads from speciesDefaults(), not a hardcoded literal.
  const r = await runFirstRun({
    env,
    noninteractive: true,
    io: fakeIO([]),
  });
  const cfg = JSON.parse(readFileSync(r.config_path, "utf8"));
  expect(cfg.species).toBe("slime");
  expect(cfg.snark).toBe(5);
  expect(cfg.patience).toBe(5);
  expect(cfg.rigor).toBe(5);
  expect(cfg.chattiness).toBe(5);
  expect(cfg.curiosity).toBe(5);
});

test("first-run: noninteractive re-roll for an existing non-slime species preserves saved dials (not re-seeded)", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = join(tmp, ".siltpoke");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      name: "Bangbang",
      species: "cat",
      language: "en",
      snark: 3,
      patience: 3,
      rigor: 3,
      chattiness: 3,
      curiosity: 3,
    }),
  );
  const r = await runFirstRun({
    env,
    noninteractive: true,
    io: fakeIO([]),
  });
  const cfg = JSON.parse(readFileSync(r.config_path, "utf8"));
  expect(cfg.species).toBe("cat");
  // Existing saved dials win over the species profile (cat profile has
  // snark=8, patience=2, etc. — none of which is 3).
  expect(cfg.snark).toBe(3);
  expect(cfg.patience).toBe(3);
  expect(cfg.rigor).toBe(3);
  expect(cfg.chattiness).toBe(3);
  expect(cfg.curiosity).toBe(3);
});

test("first-run: noninteractive with an existing species but no saved dials fills from that species' profile (not flat 5)", async () => {
  // Existing config records species=cat via a prior interactive run but,
  // hypothetically, is missing dial fields (e.g. partial/legacy config) —
  // the noninteractive fill-in must use speciesDefaults("cat"), not a
  // hardcoded 5, since species is now known.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const home = join(tmp, ".siltpoke");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      schemaVersion: 2,
      name: "Bangbang",
      species: "cat",
      language: "en",
    }),
  );
  const r = await runFirstRun({
    env,
    noninteractive: true,
    io: fakeIO([]),
  });
  const cfg = JSON.parse(readFileSync(r.config_path, "utf8"));
  expect(cfg.species).toBe("cat");
  expect(cfg.snark).toBe(8);
  expect(cfg.patience).toBe(2);
  expect(cfg.rigor).toBe(4);
  expect(cfg.chattiness).toBe(5);
  expect(cfg.curiosity).toBe(7);
});
