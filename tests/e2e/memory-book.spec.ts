/**
 * Memory Book E2E — 记忆之书 redesign smoke.
 *
 * Verifies the redesigned /memory screen renders real data (no mock, no seed
 * fabrication) and the Alpine island hydrates + behaves:
 *   - `.memory-book` container with `x-data="memoryBook"` + hydrated `memories`
 *   - date-grouped timeline rows have time / text / type-pill / status badge
 *   - alpine memories count == rendered `.memory-row` count
 *   - view toggle (时间流 / 按类型) → 4 type cards (语义/情景/程序/工作)
 *   - clicking a type card opens the modal
 *   - filtering to 程序/procedural → honest empty state (no fake rows)
 *   - sort toggle flips direction
 *   - NL composer: 忘掉 <existing fact> → actionable proposal → ✓确认 →
 *     fact status becomes "retired" in Alpine state (soft delete, row stays)
 *   - 撤回退休 button on a retired row reactivates it (retired → active)
 *   - working-memory rail is display-only and sits outside the timeline
 *
 * Note: the seed (tests/e2e/_setup/seed-repo-graph.ts) plants TWO active
 * semantic facts ("User prefers dark mode" / "User prefers tabs over spaces")
 * + one chat session — the retire and reactivate tests each need their own
 * non-retired target. An otherwise-empty timeline is also valid and must not
 * crash.
 */
import { expect, test } from "@playwright/test";

// Pin the browser's timezone to UTC so that formatted date/time assertions
// (e.g. "04:30", "04:20" from seeded UTC timestamps) are machine-TZ-independent.
test.use({ timezoneId: "UTC" });

async function waitHydrated(page: import("@playwright/test").Page) {
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: unknown[] }> })
        | null;
      return Array.isArray(el?._x_dataStack?.[0]?.memories);
    },
    { timeout: 10_000 },
  );
}

test("memory book: timeline renders and island hydrates", async ({ page }) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");

  const root = page.locator('[x-data="memoryBook"]');
  await expect(root).toBeVisible();
  await waitHydrated(page);

  const timeline = page.locator(".memory-timeline");
  await expect(timeline).toBeVisible();

  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText).not.toContain("undefined");

  const rows = page.locator(".memory-row");
  const rowCount = await rows.count();

  if (rowCount > 0) {
    const firstRow = rows.first();
    await expect(firstRow.locator(".memory-row-time")).toBeAttached();
    await expect(firstRow.locator(".memory-row-text")).toBeVisible();
    await expect(firstRow.locator(".memory-row-type")).toBeVisible();
    await expect(firstRow.locator(".memory-row-status")).toBeVisible();
    await expect(firstRow.locator(".memory-row-why")).toBeAttached();

    const typeText = await firstRow.locator(".memory-row-type").textContent();
    expect(["Semantic", "Episodic", "Procedural"]).toContain(typeText?.trim());

    const statusText = await firstRow
      .locator(".memory-row-status")
      .textContent();
    expect(["Active", "Pending", "Retired"]).toContain(statusText?.trim());
  } else {
    await expect(timeline).toContainText("no memories yet");
  }
});

test("memory book: memories array in Alpine state matches rendered row count", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  const alpineCount = await page.evaluate(() => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: unknown[] }> })
      | null;
    return el?._x_dataStack?.[0]?.memories?.length ?? 0;
  });

  const domRowCount = await page.locator(".memory-row").count();
  expect(alpineCount).toBe(domRowCount);
});

test("memory book: view toggle shows 4 type cards", async ({ page }) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  await expect(page.locator(".memory-timeline")).toBeVisible();

  await page.locator(".memory-view-btn").filter({ hasText: "By type" }).click();

  const cards = page.locator(".memory-type-card");
  await expect(cards).toHaveCount(4);
  await expect(cards.filter({ hasText: /Semantic/ })).toBeVisible();
  await expect(cards.filter({ hasText: /Episodic/ })).toBeVisible();
  await expect(cards.filter({ hasText: /Procedural/ })).toBeVisible();
  await expect(cards.filter({ hasText: /Working/ })).toBeVisible();

  await page.locator(".memory-view-btn").filter({ hasText: "Timeline" }).click();
  await expect(page.locator(".memory-timeline")).toBeVisible();
});

test("memory book: clicking a type card opens the modal", async ({ page }) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  await page.locator(".memory-view-btn").filter({ hasText: "By type" }).click();
  await page.locator(".memory-type-card-semantic").click();

  const modal = page.locator(".memory-modal");
  await expect(modal).toBeVisible();
  await expect(page.locator(".memory-modal-title")).toContainText("Semantic");

  await page.locator(".memory-modal button").filter({ hasText: "×" }).click();
  await expect(modal).not.toBeVisible();
});

test("memory book: filtering to 程序/procedural shows honest empty state", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  await page.locator(".memory-filter-chip").filter({ hasText: "Procedural" }).click();

  await page.waitForFunction(
    () => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ filterType?: string }> })
        | null;
      return el?._x_dataStack?.[0]?.filterType === "procedural";
    },
    { timeout: 5_000 },
  );

  const emptyState = page.locator(".memory-empty-state");
  await expect(emptyState).toBeVisible();
  const emptyText = await emptyState.textContent();
  expect(emptyText).toContain("notice you repeat");

  await expect(page.locator(".memory-row")).toHaveCount(0);
});

