// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Three implementations of "where is bun" now exist, on purpose:
//   1. hooks/lib/resolve-bun.sh      — sourced by the five hook guards
//   2. the inline snippet in src/installer/shim.ts — the statusline + daemon shims
//   3. resolveBunPath() in src/installer/bun-path.ts — what /siltpoke-doctor reads
//
// They are separate because each runs somewhere the others cannot reach (the
// shims live outside the plugin root and must work while it is mid-upgrade).
// Sharing the code was tried first and made a silent hole: the shim sourced the
// lib and, when the lib was not found, fell back to a PATH-only lookup that
// ignored the recorded pointer — losing the fix precisely when it mattered.
//
// So the invariant is enforced by measurement instead: all three must give the
// same answer for the same machine state. A test that only checked one would
// let the other two drift, which is the shape of defect [20] itself — a
// mechanism that looks wired and is not.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunPathPointerPath, recordBunPath, resolveBunPath } from "../../src/installer/bun-path";
import { renderDaemonShim, renderStatuslineShim } from "../../src/installer/shim";

/**
 * The bun-resolution block, sliced out of the SHIPPED statusline shim between
 * the sentinels it carries. Slicing beats importing the constant: the shim is
 * what actually runs on a user's machine, and this way the test cannot pass
 * against a snippet the shim no longer embeds.
 */
function snippetFrom(script: string): string {
  const start = script.indexOf("# >>> siltpoke bun-resolve");
  const end = script.indexOf("# <<< siltpoke bun-resolve");
  if (start < 0 || end < 0) throw new Error("bun-resolve sentinels missing from the shim");
  return script.slice(start, end);
}

const BUN_RESOLVE_SNIPPET = snippetFrom(renderStatuslineShim());

const REPO = process.cwd();
const REAL_BUN = process.execPath;
const PATH_WITHOUT_BUN = "/usr/bin:/bin:/usr/sbin:/sbin";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-parity-"));
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** What hooks/lib/resolve-bun.sh answers, run as the hooks actually run it. */
function askShellLib(): string | null {
  const r = Bun.spawnSync(
    ["/bin/sh", "-c", `. "${join(REPO, "hooks", "lib", "resolve-bun.sh")}"; siltpoke_resolve_bun`],
    { env: { HOME: home, PATH: PATH_WITHOUT_BUN } },
  );
  const out = new TextDecoder().decode(r.stdout).trim();
  return out.length > 0 ? out : null;
}

/**
 * What the shims' inline snippet answers.
 *
 * Runs BUN_RESOLVE_SNIPPET itself rather than slicing lines out of a rendered
 * shim. The first draft did slice, and it measured nothing: the statusline shim
 * exits early when ~/.siltpoke/plugin-root is absent (which it is, in this
 * fixture), so every case fell out before the resolution ran and the two
 * expect-null cases passed for the wrong reason. The `embeds` test below is
 * what ties this string to the shipped scripts.
 */
function askShimSnippet(): string | null {
  const r = Bun.spawnSync(["/bin/sh", "-c", `set -u\n${BUN_RESOLVE_SNIPPET}\nprintf '%s' "$BUN"`], {
    env: { HOME: home, PATH: PATH_WITHOUT_BUN },
  });
  const out = new TextDecoder().decode(r.stdout).trim();
  return out.length > 0 ? out : null;
}

/** What doctor reads, with PATH modelled the same way. */
function askTypescript(): string | null {
  return resolveBunPath(home, { pathLookup: () => null });
}

function allThree(): { lib: string | null; shim: string | null; ts: string | null } {
  return { lib: askShellLib(), shim: askShimSnippet(), ts: askTypescript() };
}

describe("all three bun resolvers agree", () => {
  test("both shims embed the snippet this suite measures", () => {
    // Non-empty first: an empty string is contained in everything, so without
    // this the next two assertions would pass against a snippet that never
    // resolved anything.
    expect(BUN_RESOLVE_SNIPPET.length).toBeGreaterThan(50);
    expect(renderStatuslineShim()).toContain(BUN_RESOLVE_SNIPPET);
    expect(renderDaemonShim()).toContain(BUN_RESOLVE_SNIPPET);
  });

  test("nothing available → all three say no", () => {
    const { lib, shim, ts } = allThree();
    expect(lib).toBeNull();
    expect(shim).toBeNull();
    expect(ts).toBeNull();
  });

  test("recorded pointer → all three return it", () => {
    // Written through the PRODUCTION writer, so this also pins the coupling
    // that matters: recordBunPath() puts the file exactly where the shell lib
    // looks for it. (bun-path.ts deviates from the siltpokeRoot() convention
    // for precisely this reason; see its header.)
    expect(recordBunPath(home)).toBe(bunPathPointerPath(home));
    const { lib, shim, ts } = allThree();
    expect(lib).toBe(REAL_BUN);
    expect(shim).toBe(REAL_BUN);
    expect(ts).toBe(REAL_BUN);
  });

  test("no pointer, default install location → all three return it", () => {
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    const fallback = join(home, ".bun", "bin", "bun");
    symlinkSync(REAL_BUN, fallback);
    const { lib, shim, ts } = allThree();
    expect(lib).toBe(fallback);
    expect(shim).toBe(fallback);
    expect(ts).toBe(fallback);
  });

  test("a pointer naming something unexecutable is ignored by all three", () => {
    writeFileSync(bunPathPointerPath(home), `${join(home, "gone", "bun")}\n`);
    const { lib, shim, ts } = allThree();
    expect(lib).toBeNull();
    expect(shim).toBeNull();
    expect(ts).toBeNull();
  });

  test("a dead pointer does NOT shadow the default location", () => {
    writeFileSync(bunPathPointerPath(home), `${join(home, "gone", "bun")}\n`);
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    const fallback = join(home, ".bun", "bin", "bun");
    symlinkSync(REAL_BUN, fallback);
    const { lib, shim, ts } = allThree();
    expect(lib).toBe(fallback);
    expect(shim).toBe(fallback);
    expect(ts).toBe(fallback);
  });
});
