// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Keep a raw NUL character out of anything that becomes a reviewer's argv.
 *
 * The runtime refuses to spawn with a NUL in an argument
 * (`TypeError [ERR_INVALID_ARG_VALUE]: … must be a string without null bytes`),
 * and review prompts quote the user's own diff — so one source line holding a
 * literal NUL (measured 2026-09-29: `${caller}<NUL>${e.target}` in a removed
 * line) made the spawn impossible. Install audit §55.
 *
 * The stand-in is U+2400 SYMBOL FOR NULL, so the reviewer still sees that
 * something was there rather than two tokens silently glued together.
 */
const NUL = "\u0000";

export function nulSafe(text: string): string {
  return text.includes(NUL) ? text.replaceAll(NUL, "\u2400") : text;
}
