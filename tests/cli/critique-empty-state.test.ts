// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * "You have no reviews yet" and "that id does not exist" are different facts.
 *
 * WHY — audit defect `[5c]`
 * (an internal design note). A brand-new user's
 * very first `/siltpoke-last` answered
 *
 *   # Siltpoke: review 'latest' not found.
 *
 * which reads like a failure — a missing file, a broken install — when the
 * truth is simply that nothing has been reviewed yet. The same string also
 * served the genuinely-wrong-id case, so neither could say anything useful.
 *
 * Both `getCritique` and `markForwarded` produced it, so both are covered here:
 * fixing one instance does not immunise the family.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasNoCritiquesAtAll } from "../../src/cli/critique-absent";
import { getCritique } from "../../src/cli/get-critique";
import { markForwarded } from "../../src/cli/mark-forwarded";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-empty-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedOne(): void {
  mkdirSync(join(tmp, "critiques"), { recursive: true });
  writeFileSync(
    join(tmp, "critiques", "latest.md"),
    "---\nstatus: pending\n---\n\n# [SILTPOKE CRITIQUE]\nbody\n",
  );
}

describe("a new user with no reviews yet", () => {
  test("is told there are none yet, not that something was not found", async () => {
    const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
    expect(out).toMatch(/no reviews yet/i);
    expect(out).not.toMatch(/not found/i);
  });

  test("is told WHEN one will appear, so the silence is explainable", async () => {
    const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
    // The one thing a new user actually needs: what makes a review happen.
    expect(out.toLowerCase()).toContain("code");
  });

  test("`mark-forwarded` says the same thing — the family, not one instance", async () => {
    const out = await markForwarded({ basePath: tmp, idOrLatest: "latest", homeBase: tmp });
    expect(out).toMatch(/no reviews yet/i);
    expect(out).not.toMatch(/not found/i);
  });
});

describe("a genuinely wrong id", () => {
  test("names the id, and says the store is NOT empty", async () => {
    seedOne();
    const out = await getCritique({ basePath: tmp, idOrLatest: "c-zzzz" });
    expect(out).toContain("c-zzzz");
    expect(out).toMatch(/does have reviews/i);
    // The distinguishing assertion: this must NOT read as a fresh install.
    expect(out).not.toMatch(/no reviews yet/i);
  });

  test("`mark-forwarded` likewise", async () => {
    seedOne();
    const out = await markForwarded({ basePath: tmp, idOrLatest: "c-zzzz", homeBase: tmp });
    expect(out).toContain("c-zzzz");
    expect(out).toMatch(/does have reviews/i);
    expect(out).not.toMatch(/no reviews yet/i);
  });

  test("a wrong id with NO reviews at all reads as 'none yet', not as a typo", async () => {
    // Which fact matters more to a new user: there is nothing here at all.
    const out = await getCritique({ basePath: tmp, idOrLatest: "c-zzzz" });
    expect(out).toMatch(/no reviews yet/i);
  });
});

describe("the happy path is untouched", () => {
  test("an existing review still comes back whole", async () => {
    seedOne();
    const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
    expect(out).toContain("body");
    expect(out).not.toMatch(/no reviews yet/i);
    expect(out).not.toMatch(/not found/i);
  });
});

describe("an unreadable archive directory must not hide real reviews", () => {
  test("one bad date dir does not turn into 'you have no reviews'", async () => {
    // A single try/catch around the whole walk returned `true` — "no reviews at
    // all" — the moment ANY date dir threw, even with a real critique sitting in
    // another one. Reproduced before the fix; this pins it.
    const arch = join(tmp, "critiques", "archive");
    mkdirSync(join(arch, "2026-01-01"), { recursive: true });
    mkdirSync(join(arch, "2026-09-18"), { recursive: true });

    // `readdir` order is NOT sorted and is not ours to choose, so the bad dir is
    // picked as whichever one comes back FIRST — otherwise this test would pass
    // or fail by luck of the filesystem.
    const order = readdirSync(arch);
    const [first, second] = order;
    expect(order.length).toBe(2);
    writeFileSync(join(arch, second!, "c-real.md"), "a real review");
    chmodSync(join(arch, first!), 0o000);
    try {
      expect(await hasNoCritiquesAtAll(tmp)).toBe(false);
      const out = await getCritique({ basePath: tmp, idOrLatest: "c-zzzz" });
      expect(out).not.toMatch(/no reviews yet/i);
    } finally {
      chmodSync(join(arch, first!), 0o755);
    }
  });

  test("the block is real (device check)", async () => {
    // Without this, the test above could pass because chmod did nothing.
    const d = join(tmp, "blocked");
    mkdirSync(d, { recursive: true });
    chmodSync(d, 0o000);
    try {
      expect(() => readdirSync(d)).toThrow();
    } finally {
      chmodSync(d, 0o755);
    }
  });

  test("a genuinely empty archive still reads as empty (control)", async () => {
    mkdirSync(join(tmp, "critiques", "archive", "2026-09-18"), { recursive: true });
    expect(await hasNoCritiquesAtAll(tmp)).toBe(true);
  });

  test("an unreadable dir with nothing else still reads as empty, not as 'has reviews'", async () => {
    // The chosen tradeoff, pinned: a directory we could not read is not counted
    // as evidence in EITHER direction. Treating it as "has reviews" would show a
    // brand-new user the wrong-id message instead of "no reviews yet" — the very
    // thing `[5c]` exists to fix. Without this assertion, swapping the skip for
    // `return false` passes the whole suite.
    const arch = join(tmp, "critiques", "archive");
    mkdirSync(join(arch, "2026-01-01"), { recursive: true });
    chmodSync(join(arch, "2026-01-01"), 0o000);
    try {
      expect(await hasNoCritiquesAtAll(tmp)).toBe(true);
      const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
      expect(out).toMatch(/no reviews yet/i);
    } finally {
      chmodSync(join(arch, "2026-01-01"), 0o755);
    }
  });
});

describe("reviews exist but the `latest` pointer is gone", () => {
  function seedArchiveOnly(): void {
    const d = join(tmp, "critiques", "archive", "2026-09-18");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "c-abcd.md"), "---\nstatus: pending\n---\n\nbody\n");
  }

  test("is not told to re-run the command that just produced this message", async () => {
    // `src/state/critique.ts:406` treats writing `latest.md` as non-fatal, so
    // this state is reachable. `/siltpoke-last` always passes the sentinel
    // "latest", which the user never typed — telling them "that id is not one of
    // them, re-run with no argument" is a loop.
    seedArchiveOnly();
    const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
    expect(out).toMatch(/pointer is missing/i);
    expect(out).not.toMatch(/no reviews yet/i);
    expect(out).not.toMatch(/with no argument/i);
  });

  test("names where the reviews still are, and how to reach one", async () => {
    seedArchiveOnly();
    const out = await getCritique({ basePath: tmp, idOrLatest: "latest" });
    expect(out).toContain("archive");
    expect(out).toContain("/siltpoke-last <id>");
  });

  test("a real typed id in the same state still gets the id message (control)", async () => {
    seedArchiveOnly();
    const out = await getCritique({ basePath: tmp, idOrLatest: "c-typo" });
    expect(out).toContain("c-typo");
    expect(out).toMatch(/does have reviews/i);
    expect(out).not.toMatch(/pointer is missing/i);
  });
});
