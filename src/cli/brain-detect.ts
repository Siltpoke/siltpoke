// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `siltpoke brain detect` — which other reviewer CLIs are installed.
 *
 * `/siltpoke-setup` §8 reads this to decide whether to offer cross-family
 * review at all. Read-only: it never writes config. It checks presence on PATH
 * only, not login state — a login probe per family would be a spawn per family
 * at setup time, each with its own auth command.
 */
import { FAMILIES, type ProviderFamily } from "../brain/brain-config";
import { familyBinary } from "../brain/registry";

/** PATH lookup; returns the resolved path or null. */
export type WhichFn = (cmd: string) => string | null;

/** The non-claude families whose CLI is on PATH, in FAMILIES order. claude has
 * no binary (`familyBinary` → null), so it is never reported. */
export function detectInstalledReviewers(which: WhichFn = (cmd) => Bun.which(cmd)): ProviderFamily[] {
  return FAMILIES.filter((family) => {
    const bin = familyBinary(family);
    return bin !== null && which(bin) !== null;
  });
}

/** The one JSON line the CLI prints: `{"installed":[...]}`. */
export function formatDetect(which?: WhichFn): string {
  return JSON.stringify({ installed: detectInstalledReviewers(which) });
}
