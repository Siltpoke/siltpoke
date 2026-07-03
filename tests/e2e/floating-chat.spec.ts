/**
 * Playwright spec for the floating-chat widget
 * (DOM+async browser layer).
 *
 * This is the NON-SUBSTITUTABLE layer: unit tests cover island logic but cannot
 * catch DOM+async bugs — a missing <template> tag, an x-show bound to a field
 * that never gets set, Alpine init races. This spec drives those paths in a
 * REAL browser (Chromium via Playwright) against the mock daemon.
 *
 * Test matrix:
 *   1. Launcher renders SVG speech-bubble (no emoji, no dark background)
 *   2. Launcher click opens panel + close button closes it
 *   3. Normal send via SSE → assistant reply renders + NO CTA shows
 *   4. staleCta (blocked: "stale") → freeze/continue buttons render + clicking
 *      "freeze" re-sends with anchor_decision: "freeze" in the request body
 *   5. staleCta "continue" button → re-sends with anchor_decision: "continue"
 *   6. node_gone (blocked: "node_gone") → terminal banner renders + composer disabled + "start new chat" present
 *   7. budget (blocked: "budget") → blockedCta notice renders + dismiss clears it + composer re-enables
 *   8. quiet_hours (blocked: "quiet_hours") → blockedCta notice renders with right copy
 *   9. desyncCta (client-side: viewed ≠ anchor) → two CTA buttons render
 *  10. /repo-graph: no c4-legend class in DOM
 *  11. return-to-node (↩) button appears when conversation has anchor
 *
 * Route interception pattern (page.route):
 *   The mock daemon always streams SSE. To inject blocked signals (JSON body),
 *   we intercept POST /api/chat and fulfill with the desired JSON response.
 *   For the PATCH /api/chat/sessions/.../anchor and GET /api/chat/sessions
 *   we also intercept as needed.
 */

import { test, expect, type Route, type Request } from "@playwright/test";
import { FIXTURE_HASH } from "./_setup/seed-repo-graph";

const FIXTURE_URL = `/repo-graph?repo=${FIXTURE_HASH}`;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Open the floating chat panel from any dashboard page. */
async function openPanel(page: import("@playwright/test").Page) {
  const launcher = page.getByRole("button", { name: "Open siltpoke chat" });
  await expect(launcher).toBeVisible({ timeout: 10_000 });
  await launcher.click();
  // Panel root becomes visible (x-show="open")
  await expect(page.locator(".fc-panel")).toBeVisible({ timeout: 5_000 });
}

/**
 * Seed a conversation with a known anchorNodeId so the floating chat considers
 * it "rehydrated" and desync detection is possible.
 * We intercept GET /api/chat/sessions to return a single session with the given
 * anchor node_id.
 */
async function stubSessionsWithAnchor(page: import("@playwright/test").Page, anchorNodeId: string) {
  await page.route("**/api/chat/sessions", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          {
            id: "stub-sess-001",
            anchor: { node_id: anchorNodeId, node_name: "stubFn", node_type: "fn" },
            label: "stubFn",
            pin: "src/stub.ts › stubFn",
            badge: "fn",
            title: "what is this?",
            message_count: 1,
          },
        ],
      }),
    });
  });
}

/** Stub GET /api/chat/sessions/:id/messages so openConversation doesn't fail. */
async function stubMessages(page: import("@playwright/test").Page) {
  await page.route("**/api/chat/sessions/*/messages", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ messages: [{ role: "user", text: "what is this?" }] }),
    });
  });
}

