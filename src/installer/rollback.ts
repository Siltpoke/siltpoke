// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
export interface Compensation { label: string; undo: () => void | Promise<void> }

export class RollbackStack {
  private stack: Compensation[] = [];
  push(c: Compensation): void { this.stack.push(c); }
  async unwind(): Promise<string[]> {
    const unwound: string[] = [];
    while (this.stack.length) {
      const c = this.stack.pop()!;
      unwound.push(c.label);
      try { await c.undo(); } catch { /* record + continue; idempotent re-run recovers */ }
    }
    return unwound;
  }
}