test("memory book: sort toggle flips sort direction", async ({ page }) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  const sortBtn = page.locator(".memory-sort-toggle");
  await expect(sortBtn).toContainText("Newest → Oldest");

  await sortBtn.click();
  await expect(sortBtn).toContainText("Oldest → Newest");

  const sortDesc = await page.evaluate(() => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ sortDesc?: boolean }> })
      | null;
    return el?._x_dataStack?.[0]?.sortDesc;
  });
  expect(sortDesc).toBe(false);
});

// ─── NL composer: 改记忆 (forget → proposal → ✓确认 → soft retire) ───────────

test("memory book: composer forget proposal + ✓确认 retires the fact (soft delete)", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  type MemoryItem = { id: string; type: string; status: string; text: string };
  const fact = await page.evaluate(() => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
    return (
      mems?.find((m) => m.type === "semantic" && m.status !== "retired") ?? null
    );
  });

  if (fact === null) {
    test.skip(true, "no retirable semantic fact seeded — re-run fresh server");
    return;
  }

  // Switch to by-type view (the composer is docked there).
  await page.locator(".memory-view-btn").filter({ hasText: "By type" }).click();

  // Type a forget intent that keyword-matches the seeded fact's text.
  // Use the last word of the fact text so the matcher hits exactly one fact.
  const lastWord = fact.text.trim().split(/\s+/).slice(-1)[0];
  await page.locator(".memory-composer-input").fill(`忘掉 ${lastWord}`);
  await page.locator(".memory-composer-send").click();

  // Actionable proposal card appears with a ✓确认 button.
  const confirmBtn = page.locator(".memory-proposal-confirm");
  await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
  await confirmBtn.click();

  // The fact's status flips to "retired" in Alpine state…
  await page.waitForFunction(
    (id: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
      return mems?.find((m) => m.id === id)?.status === "retired";
    },
    fact.id,
    { timeout: 8_000 },
  );

  // …and the row is still present (soft delete, not removed).
  const stillPresent = await page.evaluate((id: string) => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
    return mems?.some((m) => m.id === id) ?? false;
  }, fact.id);
  expect(stillPresent).toBe(true);

  // Confirmation toast surfaced.
  await expect(page.locator(".memory-toast")).toBeVisible();
});

test("memory book: 撤回退休 button reactivates a retired fact (retired → active)", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  type MemoryItem = { id: string; type: string; status: string; text: string };
  const fact = await page.evaluate(() => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
    return (
      mems?.find((m) => m.type === "semantic" && m.status !== "retired") ?? null
    );
  });
  if (fact === null) {
    test.skip(true, "no retirable semantic fact seeded — re-run fresh server");
    return;
  }

  // First retire it via the composer (so we have a retired row to reactivate).
  await page.locator(".memory-view-btn").filter({ hasText: "By type" }).click();
  const lastWord = fact.text.trim().split(/\s+/).slice(-1)[0];
  await page.locator(".memory-composer-input").fill(`忘掉 ${lastWord}`);
  await page.locator(".memory-composer-send").click();
  await page.locator(".memory-proposal-confirm").click();
  await page.waitForFunction(
    (id: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
      return mems?.find((m) => m.id === id)?.status === "retired";
    },
    fact.id,
    { timeout: 8_000 },
  );

  // Back to timeline; the retired row now shows a 撤回退休 button.
  await page.locator(".memory-view-btn").filter({ hasText: "Timeline" }).click();
  const reactivateBtn = page
    .locator(`[data-event-id="${fact.id}"] .memory-row-reactivate`)
    .first();
  await expect(reactivateBtn).toBeVisible({ timeout: 5_000 });
  await reactivateBtn.click();

  // Status flips back to active in Alpine state.
  await page.waitForFunction(
    (id: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
      return mems?.find((m) => m.id === id)?.status === "active";
    },
    fact.id,
    { timeout: 8_000 },
  );

  // Success toast surfaced (only user-visible feedback beyond the state flip).
  await expect(page.locator(".memory-toast")).toBeVisible();
});

// ─── 删除 button on active rows (soft-retire) + 撤回退休 round-trip ──────────

test("memory book: 删除 button soft-retires an active fact, 撤回退休 restores it", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  type MemoryItem = { id: string; status: string };
  const id = "fact-e2e-delete";

  // Anti-vacuous precondition: the seeded fact is ACTIVE before we click (so the
  // post-click "retired" assertion can't pass vacuously on an already-retired row).
  const before = await page.evaluate((factId: string) => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
    return mems?.find((m) => m.id === factId)?.status ?? null;
  }, id);
  expect(before).toBe("active");

  // The active row shows 🗑 删除 on the timeline (default view).
  const deleteBtn = page
    .locator(`[data-event-id="${id}"] .memory-row-delete`)
    .first();
  await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
  await deleteBtn.click();

  // Status flips to "retired" in Alpine state (soft delete — row stays).
  await page.waitForFunction(
    (factId: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
      return mems?.find((m) => m.id === factId)?.status === "retired";
    },
    id,
    { timeout: 8_000 },
  );

  // The row now exposes the 撤回退休 (reactivate) button instead of 删除.
  const reactivateBtn = page
    .locator(`[data-event-id="${id}"] .memory-row-reactivate`)
    .first();
  await expect(reactivateBtn).toBeVisible({ timeout: 5_000 });
  await reactivateBtn.click();

  // Clicking reactivate returns it to active.
  await page.waitForFunction(
    (factId: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
      return mems?.find((m) => m.id === factId)?.status === "active";
    },
    id,
    { timeout: 8_000 },
  );

  await expect(page.locator(".memory-toast")).toBeVisible();
});