/** Intercept POST /api/chat and return a JSON blocked signal instead of SSE. */
async function stubChatBlocked(
  page: import("@playwright/test").Page,
  signal: Record<string, unknown>,
) {
  await page.route("**/api/chat", async (route: Route, req: Request) => {
    if (req.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(signal),
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * Fill + submit the floating-chat composer. Alpine's x-model requires an `input`
 * event; the send button is type="submit" inside a form with x-on:submit.prevent="send()".
 */
async function composerSend(page: import("@playwright/test").Page, text: string) {
  const input = page.locator(".fc-panel input[type=text]");
  await input.fill(text);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>(".fc-panel input[type=text]");
    if (el) el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator(".fc-panel button[type=submit]")).toBeEnabled({ timeout: 5_000 });
  const form = page.locator(".fc-panel form");
  await form.evaluate((f: HTMLFormElement) => {
    f.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });
}

// ── test 1: launcher visual ───────────────────────────────────────────────────

test(
  // what this guarantees: the launcher is an SVG speech-bubble (no emoji) inside
  // a dark ink circle with a white icon — the final design after live smoke
  "launcher renders white speech-bubble SVG inside a dark ink circle",
  async ({ page }) => {
    await page.goto("/");
    const launcher = page.getByRole("button", { name: "Open siltpoke chat" });
    await expect(launcher).toBeVisible({ timeout: 10_000 });

    // The launcher must contain the SVG path element (speech-bubble shape)
    const svg = launcher.locator("svg");
    await expect(svg).toBeVisible();

    // The SVG path for the speech-bubble "M21 15a2 2 0 0 1-2 2H7l-4 4V5..."
    const speechPath = launcher.locator("svg path").first();
    await expect(speechPath).toBeAttached();

    // Class audit: a dark filled circle (bg-ink + rounded-full) with a white
    // icon (text-[#fff]); no leftover emoji-era transparent styling.
    const cls = await launcher.getAttribute("class") ?? "";
    expect(cls).toContain("bg-ink");
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("text-[#fff]");
  },
);

// ── test 2: open / close panel ────────────────────────────────────────────────

test(
  // what this guarantees: the launcher click opens the panel (x-show="open"
  // toggles visibility) and the × close button collapses it back
  "launcher click opens panel; close button collapses it",
  async ({ page }) => {
    await page.goto("/");
    await openPanel(page);
    // Header should show "siltpoke"
    await expect(page.locator(".fc-panel")).toContainText("siltpoke");

    // Click the × close button
    await page.getByRole("button", { name: "Close" }).click();
    // Panel wrapper should no longer be visible (x-show="open" → display:none)
    await expect(page.locator(".fc-panel")).toBeHidden({ timeout: 5_000 });
    // Launcher button re-appears
    await expect(page.getByRole("button", { name: "Open siltpoke chat" })).toBeVisible();
  },
);

// ── test 3: normal SSE send ───────────────────────────────────────────────────

test(
  // what this guarantees: when the daemon returns a real SSE stream (mock:
  // "Mock reply from test daemon."), the assistant reply renders in the message
  // body area AND no CTA block (stale/terminal/blocked/desync) is visible
  "normal SSE send → assistant reply renders + no CTA shown",
  async ({ page }) => {
    // Stub sessions: return one session with no anchor (general chat) and
    // message_count=0 so the island opens a fresh-ish conversation.
    await page.route("**/api/chat/sessions", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "sess-normal-001",
              anchor: null,
              label: "general",
              pin: "",
              badge: "",
              title: "",
              message_count: 0,
            },
          ],
        }),
      });
    });
    await page.route("**/api/chat/sessions/*/messages", async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: [] }),
      });
    });

    await page.goto("/");
    await openPanel(page);
    await composerSend(page, "hello");

    // The mock daemon streams "Mock reply from test daemon." — wait for it.
    // The message body scroll container is the div.min-h-0.overflow-y-auto inside .fc-panel.
    const msgBody = page.locator(".fc-panel .min-h-0.overflow-y-auto");
    await expect(msgBody).toContainText("Mock reply from test daemon.", { timeout: 10_000 });

    // No CTA visible
    // staleCta block: x-show="staleCta !== null"
    await expect(page.locator(".fc-panel [x-show='staleCta !== null']")).toBeHidden();
    // terminalCta: x-show="terminalCta != null"
    await expect(page.locator(".fc-panel [x-show='terminalCta != null']")).toBeHidden();
    // blockedCta: x-show="blockedCta !== null"
    await expect(page.locator(".fc-panel [x-show='blockedCta !== null']")).toBeHidden();
    // desyncCta: x-show="desyncCta !== null"
    await expect(page.locator(".fc-panel [x-show='desyncCta !== null']")).toBeHidden();
  },
);

