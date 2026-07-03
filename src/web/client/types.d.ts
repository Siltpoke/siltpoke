// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Ambient type augmentations for the client bundle.
 *
 * `window.Alpine` is the documented seam every island uses to register
 * itself on `alpine:init`. Declared once here so individual island modules
 * don't have to redeclare the namespace.
 */
import type { Alpine } from "alpinejs";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace globalThis {
    var Alpine: Alpine;
  }
}
