// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const script = readFileSync(join(import.meta.dir, "../../install/bootstrap.ps1"), "utf8");
describe("bootstrap.ps1 guards", () => {
  test("wraps body in a Main function invoked only at EOF", () => {
    expect(script).toMatch(/function\s+Main\s*\{/);
    expect(script.trimEnd().endsWith("Main @args")).toBe(true);
  });
  test("forces TLS 1.2 before any download", () => {
    expect(script).toMatch(/Tls12/);
  });
  test("never git clones", () => { expect(script).not.toMatch(/git\s+clone/); });
  test("invokes the bun wizard", () => { expect(script).toMatch(/bun\s+.*src[\\/]cli[\\/]bootstrap\.ts/); });
  test("points at the real public repo, not the OWNER placeholder", () => {
    expect(script).toContain("Siltpoke/siltpoke");
    expect(script).not.toContain("OWNER/siltpoke-dist");
  });
  test("verifies SHA-256 via Get-FileHash and throws on mismatch", () => {
    expect(script).toMatch(/Get-FileHash/);
    expect(script).toMatch(/SHA256/);
    expect(script).toMatch(/SILTPOKE_TARBALL_SHA256/);
    expect(script).toMatch(/checksum mismatch/i);
  });
});