// ─── pending-row vertical alignment regression guard ─────────────────────────
// Root cause fixed 2026-06-26: .memory-pending-actions had margin-top:8px in
// layout.tsx which shifted approve/reject 4px below the status badge in the
// 30px alignItems:center stack. Fix = remove margin-top from the CSS class.
// This guard asserts the delta stays ≤ 1px so prior regressions are caught.

test("memory book: status badge + approve/reject align within 1px on pending row", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  const id = "fact-e2e-pending-approve";
  const row = `[data-event-id="${id}"]`;

  const badgeBB = await page.locator(`${row} .memory-row-status`).first().boundingBox();
  const approveBB = await page.locator(`${row} .memory-row-approve`).first().boundingBox();
  const rejectBB = await page.locator(`${row} .memory-row-reject`).first().boundingBox();

  expect(badgeBB).not.toBeNull();
  expect(approveBB).not.toBeNull();
  expect(rejectBB).not.toBeNull();

  const badgeCY = badgeBB!.y + badgeBB!.height / 2;
  const approveCY = approveBB!.y + approveBB!.height / 2;
  const rejectCY = rejectBB!.y + rejectBB!.height / 2;

  expect(Math.abs(badgeCY - approveCY)).toBeLessThanOrEqual(1);
  expect(Math.abs(badgeCY - rejectCY)).toBeLessThanOrEqual(1);
});

// ─── pending-row 确认 / 拒绝 buttons ───────────────────────────────────────────

test("memory book: 确认 button approves a pending fact (pending → active)", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  type MemoryItem = { id: string; status: string };
  const id = "fact-e2e-pending-approve";

  // Precondition: the seeded fact is actually pending before we click (so the
  // post-click "active" assertion can't pass vacuously on an already-active row).
  const before = await page.evaluate((factId: string) => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
    return mems?.find((m) => m.id === factId)?.status ?? null;
  }, id);
  expect(before).toBe("pending");

  const approveBtn = page
    .locator(`[data-event-id="${id}"] .memory-row-approve`)
    .first();
  await expect(approveBtn).toBeVisible({ timeout: 5_000 });
  await approveBtn.click();

  await page.waitForFunction(
    (factId: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
      return mems?.find((m) => m.id === factId)?.status === "active";
    },
    id,
    { timeout: 8_000 },
  );

  await expect(page.locator(".memory-toast")).toBeVisible();
});

test("memory book: 拒绝 button rejects a pending fact (pending → retired)", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  type MemoryItem = { id: string; status: string };
  const id = "fact-e2e-pending-reject";

  const before = await page.evaluate((factId: string) => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
    return mems?.find((m) => m.id === factId)?.status ?? null;
  }, id);
  expect(before).toBe("pending");

  const rejectBtn = page
    .locator(`[data-event-id="${id}"] .memory-row-reject`)
    .first();
  await expect(rejectBtn).toBeVisible({ timeout: 5_000 });
  await rejectBtn.click();

  // Rejection is a soft-retire — status flips to "retired", row stays.
  await page.waitForFunction(
    (factId: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
      return mems?.find((m) => m.id === factId)?.status === "retired";
    },
    id,
    { timeout: 8_000 },
  );

  const stillPresent = await page.evaluate((factId: string) => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemoryItem[] }> })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories as MemoryItem[] | undefined;
    return mems?.some((m) => m.id === factId) ?? false;
  }, id);
  expect(stillPresent).toBe(true);

  await expect(page.locator(".memory-toast")).toBeVisible();
});

// ─── NL-edit composer (free text → /api/facts/parse → confirm → mutate) ─────
//
// /api/facts/parse is a PAID Brain call. Every test below FULFILLS that request
// with a FAKE JSON body via page.route — the real LLM is NEVER hit ($0). The
// downstream mutation routes (POST /api/facts, /restate) are deliberately NOT
// stubbed: they hit the real daemon so each test proves the end-to-end write.

type ServerFact = {
  id: string;
  status: string;
  text: string;
  supersedes: string | null;
  superseded_by: string | null;
};

/** Read the canonical fact store via the real GET /api/facts (full Fact shape,
 * incl. supersedes / superseded_by — fields the client alpine row drops). Proves
 * the mutation actually landed on the daemon, not just in optimistic UI state. */
async function getServerFacts(
  page: import("@playwright/test").Page,
): Promise<ServerFact[]> {
  return page.evaluate(async () => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ secret?: string }> })
      | null;
    const secret = el?._x_dataStack?.[0]?.secret ?? "";
    const r = await fetch("/api/facts", {
      headers: { "X-Siltpoke-Secret": secret },
    });
    const j = (await r.json()) as { facts: ServerFact[] };
    return j.facts;
  });
}

type AlpineMem = { id: string; type: string; status: string; text: string };
async function alpineMemories(
  page: import("@playwright/test").Page,
): Promise<AlpineMem[]> {
  return page.evaluate(() => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: AlpineMem[] }> })
      | null;
    return (el?._x_dataStack?.[0]?.memories as AlpineMem[]) ?? [];
  });
}

