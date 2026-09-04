// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

// Only paths.ts may resolve HOME to build the .siltpoke root.
const ALLOWLIST = new Set(["src/installer/paths.ts"]);
const HOME_PRIMITIVE = /homedir\(\)|process\.env\.HOME/;
// .siltpoke as a real path segment: quoted string arg to join(), or a
// slash-prefixed segment in a template. Excludes dotted identifiers like
// the "io.siltpoke.daemon.plist" launchd label filename.
const SILTPOKE_SEGMENT = /["']\.siltpoke["']|\/\.siltpoke/;

// Second pass: local-var data-flow shape — `const home = homedir();` (or
// process.env.HOME) on one line, then `join(home, ".siltpoke", ...)` (or a
// `${home}/.siltpoke` template) on ANY later line of the same file. This
// catches the two-line shape the single-line pass above cannot see (e.g.
// Home.data.ts's `const home = homedir();` / `join(home, ".siltpoke", ...)`
// pair before the fix that routed it through siltpokeRoot()).
const HOME_VAR_ASSIGN = /(?:const|let|var)\s+(\w+)\s*=\s*(?:os\.)?homedir\(\)/;
const HOME_ENV_ASSIGN = /(?:const|let|var)\s+(\w+)\s*=\s*process\.env\.HOME\b/;

function findHomeVarNames(source: string): string[] {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const m1 = HOME_VAR_ASSIGN.exec(line);
    if (m1) names.push(m1[1]);
    const m2 = HOME_ENV_ASSIGN.exec(line);
    if (m2) names.push(m2[1]);
  }
  return names;
}

function varJoinsSiltpoke(source: string, varName: string): boolean {
  const joinRe = new RegExp(`join\\(\\s*${varName}\\s*,\\s*["']\\.siltpoke["']`);
  const templateRe = new RegExp("`\\$\\{" + varName + "\\}/\\.siltpoke");
  return joinRe.test(source) || templateRe.test(source);
}

describe("single .siltpoke resolver", () => {
  it("no file outside paths.ts builds .siltpoke from a home primitive", () => {
    const offenders: string[] = [];
    const glob = new Glob("src/**/*.ts");
    for (const file of glob.scanSync(".")) {
      if (ALLOWLIST.has(file)) continue;
      // Eval fixtures under src/eval/moat/ carry the anti-pattern as intentional
      // DATA (moat `violatingDiff` string literals), not as real resolvers — the
      // siltpoke-home-resolver fixture deliberately shows `join(homedir(),
      // ".siltpoke", …)` so a memory rule can be tested against it. Not a real leak.
      if (file.startsWith("src/eval/moat/")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (HOME_PRIMITIVE.test(line) && SILTPOKE_SEGMENT.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("predicate catches the real offending shapes", () => {
    const bad = [
      `const p = join(homedir(), ".siltpoke", "x");`,
      `const p = join(process.env.HOME ?? "", ".siltpoke");`,
      "const p = `${homedir()}/.siltpoke/logs`;",
    ];
    for (const line of bad) {
      expect(HOME_PRIMITIVE.test(line) && SILTPOKE_SEGMENT.test(line)).toBe(true);
    }
    // and does NOT flag the launchd label filename shape:
    const ok = `join(homedir(), "Library", "LaunchAgents", "io.siltpoke.daemon.plist")`;
    expect(HOME_PRIMITIVE.test(ok) && SILTPOKE_SEGMENT.test(ok)).toBe(false);
  });

  // KNOWN LIMITATION (honesty, no silent cap): this pass covers single-line
  // and local-var-data-flow (assign-then-join, possibly across lines) home→
  // .siltpoke shapes. It does NOT statically catch a home value threaded
  // through a FUNCTION PARAMETER and joined with .siltpoke inside a callee
  // (e.g. `function f(home: string) { return join(home, ".siltpoke"); }`
  // called with a home primitive at the call site) — that shape is rare, and
  // the two known production instances of it (Home.data.ts, configure.ts)
  // are routed through siltpokeRoot() rather than resolved locally.
  it("no file outside paths.ts assigns a home primitive to a local var then joins it with .siltpoke", () => {
    const offenders: string[] = [];
    const glob = new Glob("src/**/*.ts");
    for (const file of glob.scanSync(".")) {
      if (ALLOWLIST.has(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const varName of findHomeVarNames(source)) {
        if (varJoinsSiltpoke(source, varName)) {
          offenders.push(`${file}: local var "${varName}" from a home primitive is joined with .siltpoke`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("two-line data-flow pass catches the real offending shape and skips a cwd builder", () => {
    const bad = "const home = homedir();\nconst p = join(home, \".siltpoke\", \"x\");";
    const badVars = findHomeVarNames(bad);
    expect(badVars).toEqual(["home"]);
    expect(varJoinsSiltpoke(bad, "home")).toBe(true);

    const ok = "const cwd = process.cwd();\nconst p = join(cwd, \".siltpoke\");";
    const okVars = findHomeVarNames(ok);
    expect(okVars).toEqual([]);
  });
});
