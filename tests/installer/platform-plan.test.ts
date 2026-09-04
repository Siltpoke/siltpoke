// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, test, expect } from "bun:test";
import { buildInstallPlan } from "../../src/installer/platform-plan";
import type { PrereqStatus } from "../../src/installer/prereq";

const absent = (name: PrereqStatus["name"]): PrereqStatus => ({ name, present: false, version: null });

describe("buildInstallPlan", () => {
  test("darwin: git line references Xcode CLT", () => {
    const plan = buildInstallPlan([absent("git")], "darwin");
    expect(plan.join("\n")).toContain("git (Xcode Command Line Tools)");
  });
  test("win32: git line references winget", () => {
    const plan = buildInstallPlan([absent("git")], "win32");
    expect(plan.join("\n")).toContain("git (winget)");
  });
  test("always ends with backup + core install lines", () => {
    const plan = buildInstallPlan([], "darwin");
    expect(plan).toContain("back up + wire ~/.claude/settings.json");
    expect(plan).toContain("install siltpoke core (runInstall)");
  });
});
