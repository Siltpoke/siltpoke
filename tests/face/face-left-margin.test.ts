// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The pet block sits a few columns in from the left edge of the statusline.
// Two things about that margin are easy to break silently, so both are pinned:
//
// 1. It is made of U+2800, not spaces. The statusline renderer strips leading
//    whitespace (measured — see tests/face/indent-char.test.ts), so a margin
//    written with spaces is a margin of zero, and nothing errors.
// 2. Every row of the block gets it, including the label rows. A margin applied
//    to the art but not the labels leaves the name and level hanging left.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWrapper } from "../../src/face/wrapper.ts";

const BRAILLE_BLANK = "⠀";
/**
 * What every row of the block is indented by, for THIS fixture:
 * `FACE_LEFT_MARGIN` (4) plus the one column of centering padding the widest
 * row still carries at this art/label geometry.
 *
 * Deliberately hand-written rather than imported. Importing `FACE_LEFT_MARGIN`
 * would make the expectation move with the source, and a test that moves with
 * the thing it checks cannot detect drift in it. This number is the contract;
 * if the art or the label widths change, the centering term changes with them
 * and this constant is updated on purpose, with the reason visible in the diff.
 *
 * Exact, not a lower bound. A `>=` comparison let a shrink from 4 to 3 pass,
 * because the centering column absorbed it (second review, 2026-09-20).
 */
const EXPECTED_LEADING = 5;

let tempBase: string;
beforeEach(() => {
  tempBase = mkdtempSync(join(tmpdir(), "siltpoke-margin-"));
});
afterEach(() => {
  rmSync(tempBase, { recursive: true, force: true });
});

function leadingBlanks(line: string): number {
  let n = 0;
  while (line[n] === BRAILLE_BLANK) n += 1;
  return n;
}

describe("the pet block's left margin", () => {
  test("every row is indented by exactly the same amount, labels included", async () => {
    writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
    writeFileSync(
      join(tempBase, "config.json"),
      JSON.stringify({ species: "cat", name: "Bangbang" }),
    );

    const out = await runWrapper({ basePath: tempBase, termWidth: 200 });
    const rows = out.split("\n").filter((l) => l.trim().length > 0);
    expect(rows.length).toBeGreaterThan(1);
    // Every row, by exact count — reporting the whole vector so a failure says
    // WHICH row drifted and by how much, not just that one of them did.
    expect(rows.map(leadingBlanks)).toEqual(rows.map(() => EXPECTED_LEADING));
  });

  test("the name row carries the margin too — it is the one most likely to be left behind", async () => {
    writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
    writeFileSync(
      join(tempBase, "config.json"),
      JSON.stringify({ species: "cat", name: "Bangbang" }),
    );

    const out = await runWrapper({ basePath: tempBase, termWidth: 200 });
    const nameRow = out.split("\n").find((l) => l.includes("Bangbang"));
    expect(nameRow).toBeDefined();
    expect(leadingBlanks(nameRow ?? "")).toBe(EXPECTED_LEADING);
  });

  test("the margin is braille blanks, never spaces — a space margin is silently no margin", async () => {
    writeFileSync(join(tempBase, "inner.txt"), "echo 'x'");
    writeFileSync(
      join(tempBase, "config.json"),
      JSON.stringify({ species: "cat", name: "Bangbang" }),
    );

    const out = await runWrapper({ basePath: tempBase, termWidth: 200 });
    for (const row of out.split("\n").filter((l) => l.trim().length > 0)) {
      expect(row.startsWith(" ")).toBe(false);
    }
  });
});
