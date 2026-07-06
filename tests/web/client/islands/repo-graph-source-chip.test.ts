/** siltpoke-generate — source chip switching semantics.
 *
 * RED is set on BEHAVIOR, not existence: clicking the Generated segment must
 * FLIP the rendered view (+ write the URL); the old code has no segment so the
 * flip never happens and the checkpoint fails.
 *
 * Session semantics (a standing rule): in-place switch after a completed generate
 * stays; a BARE-url reload returns to the authored default (authored-from-props
 * gate); switching back to Authored CLEARS the ?arch-source= param (bare-URL
 * semantics restored) rather than writing =authored.
 */
import { afterEach, afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  deferred,
  installFetchMock,
  jsonResponse,
  mountRepoGraph,
  registerDom,
  unregisterDom,
} from "./_dom-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  window.history.replaceState(null, "", "/repo-graph");
});

const AUTHORED = {
  N: {
    authbox: { kind: "cont", title: "AuthoredBox", accent: "sky", desc: "hand-written", drillTo: "alpha", x: 70, y: 320, w: 170, h: 90 },
  },
  E: [],
  BANDS: [{ x: 54, y: 288, w: 700, h: 160, label: "AUTHBAND", color: "rgba(127,176,200,.10)", lc: "#5f8499", note: "authored" }],
  BOUNDARY: { x: 40, y: 248, w: 800, h: 300, label: "fixture-repo · authored" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};

const GENERATED_DOC = {
  boundary: "fixture-gen",
  bands: [{ id: "core", label: { value: "GenBand", evidence: [{ file: "src/alpha/a.ts", line: 1 }] }, order: 0, members: ["genbox"] }],
  nodes: [
    // members present: under badge-door-members the generated glyph gates
    // on the evidence body (memberFiles), not bare drillTo — the parity
    // test must exercise a properly-evidenced cont.
    { id: "genbox", kind: "cont", title: { value: "GeneratedBox", evidence: [{ file: "src/alpha/a.ts", line: 1 }] }, band: { value: "core", evidence: [{ file: "src/alpha/a.ts", line: 1 }] }, drillTo: "alpha", members: ["src/alpha/a.ts"] },
  ],
  edges: [],
};

function quietFetch(): void {
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.1 } }))],
  ]);
}

