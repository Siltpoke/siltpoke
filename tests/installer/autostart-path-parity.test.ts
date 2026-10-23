// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] review (forward): receipt-sites builds the launch-agent unit path itself
// (the launchd / systemd defaults read the real home, until #909 / [66]). The two
// must name the same file under a home, or a rename in one place would make the
// receipt describe a file the installer never writes.
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { relative } from "node:path";
import { defaultPlistPath } from "../../src/installer/launchd";
import { autostartUnitPath } from "../../src/installer/receipt-sites";
import { defaultUnitPath } from "../../src/installer/systemd";

describe("receipt-sites unit paths equal what the installers write", () => {
  const home = "/sandbox/home";
  test("macOS plist", () => {
    expect(relative(home, autostartUnitPath("darwin", { HOME: home }) ?? "")).toBe(relative(homedir(), defaultPlistPath()));
  });
  test("Linux systemd unit", () => {
    expect(relative(home, autostartUnitPath("linux", { HOME: home }) ?? "")).toBe(relative(homedir(), defaultUnitPath(undefined, {})));
  });
  test("other platforms have no unit", () => {
    expect(autostartUnitPath("win32", { HOME: home })).toBeNull();
  });
});