// ── test 4: stale CTA "freeze" ────────────────────────────────────────────────

test(
  // what this guarantees: when POST /api/chat returns {blocked:"stale"}, the
  // staleCta block renders with both freeze/continue buttons AND clicking
  // "freeze" re-sends the request with anchor_decision:"freeze" in the body
  "staleCta renders on blocked:stale + freeze button re-sends with anchor_decision:freeze",
  async ({ page }) => {
    await stubSessionsWithAnchor(page, "fn:src/stub.ts:stubFn");
    await stubMessages(page);

    // First POST returns stale; second POST (after freeze) returns SSE
    let callCount = 0;
    const capturedBodies: string[] = [];
    await page.route("**/api/chat", async (route: Route, req: Request) => {
      if (req.method() !== "POST") { await route.continue(); return; }
      callCount++;
      capturedBodies.push(req.postData() ?? "");
      if (callCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            blocked: "stale",
            pinned_at: "2026-06-23T10:00:00Z",
            node_name: "stubFn",
          }),
        });
      } else {
        // Let the second call go through to the mock SSE daemon
        await route.continue();
      }
    });

    await page.goto("/");
    await openPanel(page);
    await composerSend(page, "what is this?");

    // Wait for the stale CTA block to appear
    const staleCta = page.locator(".fc-panel [x-show='staleCta !== null']");
    await expect(staleCta).toBeVisible({ timeout: 8_000 });

    // Both buttons must render
    const freezeBtn = staleCta.getByRole("button", { name: /keep discussing/i });
    const continueBtn = staleCta.getByRole("button", { name: /current version/i });
    await expect(freezeBtn).toBeVisible();
    await expect(continueBtn).toBeVisible();

    // Composer input must be disabled while stale CTA is showing
    await expect(page.locator(".fc-panel input[type=text]")).toBeDisabled();

    // Click freeze → second POST fires
    await freezeBtn.click();

    // Assert the second POST carries anchor_decision: "freeze"
    await expect(async () => {
      expect(capturedBodies.length).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 5_000 });
    const secondBody = JSON.parse(capturedBodies[1] ?? "{}") as Record<string, unknown>;
    expect(secondBody.anchor_decision).toBe("freeze");

    // Stale CTA should clear after choosing
    await expect(staleCta).toBeHidden({ timeout: 5_000 });
  },
);

// ── test 5: stale CTA "continue" ─────────────────────────────────────────────