test("memory book: NL add → /parse stubbed → ✓确认 → real POST /api/facts (pending)", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  // FULFILL the paid parse with a fake "add" classification — NO LLM call.
  await page.route("**/api/facts/parse", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidate: "User prefers pink",
        classification: "add",
        confidence: 0.9,
        targetFactId: null,
        contradictedFact: null,
      }),
    }),
  );

  // Anti-vacuous: the candidate text must NOT already exist before we add it.
  const before = await alpineMemories(page);
  expect(before.some((m) => m.text === "User prefers pink")).toBe(false);

  // Composer is docked in the by-type view.
  await page.locator(".memory-view-btn").filter({ hasText: "By type" }).click();
  // Free text with NO 忘掉/forget keyword → routes to the LLM parse path.
  await page.locator(".memory-composer-input").fill("记一下我喜欢粉色");
  await page.locator(".memory-composer-send").click();

  // The "add" proposal card surfaces with the candidate + a single 确认.
  const addConfirm = page.locator(".memory-proposal-confirm");
  await expect(addConfirm).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".memory-proposal")).toContainText(
    "User prefers pink",
  );
  await addConfirm.click();

  // A new PENDING fact with the candidate text lands in alpine state — the real
  // POST /api/facts returned 201 (the client only appends on success).
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & {
            _x_dataStack?: Array<{ memories?: AlpineMem[] }>;
          })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as AlpineMem[] | undefined;
      return mems?.some(
        (m) => m.text === "User prefers pink" && m.status === "pending",
      );
    },
    undefined,
    { timeout: 8_000 },
  );

  // End-to-end proof: the fact persisted on the daemon (not just optimistic UI).
  const serverFacts = await getServerFacts(page);
  const created = serverFacts.find((f) => f.text === "User prefers pink");
  expect(created).toBeTruthy();
  expect(created?.status).toBe("pending");
  expect(created?.supersedes).toBeNull();

  await expect(page.locator(".memory-toast")).toBeVisible();
});

test("memory book: NL contradict → 替换 → real POST /api/facts {supersedes} (old kept active)", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  const targetId = "fact-e2e-g2-replace";
  const oldText = "User prefers light theme always";
  const newText = "User prefers dark theme instead";

  // FULFILL the paid parse with a fake "contradict" verdict pointing at the
  // dedicated seeded active fact — NO LLM call.
  await page.route("**/api/facts/parse", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidate: newText,
        classification: "contradict",
        confidence: 0.9,
        targetFactId: targetId,
        contradictedFact: { id: targetId, text: oldText },
      }),
    }),
  );

  // Anti-vacuous pre-state: the seeded target is active with no supersede link.
  const beforeServer = await getServerFacts(page);
  const oldBefore = beforeServer.find((f) => f.id === targetId);
  expect(oldBefore?.status).toBe("active");
  expect(oldBefore?.superseded_by).toBeNull();
  expect(beforeServer.some((f) => f.supersedes === targetId)).toBe(false);

  await page.locator(".memory-view-btn").filter({ hasText: "By type" }).click();
  await page.locator(".memory-composer-input").fill("其实我更喜欢深色主题");
  await page.locator(".memory-composer-send").click();

  // The 3-choice contradict card shows BOTH the new and the old text.
  const replaceBtn = page.locator(".memory-proposal-replace");
  await expect(replaceBtn).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".memory-proposal-keepboth")).toBeVisible();
  const cardText = await page.locator(".memory-proposal").textContent();
  expect(cardText).toContain(newText);
  expect(cardText).toContain(oldText);

  await replaceBtn.click();

  // New pending fact with the candidate text appears in alpine state.
  await page.waitForFunction(
    (txt: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & {
            _x_dataStack?: Array<{ memories?: AlpineMem[] }>;
          })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as AlpineMem[] | undefined;
      return mems?.some((m) => m.text === txt && m.status === "pending");
    },
    newText,
    { timeout: 8_000 },
  );

  // End-to-end proof on the daemon: the new fact supersedes the old; the old
  // fact gets superseded_by set BUT stays active (flips only on approve).
  const afterServer = await getServerFacts(page);
  const created = afterServer.find(
    (f) => f.text === newText && f.supersedes === targetId,
  );
  expect(created).toBeTruthy();
  expect(created?.status).toBe("pending");

  const oldAfter = afterServer.find((f) => f.id === targetId);
  expect(oldAfter?.superseded_by).toBe(created?.id);
  expect(oldAfter?.status).toBe("active");

  await expect(page.locator(".memory-toast")).toBeVisible();
});

