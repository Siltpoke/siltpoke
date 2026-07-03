import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildReport } from "../../src/cli/report";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const CAPTURE = process.env.R1_GOLDEN_MODE === "capture";
const FROZEN_NOW = new Date("2026-05-14T12:00:00Z");

const LANGS = ["en", "zh-CN", "ja", "ko"] as const;
type Lang = (typeof LANGS)[number];

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-report-golden-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedFixtureState(lang: Lang): void {
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
      language: lang,
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

for (const lang of LANGS) {
  test(`golden: report.ts output is stable for lang=${lang}`, async () => {
    seedFixtureState(lang);
    const outPath = join(homeBase, "report.html");
    await buildReport({ homeBase, outPath, now: () => FROZEN_NOW });
    const html = readFileSync(outPath, "utf8");

    const fixturePath = join(FIXTURE_DIR, `report-output-${lang}.html`);

    if (CAPTURE || !existsSync(fixturePath)) {
      mkdirSync(dirname(fixturePath), { recursive: true });
      writeFileSync(fixturePath, html, "utf8");
      // In capture mode we still assert byte-equality so the test
      // surfaces in the run output as passing.
      expect(html).toBe(html);
      return;
    }

    const expected = readFileSync(fixturePath, "utf8");
    if (html !== expected) {
      const expectedLen = expected.length;
      const actualLen = html.length;
      throw new Error(
        `report.golden mismatch for lang=${lang}.\n` +
          `Fixture: ${fixturePath}\n` +
          `Expected ${expectedLen} bytes, got ${actualLen} bytes.\n` +
          `Re-capture with: R1_GOLDEN_MODE=capture bun test tests/cli/report.golden.test.ts`,
      );
    }
    expect(html).toBe(expected);
  });
}
