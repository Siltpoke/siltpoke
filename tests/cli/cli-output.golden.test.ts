/**
 * cli-output.golden — characterization snapshots for the two CLI
 * output surfaces that drive the most user-visible JSON / text:
 *   - runStats() — feeds `siltpoke stats`
 *   - runCard()  — feeds card rendering across multiple CLIs
 *
 * The original plan called for `--help` text snapshots, but the
 * current CLIs don't expose --help — most simply treat `--help` as a
 * positional arg. Pinning runStats / runCard JSON output is the closest
 * deterministic safety net: it catches regressions in the formatters
 * that survive the upcoming report.ts / Critic.tsx splits.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runStats } from "../../src/cli/stats";
import { runCard } from "../../src/cli/card";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const CAPTURE = process.env.R1_GOLDEN_MODE === "capture";
const FROZEN_NOW = new Date("2026-05-14T12:00:00Z");

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-cli-golden-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedConfig(): void {
  writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({
      name: "Mochi",
      species: "slime",
      snark: 5,
      patience: 5,
      rigor: 5,
      chattiness: 5,
      curiosity: 5,
      language: "en",
    }),
  );
  writeFileSync(
    join(homeBase, "progression.json"),
    JSON.stringify({
      level: 1,
      xp: 0,
      xp_to_next_level: 100,
      unlocked_titles: [],
      unlocked_poses: [],
      pet_log: [],
    }),
  );
}

function diffOrCapture(content: string, fixtureName: string): void {
  const fixturePath = join(FIXTURE_DIR, fixtureName);
  if (CAPTURE || !existsSync(fixturePath)) {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, content, "utf8");
    expect(content).toBe(content);
    return;
  }
  const expected = readFileSync(fixturePath, "utf8");
  if (content !== expected) {
    throw new Error(
      `${fixtureName} mismatch.\n` +
        `Fixture: ${fixturePath}\n` +
        `Re-capture with: R1_GOLDEN_MODE=capture bun test tests/cli/cli-output.golden.test.ts`,
    );
  }
  expect(content).toBe(expected);
}

test("golden: runStats() empty-state output is stable", async () => {
  seedConfig();
  const result = await runStats({ homeBase, now: () => FROZEN_NOW });
  diffOrCapture(JSON.stringify(result, null, 2), "stats-empty.json");
});

test("golden: runCard() empty-state output is stable", async () => {
  seedConfig();
  const result = await runCard({ homeBase, now: () => FROZEN_NOW });
  diffOrCapture(JSON.stringify(result, null, 2), "card-empty.json");
});
