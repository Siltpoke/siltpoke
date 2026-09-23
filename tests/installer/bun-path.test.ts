// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The delivery half of defects [20] / [21]. hooks/lib/resolve-bun.sh accepting a
// pointer file is worth nothing if nothing ever writes it: the ~/.bun/bin
// fallback would be carrying the whole fix, and a user with bun installed
// somewhere else (Homebrew, asdf, a custom prefix) would stay broken.
//
// So these tests are about the write, not the read: setup must record the
// absolute path, and it must record the bun that is actually running it.
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunPathPointerPath, recordBunPath, resolveBunPath } from "../../src/installer/bun-path";

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "siltpoke-bunpath-"));
}

describe("recordBunPath", () => {
  test("records the absolute path of the bun that is running setup", () => {
    const home = tmpHome();
    try {
      const written = recordBunPath(home);
      expect(written).toBe(bunPathPointerPath(home));
      // process.execPath under bun IS the bun binary — setup is a bun program,
      // so it never has to guess where bun lives.
      expect(readFileSync(written!, "utf8").trim()).toBe(process.execPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses to record a path that is not executable — a dead pointer is worse than none", () => {
    const home = tmpHome();
    try {
      // A dead pointer makes every consumer take the slow path (stat, fail,
      // fall through) forever while looking configured.
      expect(recordBunPath(home, join(home, "nope", "bun"))).toBeNull();
      expect(existsSync(bunPathPointerPath(home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveBunPath — the TS mirror of hooks/lib/resolve-bun.sh", () => {
  test("prefers the recorded pointer when PATH has no bun", () => {
    const home = tmpHome();
    try {
      recordBunPath(home);
      // pathLookup: () => null models the non-login shell Claude Code hands its
      // hooks — the whole premise of [20].
      expect(resolveBunPath(home, { pathLookup: () => null })).toBe(process.execPath);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("returns null when bun is genuinely unreachable", () => {
    const home = tmpHome();
    try {
      expect(resolveBunPath(home, { pathLookup: () => null })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ignores a pointer naming something that is not executable", () => {
    const home = tmpHome();
    try {
      mkdirSync(join(home, ".siltpoke"), { recursive: true });
      writeFileSync(bunPathPointerPath(home), `${join(home, "gone", "bun")}\n`);
      expect(resolveBunPath(home, { pathLookup: () => null })).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
