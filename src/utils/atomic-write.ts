// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, basename, join } from "node:path";

export function atomicWrite(
  path: string,
  data: string | Buffer,
  opts?: { mode?: number },
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${basename(path)}-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
  renameSync(tmp, path);
}
