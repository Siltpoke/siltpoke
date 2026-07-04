// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { timingSafeEqual, randomUUID } from "node:crypto";

export function isAuthorized(
  expected: string,
  provided: string | undefined,
): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function generateSecret(): string {
  return (
    randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")
  );
}
