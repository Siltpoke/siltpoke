// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// agy `plugin install <repo>/.antigravity-plugin` copies ONLY that subdir —
// proven by the live spike (an internal design note,
// Approach A). So the wrapper (hooks/agy-stop.sh) + the FULL dist/ tree it needs
// MUST be duplicated inside .antigravity-plugin/ itself, or an agy-native install
// ships a manifest with nothing runnable.
//
// The dist/ must be the WHOLE tree, not just agy-stop.js: agy-stop.js is a thin
// dispatcher that spawns its sibling dist/siltpoke-stop.js (the on-stop review
// pipeline), which loads dist/index.js + tree-sitter wasm + system-prompt.md +
// a data file at runtime. An earlier version copied ONLY agy-stop.js, so the
// plugin installed and the Stop hook fired but the detached on-stop spawn had no
// target and reviewed NOTHING (silent no-op). These copies are build-generated +
// gitignored — this test guards that `bun run build:dist` produces the full set.
const ROOT = process.cwd();

describe(".antigravity-plugin/ is self-contained after a build", () => {
  test("hooks/agy-stop.sh is copied in", () => {
    const p = join(ROOT, ".antigravity-plugin", "hooks", "agy-stop.sh");
    expect(existsSync(p)).toBe(true);
  });

  test("dist/agy-stop.js (the dispatcher) is copied in", () => {
    const p = join(ROOT, ".antigravity-plugin", "dist", "agy-stop.js");
    expect(existsSync(p)).toBe(true);
  });

  test("dist/siltpoke-stop.js (the on-stop bundle agy-stop.js spawns) is copied in", () => {
    const p = join(ROOT, ".antigravity-plugin", "dist", "siltpoke-stop.js");
    expect(existsSync(p)).toBe(true);
  });

  test("dist/ runtime deps (wasm + system-prompt) are copied in", () => {
    expect(existsSync(join(ROOT, ".antigravity-plugin", "dist", "wasm"))).toBe(true);
    expect(existsSync(join(ROOT, ".antigravity-plugin", "dist", "system-prompt.md"))).toBe(true);
  });
});
