// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { markerDir } from "../../src/hooks/on-stop";

describe("marker dir honors SILTPOKE_HOME", () => {
  it("roots markers under SILTPOKE_HOME when set", () => {
    const env = { HOME: "/real/home", SILTPOKE_HOME: "/scratch/sp" } as unknown as NodeJS.ProcessEnv;
    expect(markerDir(env)).toBe("/scratch/sp/markers");
  });

  it("SILTPOKE_MARKER_DIR still wins when set", () => {
    const env = { HOME: "/real/home", SILTPOKE_HOME: "/scratch/sp", SILTPOKE_MARKER_DIR: "/custom/m" } as unknown as NodeJS.ProcessEnv;
    expect(markerDir(env)).toBe("/custom/m");
  });

  it("falls back to HOME/.siltpoke when neither is set", () => {
    const env = { HOME: "/real/home" } as unknown as NodeJS.ProcessEnv;
    expect(markerDir(env)).toBe("/real/home/.siltpoke/markers");
  });
});