test(
  // what this guarantees: clicking "continue" on the stale CTA re-sends with
  // anchor_decision:"continue" (the user wants fresh code context)
  "staleCta continue button re-sends with anchor_decision:continue",
  async ({ page }) => {
    await stubSessionsWithAnchor(page, "fn:src/stub.ts:stubFn");
    await stubMessages(page);

    let callCount = 0;
    const capturedBodies: string[] = [];
    await page.route("**/api/chat", async (route: Route, req: Request) => {
      if (req.method() !== "POST") { await route.continue(); return; }
      callCount++;
      capturedBodies.push(req.postData() ?? "");
      if (callCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            blocked: "stale",
            pinned_at: "2026-06-23T10:00:00Z",
            node_name: "stubFn",
          }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto("/");
    await openPanel(page);
    await composerSend(page, "explain this");

    const staleCta = page.locator(".fc-panel [x-show='staleCta !== null']");
    await expect(staleCta).toBeVisible({ timeout: 8_000 });
    const continueBtn = staleCta.getByRole("button", { name: /current version/i });
    await continueBtn.click();

    await expect(async () => {
      expect(capturedBodies.length).toBeGreaterThanOrEqual(2);
    }).toPass({ timeout: 5_000 });
    const secondBody = JSON.parse(capturedBodies[1] ?? "{}") as Record<string, unknown>;
    expect(secondBody.anchor_decision).toBe("continue");
  },
);

// ── test 6: node_gone terminal state ─────────────────────────────────────────

test(
  // what this guarantees: when POST /api/chat returns {blocked:"node_gone"},
  // the terminalCta banner renders with "renamed or removed" copy, the composer
  // is permanently disabled, and a "start new chat" action is present
  "terminalCta renders on blocked:node_gone + composer disabled + start-new-chat present",
  async ({ page }) => {
    await stubSessionsWithAnchor(page, "fn:src/stub.ts:stubFn");
    await stubMessages(page);

    await stubChatBlocked(page, { blocked: "node_gone", node_name: "stubFn" });

    await page.goto("/");
    await openPanel(page);
    await composerSend(page, "hello gone node");

    // terminalCta block must appear
    const terminalCta = page.locator(".fc-panel [x-show='terminalCta != null']");
    await expect(terminalCta).toBeVisible({ timeout: 8_000 });

    // Must contain "renamed or removed" copy
    await expect(terminalCta).toContainText(/renamed or removed/i);

    // The "start new chat" button must be present
    await expect(terminalCta.getByRole("button", { name: /start a new chat/i })).toBeAttached();

    // Composer input must be disabled (terminalCta != null → :disabled)
    await expect(page.locator(".fc-panel input[type=text]")).toBeDisabled();
    // Send button also disabled
    await expect(page.locator(".fc-panel button[type=submit]")).toBeDisabled();

    // Other CTAs must NOT be visible simultaneously
    await expect(page.locator(".fc-panel [x-show='staleCta !== null']")).toBeHidden();
    await expect(page.locator(".fc-panel [x-show='blockedCta !== null']")).toBeHidden();
  },
);

// ── test 7: budget blocked CTA ────────────────────────────────────────────────

test(
  // what this guarantees: when POST /api/chat returns {blocked:"budget"},
  // the blockedCta notice renders with the budget copy; dismiss clears it and
  // the composer re-enables (the user can retry when budget resets)
  "blockedCta renders on blocked:budget + dismiss re-enables composer",
  async ({ page }) => {
    await stubSessionsWithAnchor(page, "fn:src/stub.ts:stubFn");
    await stubMessages(page);

    await stubChatBlocked(page, { blocked: "budget", used_pct: 1.0 });

    await page.goto("/");
    await openPanel(page);
    await composerSend(page, "budget test");

    const blockedCta = page.locator(".fc-panel [x-show='blockedCta !== null']");
    await expect(blockedCta).toBeVisible({ timeout: 8_000 });

    // Must contain the budget copy ("Daily budget reached")
    await expect(blockedCta).toContainText(/daily budget reached/i);

    // Composer disabled while notice shows
    await expect(page.locator(".fc-panel input[type=text]")).toBeDisabled();

    // Dismiss button must render and clear the notice
    const dismissBtn = blockedCta.getByRole("button", { name: /dismiss/i });
    await expect(dismissBtn).toBeVisible();
    await dismissBtn.click();

    // blockedCta clears → composer re-enables
    await expect(blockedCta).toBeHidden({ timeout: 5_000 });
    await expect(page.locator(".fc-panel input[type=text]")).toBeEnabled({ timeout: 3_000 });
  },
);

// ── test 8: quiet_hours blocked CTA ──────────────────────────────────────────

test(
  // what this guarantees: when POST /api/chat returns {blocked:"quiet_hours"},
  // the blockedCta notice renders with quiet-hours copy (different from budget)
  "blockedCta renders on blocked:quiet_hours with correct copy",
  async ({ page }) => {
    await stubSessionsWithAnchor(page, "fn:src/stub.ts:stubFn");
    await stubMessages(page);

    await stubChatBlocked(page, { blocked: "quiet_hours" });

    await page.goto("/");
    await openPanel(page);
    await composerSend(page, "quiet hours test");

    const blockedCta = page.locator(".fc-panel [x-show='blockedCta !== null']");
    await expect(blockedCta).toBeVisible({ timeout: 8_000 });

    // Must contain the quiet-hours copy ("Quiet hours")
    await expect(blockedCta).toContainText(/quiet hours/i);

    // Dismiss works
    await blockedCta.getByRole("button", { name: /dismiss/i }).click();
    await expect(blockedCta).toBeHidden({ timeout: 5_000 });
  },
);

// ── test 9: desync CTA ────────────────────────────────────────────────────────

test(
  // what this guarantees: when the user sends while the viewed node ≠ the
  // conversation's anchor (client-side desync detection), the desyncCta block
  // renders with TWO buttons: "re-anchor" and "new chat"
  "desyncCta renders when viewed node ≠ conversation anchor",
  async ({ page }) => {
    // Seed a session pinned to "fn:src/stub.ts:stubFn" (anchorNodeId from server)
    await stubSessionsWithAnchor(page, "fn:src/stub.ts:stubFn");
    await stubMessages(page);

    await page.goto("/");

    // Seed window.__siltpokeViewedNode to a DIFFERENT node before Alpine init
    // (the bridge global is read by syncViewed() in the island's init())
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__siltpokeViewedNode = {
        target: { node_id: "fn:src/other.ts:otherFn" },
        projHash: "abc123",
        label: "otherFn",
      };
      // Fire the bridge event so the already-initialized island syncs
      window.dispatchEvent(new CustomEvent("siltpoke:viewed-changed"));
    });

    await openPanel(page);

    // Wait for Alpine to boot and session to load (activeId gets set)
    await page.waitForTimeout(500);

    // Try to send — desync fires (viewed fn:src/other.ts:otherFn ≠ anchor fn:src/stub.ts:stubFn)
    await composerSend(page, "desynced message");

    const desyncCta = page.locator(".fc-panel [x-show='desyncCta !== null']");
    await expect(desyncCta).toBeVisible({ timeout: 8_000 });

    // Both choice buttons must render
    const reanchorBtn = desyncCta.getByRole("button", { name: /re-anchor this chat/i });
    const newChatBtn = desyncCta.getByRole("button", { name: /new chat about/i });
    await expect(reanchorBtn).toBeVisible();
    await expect(newChatBtn).toBeVisible();
  },
);