test("memory book: NL contradict → 两条都留 → real POST /api/facts (no supersede, old untouched)", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  const targetId = "fact-e2e-g2-keepboth";
  const oldText = "User works in timezone UTC";
  const newText = "User works in timezone PST";

  await page.route("**/api/facts/parse", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        candidate: newText,
        classification: "contradict",
        confidence: 0.9,
        targetFactId: targetId,
        contradictedFact: { id: targetId, text: oldText },
      }),
    }),
  );

  const beforeServer = await getServerFacts(page);
  const oldBefore = beforeServer.find((f) => f.id === targetId);
  expect(oldBefore?.status).toBe("active");
  expect(oldBefore?.superseded_by).toBeNull();
  expect(beforeServer.some((f) => f.text === newText)).toBe(false);

  await page.locator(".memory-view-btn").filter({ hasText: "By type" }).click();
  await page.locator(".memory-composer-input").fill("我现在在 PST 时区");
  await page.locator(".memory-composer-send").click();

  const keepBothBtn = page.locator(".memory-proposal-keepboth");
  await expect(keepBothBtn).toBeVisible({ timeout: 5_000 });
  await keepBothBtn.click();

  await page.waitForFunction(
    (txt: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & {
            _x_dataStack?: Array<{ memories?: AlpineMem[] }>;
          })
        | null;
      const mems = el?._x_dataStack?.[0]?.memories as AlpineMem[] | undefined;
      return mems?.some((m) => m.text === txt && m.status === "pending");
    },
    newText,
    { timeout: 8_000 },
  );

  // End-to-end proof: new fact has NO supersede link; old fact wholly untouched.
  const afterServer = await getServerFacts(page);
  const created = afterServer.find((f) => f.text === newText);
  expect(created).toBeTruthy();
  expect(created?.status).toBe("pending");
  expect(created?.supersedes).toBeNull();

  const oldAfter = afterServer.find((f) => f.id === targetId);
  expect(oldAfter?.status).toBe("active");
  expect(oldAfter?.superseded_by).toBeNull();

  await expect(page.locator(".memory-toast")).toBeVisible();
});

// ─── working-memory rail (display-only, outside the book) ────────────────────

test("memory book: working-memory rail renders and is display-only", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");

  const panel = page.locator(".working-memory-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Working Memory");

  // Display-only: no forget / edit controls anywhere in the panel.
  await expect(panel.locator(".memory-row-forget")).toHaveCount(0);
  await expect(panel.locator("button")).toHaveCount(0);

  // The seeded chat session summary appears in the rail.
  await expect(panel).toContainText("Discussed memory book UI implementation");
});

test("memory book: working-memory rail does NOT appear inside the timeline", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");

  const timeline = page.locator(".memory-timeline");
  await expect(timeline).toBeVisible();
  await expect(timeline.locator(".working-memory-panel")).toHaveCount(0);

  const timelineText = await timeline.textContent();
  expect(timelineText).not.toContain("Working Memory");
});

test("memory book: working-memory rail shows empty state honestly when no sessions", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");

  const panel = page.locator(".working-memory-panel");
  await expect(panel).toBeVisible();

  const chatRows = panel.locator(".working-memory-chat-row");
  const emptyState = panel.locator(".working-memory-empty");

  const rowCount = await chatRows.count();
  if (rowCount === 0) {
    await expect(emptyState).toBeVisible();
    const emptyText = await emptyState.textContent();
    expect(emptyText).toContain("No chat history yet");
  } else {
    await expect(emptyState).not.toBeVisible();
    await expect(panel.locator("button")).toHaveCount(0);
  }
});

// ─── action-log SSR→client stored-events path ────────────────────────────────
//
// fact-e2e-actionlog is the ONLY seeded fact with a non-empty events[] stored on
// disk. Every other fact has events:[] and synthesizes events on the client.
// This test proves that the SSR serializes real FactEvent[] into the client
// island payload (data-memories attribute) and that buildLogRows correctly folds
// the two stored reaffirms into a single ×2 row in the expanded rail.

test("memory book: stored-events path — SSR-carried events shown newest-first, 2 individual reaffirm rows", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  // Anti-vacuous precondition: the seeded fact must be present in Alpine state
  // with its events[] non-empty (proves SSR→client serialization carried them).
  const storedEventsCount = await page.evaluate(() => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & {
          _x_dataStack?: Array<{ memories?: Array<{ id: string; events?: unknown[] }> }>;
        })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories ?? [];
    const fact = mems.find((m) => m.id === "fact-e2e-actionlog");
    return fact?.events?.length ?? -1;
  });
  // events[] must be non-empty (≥1) — proves SSR carried stored events, not [].
  expect(storedEventsCount).toBeGreaterThan(0);

  // Locate the row for fact-e2e-actionlog.
  const row = page.locator('.memory-row[data-event-id="fact-e2e-actionlog"]');
  await expect(row).toBeAttached();

  // The expand button must be visible (logRows.length > 0: approved + 2 reaffirms = 3).
  const toggleBtn = row.locator(".memory-action-log-toggle");
  await expect(toggleBtn).toBeVisible({ timeout: 5_000 });
  await expect(toggleBtn).toContainText("Details");

  // The rail is hidden before clicking.
  const rail = row.locator(".memory-action-log-rail");
  await expect(rail).not.toBeVisible();

  // Click 详情展开▾ — the rail becomes visible.
  await toggleBtn.click();
  await expect(rail).toBeVisible({ timeout: 3_000 });

  // The expanded rail must contain 2 individual ★重申 rows (newest→oldest,
  // each reaffirm is its own row). The old ×2 folding is GONE.
  const reaffirmEvents = rail.locator(".memory-action-log-event", {
    has: page.locator(".memory-action-log-verb", { hasText: "★ Reaffirmed" }),
  });
  await expect(reaffirmEvents).toHaveCount(2);

  // First row = newest reaffirm (04:30), second = older (04:20).
  const firstDateLabel = reaffirmEvents.nth(0).locator(".memory-action-log-event-date");
  const firstText = (await firstDateLabel.textContent())?.trim() ?? "";
  // dateLabel format is "— YYYY-MM-DD HH:mm" (with separator).
  expect(firstText).toContain("04:30");

  const secondDateLabel = reaffirmEvents.nth(1).locator(".memory-action-log-event-date");
  const secondText = (await secondDateLabel.textContent())?.trim() ?? "";
  expect(secondText).toContain("04:20");
});

