// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The daemon port must be resolved from ONE place, by ONE name.
 *
 * WHY — measured, not hygiene (an internal design note
 * defect `[5b]`). Two surfaces read two different environment variables for the
 * same port: the CLI read `PORT` (`src/cli/daemon.ts`, `src/cli/daemon-restart.ts`)
 * while the Stop hook read `SILTPOKE_DAEMON_PORT` (`src/hooks/on-stop.ts`). Both
 * defaulted to 9876, so the split never fired at the default — but the moment a
 * user set either variable, the hook probed one port while the daemon listened on
 * another, and the hook's "is the daemon up?" probe silently answered about the
 * wrong port.
 *
 * The source-scan half covers files that do not exist yet, which a per-call-site
 * assertion cannot.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Glob } from "bun";
import { join, relative } from "node:path";
import { DEFAULT_DAEMON_PORT, resolveDaemonPort } from "../../src/daemon/port";

describe("resolveDaemonPort", () => {
  test("reads SILTPOKE_DAEMON_PORT", () => {
    expect(resolveDaemonPort({ SILTPOKE_DAEMON_PORT: "9999" })).toBe(9999);
  });

  test("still honours a legacy PORT so an existing setup keeps working", () => {
    expect(resolveDaemonPort({ PORT: "9999" })).toBe(9999);
  });

  test("SILTPOKE_DAEMON_PORT wins when both are set", () => {
    expect(resolveDaemonPort({ SILTPOKE_DAEMON_PORT: "9999", PORT: "8888" })).toBe(
      9999,
    );
  });

  test("falls back to the default when neither is set", () => {
    expect(resolveDaemonPort({})).toBe(DEFAULT_DAEMON_PORT);
    expect(DEFAULT_DAEMON_PORT).toBe(9876);
  });

  test("an empty value counts as unset, not as port 0", () => {
    expect(resolveDaemonPort({ PORT: "" })).toBe(DEFAULT_DAEMON_PORT);
    expect(resolveDaemonPort({ SILTPOKE_DAEMON_PORT: "" })).toBe(DEFAULT_DAEMON_PORT);
  });

  test("a value that is not a usable port falls back instead of becoming NaN", () => {
    // `Number("abc")` is NaN, and the old call sites handed that straight to
    // `Bun.serve`. Out-of-range numbers are the same class of garbage.
    for (const bad of ["abc", "-1", "0", "70000", "80.5"]) {
      expect(resolveDaemonPort({ SILTPOKE_DAEMON_PORT: bad })).toBe(
        DEFAULT_DAEMON_PORT,
      );
    }
  });
});

