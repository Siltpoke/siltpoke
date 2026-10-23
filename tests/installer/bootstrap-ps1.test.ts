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
  // [61] P1.4 — textual only: there is no PowerShell here, so the behaviour of the
  // note (what the sh script's sibling test runs for real) is UNTESTED on Windows.
  describe("receipt note about bun (spec §2.3)", () => {
    const note = (state: string, byUs: boolean) =>
      `'{"id":"tool:bun","byUs":${byUs},"state":"${state}"}'`;
    test("writes the note next to the app dir, ASCII, in all three cases", () => {
      expect(script).toMatch(/\$BunNote\s*=\s*Join-Path \$Home_ "receipt-bootstrap\.json"/);
      expect(script).toContain(note("pending", true));
      expect(script).toContain(note("done", true));
      expect(script).toContain(note("done", false));
      for (const m of script.match(/Set-Content -Path \$BunNote[^\n]*/g) ?? []) expect(m).toContain("-Encoding ascii");
    });
    test("pending is written BEFORE the bun installer, done only after it", () => {
      const pending = script.indexOf(note("pending", true));
      const install = script.indexOf("irm https://bun.sh/install.ps1 | iex");
      const done = script.indexOf(note("done", true));
      expect(pending).toBeGreaterThan(-1);
      expect(pending).toBeLessThan(install);
      expect(install).toBeLessThan(done);
    });
    test("an existing note is not overwritten when bun is already present", () => {
      expect(script).toMatch(/elseif \(-not \(Test-Path \$BunNote\)\)/);
    });
  });
  // [63] P1.6 — textual only, UNTESTED on Windows (how Read-Host behaves under `irm | iex`).
  describe("asks before installing Bun", () => {
    test("asks with Read-Host, only on an interactive console, default yes", () => {
      expect(script).toMatch(/Read-Host "[^"]*Install it now\? \[Y\/n\]"/);
      expect(script).toMatch(/UserInteractive -and -not \[Console\]::IsInputRedirected/);
      expect(script).toMatch(/\$Answer -eq ""/);
    });
    test("--yes or $env:SILTPOKE_YES=1 counts; with no console and neither it stops with the manual command", () => {
      expect(script).toMatch(/\$args -contains "--yes"/);
      expect(script).toMatch(/\$env:SILTPOKE_YES -eq "1"/);
      expect(script).toMatch(/throw "siltpoke: Bun is required[^"]*irm bun\.sh\/install\.ps1/);
    });
    test("the advice works under `irm | iex`, where no argument can be passed (review M6)", () => {
      const msg = script.match(/throw "siltpoke: Bun is required[^"]*"/)?.[0] ?? "";
      expect(msg).toContain("SILTPOKE_YES");
      expect(msg).not.toContain("--yes");
    });
    test("the question comes before the pending note and the installer", () => {
      const ask = script.indexOf("Read-Host");
      const pending = script.indexOf('"state":"pending"');
      const install = script.indexOf("irm https://bun.sh/install.ps1 | iex");
      expect(ask).toBeGreaterThan(-1);
      expect(ask).toBeLessThan(pending);
      expect(pending).toBeLessThan(install);
    });
  });
  test("verifies SHA-256 via Get-FileHash and throws on mismatch", () => {
    expect(script).toMatch(/Get-FileHash/);
    expect(script).toMatch(/SHA256/);
    expect(script).toMatch(/SILTPOKE_TARBALL_SHA256/);
    expect(script).toMatch(/checksum mismatch/i);
  });
});