describe("source chip — switching semantics", () => {
  test("clicking the Generated segment flips the view in place + writes the URL", async () => {
    quietFetch();
    const root = await mountRepoGraph({
      authoredModel: AUTHORED,
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: true },
    });
    // Boot lands on authored (pinned elsewhere).
    expect(root.innerHTML).toContain("AuthoredBox");

    root.querySelector<HTMLButtonElement>("#rg-src-generated")?.click();
    // The view must flip. On the old code there is no
    // segment, nothing happens, GeneratedBox never renders.
    expect(root.innerHTML).toContain("GeneratedBox");
    expect(root.innerHTML).not.toContain("AuthoredBox");
    expect(location.search).toContain("arch-source=generated");
    // stale marker visible on the Generated segment (cache is stale).
    expect(root.querySelector("#rg-src-stale")?.hasAttribute("hidden")).toBe(false);
  });

  test("switching back to Authored restores the view and CLEARS the param (bare-URL semantics)", async () => {
    quietFetch();
    const root = await mountRepoGraph({
      authoredModel: AUTHORED,
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: false },
    });
    root.querySelector<HTMLButtonElement>("#rg-src-generated")?.click();
    expect(root.innerHTML).toContain("GeneratedBox");
    root.querySelector<HTMLButtonElement>("#rg-src-authored")?.click();
    expect(root.innerHTML).toContain("AuthoredBox");
    expect(root.innerHTML).not.toContain("GeneratedBox");
    expect(location.search).not.toContain("arch-source");
  });

  test("completing a generate on an authored repo lands on generated + chip follows", async () => {
    const firstPoll = deferred<Response>();
    let taskCalls = 0;
    installFetchMock([
      ["/arch/task", () => {
        taskCalls += 1;
        return taskCalls === 1
          ? Promise.resolve(jsonResponse({ data: { task: null } })) // reconnect: idle
          : firstPoll.promise; // observer poll
      }],
      ["/arch/generate", () => Promise.resolve(jsonResponse({ success: true, taskId: "t-auth-1" }))],
      ["/arch/model", () => Promise.resolve(jsonResponse({ data: { model: GENERATED_DOC, groundedPct: 88 } }))],
      // estUsd fixture refreshed 0.82 → 1.55 with the estimate correction
      // — mock-only, the island renders whatever the route returns.
      ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 1.55 } }))],
    ]);
    const root = await mountRepoGraph({ authoredModel: AUTHORED }); // no cache → Generate offered
    await new Promise((r) => setTimeout(r, 0));
    const genBtn = root.querySelector<HTMLButtonElement>("#rg-arch-gen");
    // The Generate affordance must be REACHABLE on an authored repo (previously it
    // was hidden by the !hasAuthored clause — part of this RED).
    expect(genBtn?.hidden).toBe(false);
    genBtn?.click();
    await new Promise((r) => setTimeout(r, 0)); // POST resolved → observer polling
    firstPoll.resolve(jsonResponse({
      data: { task: { id: "t-auth-1", kind: "arch_generate", status: "done", repo: "f1x7ur3hash0", startedTs: "2026-06-10T00:00:00.000Z", startedAgoMs: 100 } },
    }));
    await new Promise((r) => setTimeout(r, 0));
    // In-place switch to the fresh generated view (existing behavior, kept).
    expect(root.innerHTML).toContain("GeneratedBox");
    expect(root.querySelector("#rg-src-generated")?.classList.contains("active")).toBe(true);
  });

  test("parity: the drill glyph renders on BOTH views of the same repo", async () => {
    quietFetch();
    const root = await mountRepoGraph({
      authoredModel: AUTHORED,
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: false },
    });
    expect(root.querySelectorAll(".c4-node.drillable .c4-drill").length).toBe(1); // authored view
    root.querySelector<HTMLButtonElement>("#rg-src-generated")?.click();
    expect(root.innerHTML).toContain("GeneratedBox"); // anti-vacuous: the view REALLY switched
    expect(root.querySelectorAll(".c4-node.drillable .c4-drill").length).toBe(1); // generated view
  });

  test("a repo WITHOUT an authored model gets no chip and the old affordance untouched", async () => {
    quietFetch();
    const root = await mountRepoGraph();
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    expect(chip === null || chip.hidden).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("#rg-arch-gen")?.hidden).toBe(false); // subset offer as ever
    expect(root.querySelector("#rg-arch-gen-label")?.textContent).toBe("⚡ Generate architecture");
  });
});

// ── Chip for non-authored repos ─────────────────

describe("chip render matrix", () => {
  // Regression guard: authored+generated → chip visible with Authored|Generated labels.
  // This path must be BYTE-IDENTICAL to the previous behavior.
  test("regression: authored+generated → chip visible, left=Authored right=Generated, left active", async () => {
    quietFetch();
    const root = await mountRepoGraph({
      authoredModel: AUTHORED,
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: false },
    });
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    // Chip visible, correct labels, authored active.
    expect(chip?.hidden).toBe(false);
    expect(root.querySelector<HTMLButtonElement>("#rg-src-authored")?.textContent?.trim()).toContain("Authored");
    expect(root.querySelector<HTMLButtonElement>("#rg-src-generated")?.textContent?.trim()).toContain("Generated");
    expect(root.querySelector("#rg-src-authored")?.classList.contains("active")).toBe(true);
    expect(root.querySelector("#rg-src-generated")?.classList.contains("active")).toBe(false);
  });

  // authored+no-generated → chip visible (authored path always shows chip).
  // The off-class dims the Generated segment to indicate no cache yet.
  test("regression: authored+no-generated → chip visible, Generated segment off (no cache)", async () => {
    quietFetch();
    const root = await mountRepoGraph({ authoredModel: AUTHORED });
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    // Preservation: chip visible — hasAuthored=true passes the gate.
    expect(chip?.hidden).toBe(false);
    expect(root.querySelector<HTMLButtonElement>("#rg-src-authored")?.textContent?.trim()).toContain("Authored");
    // Generated segment carries the 'off' class when no cache exists yet.
    expect(root.querySelector("#rg-src-generated")?.classList.contains("off")).toBe(true);
  });

  // non-authored+generated(fresh) → chip visible, left="Auto", right="Generated".
  test("non-authored+generated(fresh) → chip visible with Auto|Generated labels", async () => {
    quietFetch();
    const root = await mountRepoGraph({
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: false },
    });
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    // Chip visible (previously hidden for non-authored repos).
    // Pre-impl: updateSrcChip gate is `hasAuthored` only → hidden → FAIL.
    expect(chip?.hidden).toBe(false);
    const leftSeg = root.querySelector<HTMLButtonElement>("#rg-src-authored");
    expect(leftSeg?.textContent?.trim()).toBe("Auto");
    // Review-fix: tooltip must match the relabel — the SSR
    // "Hand-authored architecture" title would contradict the "Auto" label.
    expect(leftSeg?.title).toContain("Derived from project structure");
    expect(root.querySelector<HTMLButtonElement>("#rg-src-generated")?.textContent?.trim()).toContain("Generated");
  });

  // non-authored+generated(stale) → chip visible (stale cache is still toggleable).
  test("non-authored+generated(stale) → chip visible (stale is still toggleable)", async () => {
    quietFetch();
    const root = await mountRepoGraph({
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: true },
    });
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    // Chip visible even with a stale generated cache.
    expect(chip?.hidden).toBe(false);
    expect(root.querySelector<HTMLButtonElement>("#rg-src-authored")?.textContent?.trim()).toBe("Auto");
  });

  // non-authored+no-generated → chip hidden (no cache → no toggle to offer).
  test("non-authored+no-generated → chip hidden", async () => {
    quietFetch();
    const root = await mountRepoGraph(); // fixture default: no generated, no authored
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    // Preservation: chip hidden — no generated cache = nothing to toggle.
    expect(chip === null || chip.hidden).toBe(true);
  });
});