test("memory book: ★重申 badge renders visibly for a fact with recall_count > 0", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  // The seed plants fact-e2e-reaffirm (recall_count 1) — its row MUST show a
  // visible "★ 重申 ×1" badge. The reaffirm DATE moved off this header badge
  // (smoke 2026-06-26) into the expanded action-log row; the badge is count-only.
  const row = page.locator('.memory-row[data-event-id="fact-e2e-reaffirm"]');
  await expect(row).toBeAttached();

  const badge = row.locator(".memory-row-reaffirm");
  await expect(badge).toBeVisible();

  const text = (await badge.textContent())?.trim() ?? "";
  expect(text).toContain("Reaffirmed ×1");
  expect(text).not.toContain("6/22");
});

// ─── action-log footer — collapsed 详情展开▾ toggle + expand/collapse ───────────
//
// Uses fact-e2e-reaffirm (active, events:[] in seed → synthesized on client to
// [created, approved]; buildLogRows returns [approved] (no created) → logRows.length=1
// → 详情展开▾ toggle appears). Collapsed shows ONLY the toggle, no inline summary.

test("memory book: action-log footer shows collapsed summary and expands/collapses", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  // Locate the row for fact-e2e-reaffirm (active, logRows synthesized → 1 approved row).
  const row = page.locator('.memory-row[data-event-id="fact-e2e-reaffirm"]');
  await expect(row).toBeAttached();

  // The 为什么 row is the toggle's new home (toggle sits on the why row, right-aligned).
  const whyRow = row.locator(".memory-row-why");
  await expect(whyRow).toBeVisible();

  // No inline 创建 summary span in the collapsed footer.
  await expect(row.locator(".memory-action-log-created")).not.toBeAttached();

  // The 详情展开▾ toggle is visible because logRows.length > 0.
  const toggleBtn = row.locator(".memory-action-log-toggle");
  await expect(toggleBtn).toBeVisible({ timeout: 5_000 });
  const beforeText = (await toggleBtn.textContent())?.trim();
  expect(beforeText).toContain("Details");

  // The expanded rail is hidden before clicking.
  const rail = row.locator(".memory-action-log-rail");
  await expect(rail).not.toBeVisible();

  // Click 详情展开▾ — the rail becomes visible.
  await toggleBtn.click();
  await expect(rail).toBeVisible({ timeout: 3_000 });

  // Button label flips to 收起▴.
  const afterExpandText = (await toggleBtn.textContent())?.trim();
  expect(afterExpandText).toContain("Collapse");

  // The expanded rail must contain at least one log row (✓生效 approved row).
  const logEvents = rail.locator(".memory-action-log-event");
  const logCount = await logEvents.count();
  expect(logCount).toBeGreaterThan(0);

  // Click 收起▴ — the rail is hidden again.
  await toggleBtn.click();
  await expect(rail).not.toBeVisible({ timeout: 3_000 });

  // Button label flips back to 详情展开▾.
  const afterCollapseText = (await toggleBtn.textContent())?.trim();
  expect(afterCollapseText).toContain("Details");
});

// ─── by-type modal read-only ─────────────────────────────────────────────────
//
// The by-type modal (opened by clicking a type card) must be READ-ONLY:
// no action buttons (删除/确认/拒绝/撤回退休) and no 为什么 line.
// The timeline card keeps all its buttons — this test must not regress those.

test("memory book: by-type modal is read-only — no action buttons, no 为什么 line", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  // Open the semantic type modal.
  await page.locator(".memory-view-btn").filter({ hasText: "By type" }).click();
  await page.locator(".memory-type-card-semantic").click();

  const modal = page.locator(".memory-modal");
  await expect(modal).toBeVisible();
  // Anti-vacuous: modal title shows 语义 (proves modal actually opened, not just
  // the backdrop flicker).
  await expect(page.locator(".memory-modal-title")).toContainText("Semantic");

  // Anti-vacuous: at least one fact row must be rendered by Alpine x-for
  // (proves the assertions below are not vacuously true on an empty list).
  await expect(modal.locator(".memory-modal-row").first()).toBeAttached({
    timeout: 5_000,
  });

  // ── Read-only: action buttons must be absent from the DOM entirely ────────
  // (not just x-show hidden — removed from the SSR template means they won't
  // appear in Alpine x-for clones either)
  await expect(modal.locator(".memory-modal-delete")).toHaveCount(0);
  await expect(modal.locator(".memory-modal-reactivate")).toHaveCount(0);
  await expect(modal.locator(".memory-modal-approve")).toHaveCount(0);
  await expect(modal.locator(".memory-modal-reject")).toHaveCount(0);
  await expect(modal.locator(".memory-modal-pending-actions")).toHaveCount(0);

  // ── Why line must be absent ────────────────────────────────────────────────
  // The why row is SSR-rendered only in the timeline card; the read-only modal
  // never carries it. Assert by class (robust — "Why" as a substring could
  // collide with fact text).
  await expect(modal.locator(".memory-row-why")).toHaveCount(0);

  // Supersede links are kept as read-only navigation (verified in the
  // supersede-link test above) — no need to duplicate that assertion here.

  // Close the modal cleanly.
  await page.locator(".memory-modal button").filter({ hasText: "×" }).click();
  await expect(modal).not.toBeVisible();
});

