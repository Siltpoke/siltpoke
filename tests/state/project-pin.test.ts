// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectPin, writeProjectPin } from "../../src/state/project-pin";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-pin-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("project-pin", () => {
  test("returns null when no pin file exists", async () => {
    expect(await readProjectPin(home)).toBeNull();
  });

  test("round-trips a written pin", async () => {
    await writeProjectPin(home, "abcdef012345");
    expect(await readProjectPin(home)).toBe("abcdef012345");
  });

  test("returns null on malformed pin file (never throws)", async () => {
    writeFileSync(join(home, "active-project.json"), "{ not json");
    expect(await readProjectPin(home)).toBeNull();
  });

  test("rejects an invalid proj_hash shape on read", async () => {
    writeFileSync(
      join(home, "active-project.json"),
      JSON.stringify({ pinned_proj_hash: "NOTAHASH" }),
    );
    expect(await readProjectPin(home)).toBeNull();
  });

  test("write is a no-op for an invalid proj_hash shape", async () => {
    await writeProjectPin(home, "NOTAHASH");
    expect(await readProjectPin(home)).toBeNull();
  });
});