// ── test 10: /repo-graph has no c4-legend ────────────────────────────────────

test(
  // what this guarantees: the /repo-graph page has NO element with class
  // c4-legend in the DOM (regression guard — the old implementation had one
  // that was removed; this confirms it hasn't crept back)
  "/repo-graph page has no .c4-legend element in the DOM",
  async ({ page }) => {
    await page.goto(FIXTURE_URL);
    await expect(page.locator('[x-data="repoGraph"]')).toBeAttached({ timeout: 10_000 });
    // Wait for C4 render to mount
    await expect(page.locator(".c4-boundary")).toBeVisible({ timeout: 10_000 });

    // Assert no c4-legend class anywhere
    const legendEls = page.locator(".c4-legend");
    await expect(legendEls).toHaveCount(0);
  },
);

// ── test 11: return-to-node (↩) button ───────────────────────────────────

test(
  // what this guarantees: on /repo-graph with a conversation anchored to a node
  // AND window.__siltpokeFocusNode bridge present, the ↩ return-to-node button
  // is visible in the 📍 pin bar
  "↩ return-to-node button visible when conversation has anchor + bridge mounted",
  async ({ page }) => {
    await stubSessionsWithAnchor(page, "fn:src/stub.ts:stubFn");
    await stubMessages(page);

    await page.goto(FIXTURE_URL);
    // Wait for repo-graph island to mount (it installs the focus bridge)
    await expect(page.locator('[x-data="repoGraph"]')).toBeAttached({ timeout: 10_000 });

    // Install the focus bridge manually so canReturnToNode() is true
    // (the real bridge from the repo-graph island takes a tick to wire up;
    // we install it early to avoid a race condition in headless)
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__siltpokeFocusNode = async (
        _target: unknown,
      ): Promise<boolean> => true;
    });

    await openPanel(page);

    // Wait for session load + activeId to be set
    await page.waitForTimeout(600);

    // The 📍 bar is x-show="active()" — it should be visible when a session loaded
    const pinBar = page.locator(".fc-panel [x-show='active()']").first();
    await expect(pinBar).toBeVisible({ timeout: 5_000 });

    // The ↩ button has aria-label="Return to source node in graph"
    const returnBtn = page.getByRole("button", { name: "Return to source node in graph" });
    await expect(returnBtn).toBeVisible({ timeout: 5_000 });
  },
);