describe("no surface resolves the daemon port on its own", () => {
  const SRC_DIR = join(import.meta.dir, "..", "..", "src");
  const PORT_MODULE = join(SRC_DIR, "daemon", "port.ts");

  /**
   * Every way a file could READ a port environment variable.
   *
   * The rule is about reading, not about mentioning: `doctor-daemon-check.ts`
   * has a user-facing sentence that names `SILTPOKE_DAEMON_PORT` to tell the
   * user which variable to set, and that is copy, not a second reader. So each
   * name gets one pattern per ACCESS form — dot, bracket, destructure — rather
   * than a bare string match.
   *
   * The bracket and destructuring forms were missing until a reviewer pointed
   * out that `process.env["PORT"]` walked straight through the guard.
   *
   * Residual, stated rather than assumed: an indirect read
   * (`const N = "PORT"; process.env[N]`) is not matched. Nothing does that
   * today, and a pattern loose enough to catch it would flag ordinary code.
   */
  const accessForms = (name: string): ReadonlyArray<readonly [string, RegExp]> => [
    [`env.${name}`, new RegExp(`\\benv\\.${name}\\b`)],
    [`env["${name}"]`, new RegExp(`\\benv\\s*\\[\\s*["'\`]${name}["'\`]\\s*\\]`)],
  ];
  /** Patterns checked line by line, after comments are stripped. */
  const SINGLE_LINE: ReadonlyArray<readonly [string, RegExp]> = [
    ...accessForms("SILTPOKE_DAEMON_PORT"),
    ...accessForms("PORT"),
  ];
  /**
   * Destructuring, checked against the WHOLE file so a multi-line form cannot
   * hide between two lines. `g` so `matchAll` can report every occurrence.
   */
  const destructure = (name: string): readonly [string, RegExp] => [
    `const { ${name} } = …env`,
    new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*[\\w.]*\\benv\\b`, "g"),
  ];
  const MULTI_LINE: ReadonlyArray<readonly [string, RegExp]> = [
    destructure("SILTPOKE_DAEMON_PORT"),
    destructure("PORT"),
  ];

  /** Strip `//` comments and jsdoc continuation lines — naming a variable in prose is not a second reader. */
  function stripComments(line: string): string {
    return line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
  }

  /**
   * Every offending `file:line` under `root`, excluding the one module allowed
   * to read these.
   *
   * `.tsx` is scanned too: `src/web/` holds 183 `.tsx` files, and a glob
   * limited to the `.ts` extension does not match one of them — so the
   * guard's promise did not cover that whole tree.
   *
   * `root` is a parameter so the positive control below can drive THIS
   * function — same glob, same patterns, same comment stripping — instead of
   * re-implementing it. That the real root is reachable and non-trivial is
   * asserted separately, so the two halves together cover what one
   * hardcoded-string control could not.
   */
  function scanFor(root: string, allowed: string): string[] {
    const offenders: string[] = [];
    for (const rel of new Glob("**/*.{ts,tsx}").scanSync(root)) {
      const abs = join(root, rel);
      if (abs === allowed) continue;
      const raw = readFileSync(abs, "utf8");
      const lines = raw.split("\n");
      const seen = new Set<number>();
      const flag = (lineIdx: number) => {
        if (seen.has(lineIdx)) return;
        seen.add(lineIdx);
        offenders.push(
          `${relative(root, abs)}:${lineIdx + 1}: ${(lines[lineIdx] ?? "").trim()}`,
        );
      };

      lines.forEach((line, i) => {
        const code = stripComments(line);
        if (SINGLE_LINE.some(([, re]) => re.test(code))) flag(i);
      });

      // A destructure can straddle lines, and this repo has biome's formatter
      // disabled, so nothing ever collapses one back. Scanning line by line let
      // `const {\n  SILTPOKE_DAEMON_PORT,\n} = process.env;` through the guard
      // whose entire job is to stop exactly that read from reappearing.
      for (const [, re] of MULTI_LINE) {
        for (const m of raw.matchAll(re)) {
          flag(raw.slice(0, m.index ?? 0).split("\n").length - 1);
        }
      }
    }
    return offenders;
  }

  test("only src/daemon/port.ts names the port environment variables", () => {
    expect(scanFor(SRC_DIR, PORT_MODULE)).toEqual([]);
  });

  test("the scan actually reaches files — and reaches .tsx too", () => {
    // Without this, `[]` above is indistinguishable from "scanned nothing".
    const files = [...new Glob("**/*.{ts,tsx}").scanSync(SRC_DIR)];
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => f.endsWith(".tsx")).length).toBeGreaterThan(0);
  });

  test("every access form is caught, and an innocent line is not", () => {
    const probeDir = mkdtempSync(join(tmpdir(), "siltpoke-port-guard-"));
    const violations: ReadonlyArray<readonly [string, string]> = [
      ["a.ts", 'const p = Number(env.SILTPOKE_DAEMON_PORT ?? "9876");'],
      ["b.ts", 'const p = process.env["SILTPOKE_DAEMON_PORT"];'],
      ["c.ts", "const p = process.env.PORT;"],
      ["d.ts", 'const p = process.env["PORT"];'],
      ["e.tsx", "const { PORT } = process.env;"],
      ["f.ts", "const { SILTPOKE_DAEMON_PORT } = process.env;"],
      // Straddles three lines — invisible to a line-by-line scan, which is
      // what this guard was until a round-2 reviewer reproduced it.
      ["g.ts", "const {\n  SILTPOKE_DAEMON_PORT,\n} = process.env;"],
      ["h.tsx", "const {\n  PORT,\n} = process.env;"],
    ];
    const innocent: ReadonlyArray<readonly [string, string]> = [
      ["ok-default.ts", "const p = DEFAULT_DAEMON_PORT;"],
      ["ok-comment.ts", "// reads SILTPOKE_DAEMON_PORT, historically"],
      ["ok-other.ts", "const p = opts.port ?? 9876;"],
      // Copy that TELLS the user which variable to set is not a reader. This
      // exact sentence lives in `doctor-daemon-check.ts` and the guard used to
      // flag it.
      ["ok-copy.ts", 'const msg = "…or set SILTPOKE_DAEMON_PORT to another one";'],
      // A destructure of something else entirely must not be swept up by the
      // whole-file pass.
      ["ok-destructure.ts", "const {\n  hostname,\n} = opts;"],
    ];
    try {
      for (const [name, body] of [...violations, ...innocent]) {
        writeFileSync(join(probeDir, name), `${body}\n`);
      }
      const caught = scanFor(probeDir, join(probeDir, "__none__"));
      for (const [name] of violations) {
        expect(caught.some((o) => o.startsWith(`${name}:`))).toBe(true);
      }
      for (const [name] of innocent) {
        expect(caught.some((o) => o.startsWith(`${name}:`))).toBe(false);
      }
      // The excluded path really is excluded — otherwise the real scan's `[]`
      // could be an exclusion that swallows everything.
      expect(scanFor(probeDir, join(probeDir, "a.ts")).some((o) => o.startsWith("a.ts:"))).toBe(
        false,
      );
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