// ─── 生效/退休 status-filter chips ─────────────────────────────────────────────
//
// The seed has fact-e2e-superseded (retired) + fact-e2e-retire-001 (active).
// Clicking 退休 must show only retired rows; clicking again (toggle-off) must
// restore all rows; clicking 生效 must hide the retired row.

test("memory book: status filter chips filter by 生效/退休", async ({ page }) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  // ── Chips render ──────────────────────────────────────────────────────────
  const activeChip = page
    .locator(".memory-status-chip")
    .filter({ hasText: "Active" });
  const retiredChip = page
    .locator(".memory-status-chip")
    .filter({ hasText: "Retired" });
  await expect(activeChip).toBeVisible();
  await expect(retiredChip).toBeVisible();

  // ── Click 退休 → only retired rows visible ────────────────────────────────
  await retiredChip.click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ filterStatus?: string }> })
        | null;
      return el?._x_dataStack?.[0]?.filterStatus === "retired";
    },
    { timeout: 5_000 },
  );

  // Anti-vacuous: the seeded retired fact IS visible after filtering to 退休.
  const retiredRow = page.locator('[data-event-id="fact-e2e-superseded"]');
  await expect(retiredRow).toBeVisible({ timeout: 5_000 });

  // An active fact is hidden (fact-e2e-retire-001 is always active in seed).
  const activeRow = page.locator('[data-event-id="fact-e2e-retire-001"]');
  await expect(activeRow).not.toBeVisible();

  // ── Click 退休 again (toggle-off) → all rows return ───────────────────────
  await retiredChip.click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ filterStatus?: string }> })
        | null;
      return el?._x_dataStack?.[0]?.filterStatus === "";
    },
    { timeout: 5_000 },
  );

  // Both the retired and an active fact are now visible.
  await expect(retiredRow).toBeVisible({ timeout: 3_000 });
  await expect(activeRow).toBeVisible({ timeout: 3_000 });

  // ── Click 生效 → only active rows visible ────────────────────────────────
  await activeChip.click();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ filterStatus?: string }> })
        | null;
      return el?._x_dataStack?.[0]?.filterStatus === "active";
    },
    { timeout: 5_000 },
  );

  // The retired fact is now hidden; the active fact remains visible.
  await expect(retiredRow).not.toBeVisible();
  await expect(activeRow).toBeVisible({ timeout: 3_000 });
});

// ─── supersede link — partner text + jump-to highlight ───────────────────────
//
// fact-e2e-superseding (active) supersedes fact-e2e-superseded (retired).
// Both are seeded with mutual supersedes/superseded_by pointers.
// The test verifies:
//   1. The superseding card shows "⇄ 替代了「…」" with the PARTNER's text (not raw id).
//   2. The superseded (retired) card shows "↩ 被替代「…」" with the superseding text.
//   3. Clicking the ⇄ link scrolls to (and highlights) the superseded partner card.

test("memory book: supersede link shows partner text and jumpToFact highlights the partner", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  const supersedingId = "fact-e2e-superseding";
  const supersededId  = "fact-e2e-superseded";
  const supersededText   = "User prefers Windows for gaming";
  const supersedingText  = "User prefers macOS for development and gaming";

  // ── Anti-vacuous preconditions: both facts present in Alpine state ──────────

  const supersedingInState = await page.evaluate((id: string) => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: Array<{ id: string; supersedes?: string | null }> }> })
      | null;
    const mems = el?._x_dataStack?.[0]?.memories ?? [];
    return mems.find((m) => m.id === id) ?? null;
  }, supersedingId);
  expect(supersedingInState).not.toBeNull();
  // The supersedes pointer must be carried through to the client (not stripped by SSR).
  expect((supersedingInState as { supersedes?: string | null } | null)?.supersedes).toBe(supersededId);

  // ── Superseding card: expand log → see ⇄ 替代了「<partner text>」 ─────────────
  // The supersede link now lives INSIDE the expanded log (not the card body).

  const supersedingRow = page.locator(`.memory-row[data-event-id="${supersedingId}"]`);
  await expect(supersedingRow).toBeAttached();

  // Expand the superseding log to reveal the supersede sub-row.
  const supersedingToggle = supersedingRow.locator(".memory-action-log-toggle");
  await expect(supersedingToggle).toBeVisible({ timeout: 5_000 });
  await supersedingToggle.click();
  const supersedingRail = supersedingRow.locator(".memory-action-log-rail");
  await expect(supersedingRail).toBeVisible({ timeout: 3_000 });

  // Each x-for iteration renders a supersede button (visible only for the sub-row);
  // filter by non-empty partner text to avoid Playwright strict-mode violation.
  const supersedesLink = supersedingRail.locator(".memory-action-log-supersede-link").filter({ hasText: /「.+」/ });
  await expect(supersedesLink).toBeVisible({ timeout: 5_000 });

  const supersedesLinkText = (await supersedesLink.textContent())?.trim() ?? "";
  expect(supersedesLinkText).toContain("Supersedes");
  // Must contain beginning of the partner's actual text, not the raw id string.
  expect(supersedesLinkText).toContain(supersededText.slice(0, 20));
  expect(supersedesLinkText).not.toBe(supersededId);

  // ── Superseded (retired) card: expand log → see ↩ 被替代「<partner text>」 ──────

  const supersededRow = page.locator(`.memory-row[data-event-id="${supersededId}"]`);
  await expect(supersededRow).toBeAttached();

  // Expand the superseded log to reveal its supersede sub-row.
  const supersededToggle = supersededRow.locator(".memory-action-log-toggle");
  await expect(supersededToggle).toBeVisible({ timeout: 5_000 });
  await supersededToggle.click();
  const supersededRail = supersededRow.locator(".memory-action-log-rail");
  await expect(supersededRail).toBeVisible({ timeout: 3_000 });

  const supersededByLink = supersededRail.locator(".memory-action-log-supersede-link").filter({ hasText: /「.+」/ });
  await expect(supersededByLink).toBeVisible({ timeout: 5_000 });

  const supersededByLinkText = (await supersededByLink.textContent())?.trim() ?? "";
  expect(supersededByLinkText).toContain("Superseded");
  expect(supersededByLinkText).toContain(supersedingText.slice(0, 20));
  expect(supersededByLinkText).not.toBe(supersedingId);

  // ── Click ⇄ on the superseding card → the superseded card gets the highlight ─

  await supersedesLink.click();

  // The highlight class is added synchronously inside jumpToFact and removed
  // after 1.5 s — check it's present immediately after the click.
  await expect(supersededRow).toHaveClass(/memory-row-highlight/, { timeout: 2_000 });

  // Wait for the highlight to self-clear before the reverse-direction assertion
  // so the two highlights don't overlap and cause a false negative.
  await expect(supersededRow).not.toHaveClass(/memory-row-highlight/, { timeout: 3_000 });

  // ── Click ↩ on the superseded card → the superseding card gets the highlight ─

  await supersededByLink.click();
  await expect(supersedingRow).toHaveClass(/memory-row-highlight/, { timeout: 2_000 });
});

