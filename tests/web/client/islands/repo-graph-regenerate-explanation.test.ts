/**
 * Defect [42] — an explanation that was generated once could not be generated
 * again. The panel offered only "Open explanation"; the trace card's
 * "Let siltpoke look" disappeared once it had an answer, and a node with a
 * code comment never had the button at all.
 *
 * The server always accepted `force` on both POST routes. These tests check
 * the half that was missing: a control exists, and clicking it sends `force`.
 *
 * Run: bun test tests/web/client/islands/repo-graph-regenerate-explanation.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { registerDom, unregisterDom } from "./_dom-harness";
import { click, foot, openDoThing, server, settle } from "./_symbol-panel-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

const explainPosts = () => server.posts.filter((p) => p.url.endsWith("/api/repo-graph/explain"));
const purposePosts = () => server.posts.filter((p) => p.url.endsWith("/api/repo-graph/trace/purpose"));
const purposeText = (root: HTMLElement): string =>
  (root.querySelector("#rg-pbody")?.textContent ?? "").replace(/\s+/g, " ");

describe("the file / function panel (defect [42])", () => {
  test("control: with nothing generated there is no Re-generate control", async () => {
    const root = await openDoThing();
    expect(foot(root).act).toBe("gen");
    expect(root.querySelector("#rg-expl-regen")).toBeNull();
  });

  test("the first generate does not send force", async () => {
    const root = await openDoThing();
    await click(root, "#rg-expl-btn");
    expect(explainPosts().map((p) => p.body.force)).toEqual([false]);
  });

  test("once generated, Re-generate is offered beside Open, and it sends force", async () => {
    const root = await openDoThing();
    await click(root, "#rg-expl-btn");
    expect(foot(root).act).toBe("open");
    expect(foot(root).text).toContain("Re-generate");

    await click(root, "#rg-expl-regen");
    expect(explainPosts().map((p) => p.body.force)).toEqual([false, true]);
    // ...and the panel is back to the cached state afterwards, control intact.
    expect(foot(root).act).toBe("open");
    expect(root.querySelector("#rg-expl-regen")).not.toBeNull();
  });

  test("Open explanation still opens the cached copy without force", async () => {
    const root = await openDoThing();
    await click(root, "#rg-expl-btn");
    await click(root, "#rg-expl-btn");
    expect(explainPosts().map((p) => p.body.force)).toEqual([false, false]);
  });
});

describe("the trace card's purpose (defect [42])", () => {
  async function openTraceCard(): Promise<HTMLElement> {
    const root = await openDoThing();
    await click(root, "#rg-sym-trace-btn");
    return root;
  }

  test("control: with nothing generated the card offers the first look, not a regenerate", async () => {
    const root = await openTraceCard();
    expect(purposeText(root)).toContain("Let siltpoke look");
    expect(root.querySelector('[data-gen][data-force="1"]')).toBeNull();
  });

  test("after it has an answer, Regenerate is offered, sends force, and shows the new answer", async () => {
    const root = await openTraceCard();
    await click(root, "[data-gen]");
    expect(purposeText(root)).toContain("Does the thing.");
    expect(purposePosts().map((p) => p.body.force)).toEqual([false]);

    server.nextPurpose = "Does the thing, the second time.";
    await click(root, '[data-gen][data-force="1"]');
    expect(purposePosts().map((p) => p.body.force)).toEqual([false, true]);
    expect(purposeText(root)).toContain("Does the thing, the second time.");
    expect(root.querySelector('[data-gen][data-force="1"]')).not.toBeNull();
  });

  test("an answer already cached when the card opens can be regenerated too", async () => {
    const root = await openDoThing();
    server.cachedPurpose = "Cached from an earlier session.";
    await click(root, "#rg-sym-trace-btn");
    expect(purposeText(root)).toContain("Cached from an earlier session.");
    await click(root, '[data-gen][data-force="1"]');
    expect(purposePosts().map((p) => p.body.force)).toEqual([true]);
  });
});

describe("when a regenerate does not go through (defect [42])", () => {
  test("a failed Regenerate keeps the answer on the card, says it failed, and can be tried again with force", async () => {
    const root = await openDoThing();
    await click(root, "#rg-sym-trace-btn");
    await click(root, "[data-gen]");
    expect(purposeText(root)).toContain("Does the thing.");

    server.purposeFailsWith = "claude -p exited 1";
    await click(root, '[data-gen][data-force="1"]');
    expect(purposeText(root)).toContain("Does the thing.");
    expect(root.querySelector("[data-regen-failed]")?.textContent).toContain("claude -p exited 1");
    expect(purposeText(root)).not.toContain("Brain unavailable");

    // trying again is still a forced call, not a free read of the old cache.
    await click(root, '[data-gen][data-force="1"]');
    expect(purposePosts().map((p) => p.body.force)).toEqual([false, true, true]);
    expect(root.querySelector("[data-regen-failed]")).toBeNull();
  });

  test("control: a failed FIRST look has nothing to keep and shows the error with Retry", async () => {
    const root = await openDoThing();
    await click(root, "#rg-sym-trace-btn");
    server.purposeFailsWith = "claude -p exited 1";
    await click(root, "[data-gen]");
    expect(purposeText(root)).toContain("Brain unavailable");
    expect(purposeText(root)).toContain("claude -p exited 1");
    expect(purposeText(root)).toContain("Retry");
  });

  test("a second activation while the panel's regenerate is running does not start another", async () => {
    const root = await openDoThing();
    await click(root, "#rg-expl-btn");
    const regen = root.querySelector<HTMLElement>("#rg-expl-regen");
    if (!regen) throw new Error("no regenerate link");
    // Two activations in one tick (Enter/Space on a button become click()),
    // which pointer-events:none does not stop.
    regen.click();
    regen.click();
    await settle();
    expect(explainPosts().map((p) => p.body.force)).toEqual([false, true]);
  });
});

describe("a trace node that has a code comment (defect [42])", () => {
  async function openCommentedCard(cached: string | null): Promise<HTMLElement> {
    const root = await openDoThing();
    server.codeComment = "Does the thing, says the comment.";
    server.cachedPurpose = cached;
    await click(root, "#rg-sym-trace-btn");
    return root;
  }

  test("keeps the comment and still offers a look — it used to have no button at all", async () => {
    const root = await openCommentedCard(null);
    expect(purposeText(root)).toContain("Does the thing, says the comment.");
    expect(purposeText(root)).toContain("Let siltpoke look");
    await click(root, "[data-gen]");
    expect(purposePosts().map((p) => p.body.force)).toEqual([false]);
    // both are shown: the comment is not replaced by the generated answer.
    expect(purposeText(root)).toContain("Does the thing, says the comment.");
    expect(purposeText(root)).toContain("Does the thing.");
  });

  test("an answer cached earlier is read back on open, beside the comment", async () => {
    const root = await openCommentedCard("Cached from an earlier session.");
    expect(purposeText(root)).toContain("Does the thing, says the comment.");
    expect(purposeText(root)).toContain("Cached from an earlier session.");
    expect(root.querySelector('[data-gen][data-force="1"]')).not.toBeNull();
  });
});

describe("the panel's Re-generate is a real target (defect [76])", () => {
  const css = readFileSync("src/web/screens/RepoGraph.tsx", "utf8");
  const rule = css.match(/\.rg-host \.rg-regen\{([^}]*)\}/)?.[1] ?? "";

  test("it is a <button>, a sibling of the cached note rather than a run of text inside it", async () => {
    const root = await openDoThing();
    await click(root, "#rg-expl-btn");
    const regen = root.querySelector<HTMLElement>("#rg-expl-regen");
    expect(regen?.tagName).toBe("BUTTON");
    expect(regen?.getAttribute("type")).toBe("button");
    expect(regen?.getAttribute("title")).toContain("paid call");
    expect(regen?.closest(".p-note")).toBeNull();
    // It must not be a second copy of the primary control.
    expect(root.querySelector("#rg-expl-btn")?.contains(regen as Node)).toBe(false);
    expect(root.querySelector("#rg-expl-btn")?.getAttribute("data-act")).toBe("open");
  });

  test("its stylesheet rule keeps the label on one line, with a real hit area, in tokens only", () => {
    expect(rule).toContain("white-space:nowrap");
    expect(rule).toMatch(/padding:\d+px \d+px/);
    expect(rule).toMatch(/margin:(1[0-9]|[2-9][0-9])px auto 0/);
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });

  test("a native button needs no key handler: Space and Enter both reach the click", async () => {
    const root = await openDoThing();
    await click(root, "#rg-expl-btn");
    const regen = root.querySelector<HTMLElement>("#rg-expl-regen");
    if (!regen) throw new Error("no regenerate button");
    // The island must not add its own keydown path on top of the native one
    // (that would double-fire under a real browser).
    expect(regen.onkeydown).toBeNull();
    regen.click();
    await settle();
    expect(explainPosts().map((p) => p.body.force)).toEqual([false, true]);
  });
});