describe("active-state tracking (non-authored repos)", () => {
  // Boot with fresh generated (rung 5: lands on generated) → right active.
  test("non-authored boot on fresh generated → right segment active (generated)", async () => {
    quietFetch();
    const root = await mountRepoGraph({
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: false },
    });
    // Generated segment active on boot.
    expect(root.querySelector("#rg-src-generated")?.classList.contains("active")).toBe(true);
    expect(root.querySelector("#rg-src-authored")?.classList.contains("active")).toBe(false);
  });

  // Boot with ?arch-source=subset (rung 3) → left segment active.
  test("non-authored boot with ?arch-source=subset → left (Auto) segment active", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: false },
    });
    // Left (Auto) segment active when archSource=subset.
    expect(root.querySelector("#rg-src-authored")?.classList.contains("active")).toBe(true);
    expect(root.querySelector("#rg-src-generated")?.classList.contains("active")).toBe(false);
  });
});

describe("click behavior (non-authored repos)", () => {
  // clicking Auto on a non-authored repo → subset view + URL param set.
  test("clicking Auto → subset view + ?arch-source=subset written", async () => {
    quietFetch();
    // Boot on fresh generated (rung 5) — chip visible, right active.
    const root = await mountRepoGraph({
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: false },
    });
    // Verify boot state: viewing generated, chip visible.
    expect(root.innerHTML).toContain("GeneratedBox");
    const chip = root.querySelector<HTMLElement>("#rg-src-chip");
    expect(chip?.hidden).toBe(false);

    // Click the left segment (Auto).
    root.querySelector<HTMLButtonElement>("#rg-src-authored")?.click();
    // View switches to subset; URL has arch-source=subset.
    // Pre-impl: left seg calls applySource("authored") → authoredPayload null → returns false → no switch → FAIL.
    expect(root.innerHTML).not.toContain("GeneratedBox");
    expect(root.innerHTML).toContain("alpha"); // subset renders subdirs
    expect(location.search).toContain("arch-source=subset");
  });

  // Clicking Generated on a non-authored repo → back to generated view.
  test("clicking Generated (right) on non-authored → generated view + URL param set", async () => {
    quietFetch();
    window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
    const root = await mountRepoGraph({
      generatedModel: { doc: GENERATED_DOC, groundedPct: 88, stale: false },
    });
    // Boot on subset (rung 3), chip visible.
    expect(root.innerHTML).not.toContain("GeneratedBox");

    root.querySelector<HTMLButtonElement>("#rg-src-generated")?.click();
    // View switches to generated.
    expect(root.innerHTML).toContain("GeneratedBox");
    expect(location.search).toContain("arch-source=generated");
    expect(location.search).not.toContain("arch-source=subset");
  });
});
