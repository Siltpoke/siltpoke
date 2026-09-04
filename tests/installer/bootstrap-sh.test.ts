// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const script = readFileSync(join(import.meta.dir, "../../install/bootstrap.sh"), "utf8");
describe("bootstrap.sh guards", () => {
  test("wraps body in a main function invoked only at EOF", () => {
    expect(script).toMatch(/__siltpoke_main\(\)\s*\{/);
    expect(script.trimEnd().endsWith('__siltpoke_main "$@"')).toBe(true);
  });
  test("forces TLS on every curl", () => {
    const curls = script.match(/curl [^\n|]*/g) ?? [];
    expect(curls.length).toBeGreaterThan(0);
    for (const c of curls) expect(c).toContain("--proto '=https' --tlsv1.2");
  });
  test("never git clones", () => { expect(script).not.toMatch(/git\s+clone/); });
  test("execs the bun wizard", () => { expect(script).toMatch(/exec\s+bun\s+.*src\/cli\/bootstrap\.ts/); });
  test("points at the real public repo, not the OWNER placeholder", () => {
    expect(script).toContain("Siltpoke/siltpoke");
    expect(script).not.toContain("OWNER/siltpoke-dist");
  });
  test("verifies a SHA-256 checksum and aborts on mismatch before extract", () => {
    expect(script).toMatch(/shasum -a 256|sha256sum/);
    expect(script).toMatch(/SILTPOKE_TARBALL_SHA256/);
    expect(script).toMatch(/checksum mismatch/i);
  });
});