// ─── Live action-log: mutation handlers update events[] in Alpine state ───────
//
// After clicking 🗑 删除 on an active row the server returns the updated fact
// (including events[]). The island must append/replace events without a page
// reload so the expanded action-log shows the new event immediately.

test("memory book: 删除 updates action-log live — expanded rail shows 🌙 退休 without reload", async ({
  page,
}) => {
  await page.goto("/memory");
  await page.waitForLoadState("networkidle");
  await waitHydrated(page);

  const id = "fact-e2e-delete";

  // Anti-vacuous: the fact must be ACTIVE before we click (so the post-click
  // "retired" state cannot be a vacuous pass on an already-retired row).
  type MemItem = { id: string; status: string; events?: Array<{ action: string }> };
  const before = await page.evaluate((factId: string) => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemItem[] }> })
      | null;
    return el?._x_dataStack?.[0]?.memories?.find((m) => m.id === factId) ?? null;
  }, id);
  expect(before?.status).toBe("active");

  // Click 🗑 删除 on the active row.
  const deleteBtn = page
    .locator(`[data-event-id="${id}"] .memory-row-delete`)
    .first();
  await expect(deleteBtn).toBeVisible({ timeout: 5_000 });
  await deleteBtn.click();

  // Wait for Alpine state: status must flip to "retired".
  await page.waitForFunction(
    (factId: string) => {
      const el = document.querySelector('[x-data="memoryBook"]') as
        | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemItem[] }> })
        | null;
      return el?._x_dataStack?.[0]?.memories?.find((m) => m.id === factId)?.status === "retired";
    },
    id,
    { timeout: 8_000 },
  );

  // Anti-vacuous: events[] in Alpine state must now contain a "retired" action
  // (proves the live update landed, not just a status flip with no event data).
  const hasRetiredEvent = await page.evaluate((factId: string) => {
    const el = document.querySelector('[x-data="memoryBook"]') as
      | (HTMLElement & { _x_dataStack?: Array<{ memories?: MemItem[] }> })
      | null;
    const m = el?._x_dataStack?.[0]?.memories?.find((f) => f.id === factId);
    return m?.events?.some((e) => e.action === "retired") ?? false;
  }, id);
  expect(hasRetiredEvent).toBe(true);

  // Expand the action-log on that row — the rail must contain a 🌙 退休 row
  // without any page reload having occurred.
  // .first() like the deleteBtn locator above: after the retire live-update a
  // second (hidden-DOM) copy of the row can exist in another view section, and
  // Playwright strict mode throws on multi-resolve even when one is hidden
  // (race — surfaced under load 2026-07-02; the a11y tree shows ONE visible row).
  const row = page.locator(`[data-event-id="${id}"]`).first();
  const toggleBtn = row.locator(".memory-action-log-toggle").first();
  await expect(toggleBtn).toBeVisible({ timeout: 5_000 });
  await toggleBtn.click();

  const rail = row.locator(".memory-action-log-rail");
  await expect(rail).toBeVisible({ timeout: 3_000 });

  // At least one log event verb must contain "退休" (🌙 退休) — the retire event
  // that was appended live by the mutation handler.
  const retiredVerb = rail.locator(".memory-action-log-verb", { hasText: "Retired" });
  await expect(retiredVerb).toBeAttached({ timeout: 3_000 });
});
