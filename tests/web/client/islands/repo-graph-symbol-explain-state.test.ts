/**
 * Defect [43] — a function explanation that was just generated read
 * "not generated yet" the next time the function was selected, with
 * "Can't trace — this symbol's file path didn't resolve" under it.
 *
 * The symbol panel looked the file's path up in the per-subdir file list, and
 * a successful generate clears that list (so the ✦ badge re-derives). On the
 * symbol level nothing reloads it, so the lookup missed, the cache-state read
 * went out with an empty target, and the panel fell back to "none".
 *
 * Driven through the real boot path and the real click handlers; only fetch
 * is replaced (see _symbol-panel-harness.ts).
 *
 * Run: bun test tests/web/client/islands/repo-graph-symbol-explain-state.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "./_dom-harness";
import { CANONICAL, click, foot, openDoThing, server } from "./_symbol-panel-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

describe("a function's explain state before it is generated (defect [43])", () => {
  // The Generate button is an <a>. Three export tests replace
  // HTMLAnchorElement.prototype.click to stop a download, and the class
  // outlives their DOM registration — when they did not put it back, click()
  // here did nothing and the tests below failed on `generated`, which reads
  // like a product bug. This names the real cause if it ever comes back.
  test("precondition: a link's click() still reaches its listeners in this process", () => {
    const a = document.createElement("a");
    let heard = 0;
    a.addEventListener("click", () => heard++);
    document.body.appendChild(a);
    a.click();
    a.remove();
    expect(heard).toBe(1);
  });

  test("control: before generating, the panel offers Generate and can trace", async () => {
    const root = await openDoThing();
    const f = foot(root);
    expect(f.act).toBe("gen");
    expect(f.text).toContain("not generated yet");
    expect(f.canTrace).toBe(true);
    expect(server.stateReads).toEqual([CANONICAL]);
  });
});

describe("a function's explain state once it has been generated (defect [43])", () => {
  test("after generating, selecting the function again still says it is cached", async () => {
    const root = await openDoThing();
    await click(root, "#rg-expl-btn");
    expect(server.generated).toBe(true);
    expect(foot(root).act).toBe("open");

    // Select the same function again from the graph — the real click path.
    server.stateReads = [];
    await click(root, '[data-id="s:doThing"]');

    const f = foot(root);
    expect(server.stateReads).toEqual([CANONICAL]);
    expect(f.act).toBe("open");
    expect(f.text).toContain("Open explanation");
    expect(f.text).not.toContain("not generated yet");
    expect(f.cantTrace).toBe(false);
    expect(f.canTrace).toBe(true);
  });

  test("it does not depend on the file list: with the list unloadable, the panel still asks about the right node", async () => {
    const root = await openDoThing();
    server.fileListBreaksAfterGenerate = true;
    await click(root, "#rg-expl-btn");

    server.stateReads = [];
    await click(root, '[data-id="s:doThing"]');

    expect(server.stateReads).toEqual([CANONICAL]);
    expect(foot(root).act).toBe("open");
    expect(foot(root).cantTrace).toBe(false);
  });

  test("the file list is reloaded after a generate on the symbol level, not left empty", async () => {
    const root = await openDoThing();
    const before = server.fileListReads;
    expect(before).toBeGreaterThan(0);
    await click(root, "#rg-expl-btn");
    expect(server.fileListReads).toBe(before + 1);
  });
});
