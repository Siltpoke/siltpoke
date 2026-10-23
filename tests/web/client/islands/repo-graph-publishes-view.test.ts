/**
 * Defect [44], the Code Map's half: the page says which repository is open and
 * which component is selected, for things the chat cannot pin to.
 *
 * Driven through the real boot path and real clicks; the chat reads the same
 * global through `readCodeMapView()`.
 *
 * Run: bun test tests/web/client/islands/repo-graph-publishes-view.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readCodeMapView } from "../../../../src/web/client/lib/code-map-view";
import { registerDom, unregisterDom } from "./_dom-harness";
import { click, openDoThing, settle } from "./_symbol-panel-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

const viewedNode = (): unknown => (window as unknown as { __siltpokeViewedNode?: unknown }).__siltpokeViewedNode ?? null;

/** Mount the page on the architecture view (the fixture's default). */
async function mountArch(): Promise<HTMLElement> {
  const { mountRepoGraph, installFetchMock } = await import("./_dom-harness");
  installFetchMock([]);
  (window as unknown as { __siltpokeCodeMapView?: unknown }).__siltpokeCodeMapView = undefined;
  const root = await mountRepoGraph();
  await settle();
  return root;
}

function card(root: HTMLElement, title: string): HTMLElement {
  const el = Array.from(root.querySelectorAll<HTMLElement>(".c4-node")).find((n) => (n.textContent ?? "").includes(title));
  if (!el) throw new Error(`no component card named ${title}`);
  return el;
}

describe("what the Code Map publishes for the chat (defect [44])", () => {
  test("the page names the repository as soon as it boots, before any click", async () => {
    await mountArch();
    expect(readCodeMapView()).toEqual({ repo: "fixture-repo", selection: null, proj_hash: "f1x7ur3hash0" });
  });

  test("a selection left in the global by a previous visit is dropped on boot", async () => {
    const { mountRepoGraph, installFetchMock } = await import("./_dom-harness");
    installFetchMock([]);
    (window as unknown as { __siltpokeCodeMapView?: unknown }).__siltpokeCodeMapView = {
      repo: "another-repo",
      selection: { kind: "component", title: "Stale" },
    };
    await mountRepoGraph();
    await settle();
    expect(readCodeMapView()).toEqual({ repo: "fixture-repo", selection: null, proj_hash: "f1x7ur3hash0" });
  });

  test("selecting a component box publishes it, with the repository", async () => {
    const root = await mountArch();
    card(root, "alpha").click();
    await settle();
    const view = readCodeMapView();
    expect(view?.repo).toBe("fixture-repo");
    expect(view?.selection?.kind).toBe("component");
    expect(view?.selection?.title).toContain("alpha");
    // it is NOT a pinnable node — that channel stays empty.
    expect(viewedNode()).toBeNull();
  });

  test("selecting another component replaces the selection", async () => {
    const root = await mountArch();
    card(root, "alpha").click();
    await settle();
    card(root, "beta").click();
    await settle();
    expect(readCodeMapView()?.selection?.title).toContain("beta");
  });

  test("closing the panel clears the selection and keeps the repository", async () => {
    const root = await mountArch();
    card(root, "alpha").click();
    await settle();
    await click(root, "#rg-pclose");
    expect(readCodeMapView()).toEqual({ repo: "fixture-repo", selection: null, proj_hash: "f1x7ur3hash0" });
  });

  test("opening a function — which IS pinnable — clears the selection: the node channel takes over", async () => {
    const root = await mountArch();
    card(root, "alpha").click();
    await settle();
    expect(readCodeMapView()?.selection).not.toBeNull();

    await openDoThing(); // remounts and opens the symbol panel for doThing
    expect(readCodeMapView()?.selection).toBeNull();
    expect(readCodeMapView()?.repo).toBe("fixture-repo");
    expect(viewedNode()).not.toBeNull();
  });
});

describe("a folder on the plain code map (defect [44])", () => {
  test("selecting a folder publishes it as a folder, with its files", async () => {
    const { mountRepoGraph, installFetchMock, jsonResponse } = await import("./_dom-harness");
    installFetchMock([
      [
        "/api/repo-graph/files",
        () =>
          Promise.resolve(
            jsonResponse({
              data: {
                files: [{ name: "a.ts", path: "src/alpha/a.ts", loc: 20, symbols: 1, functions: 1, desc: "", explainState: "none" }],
                intraEdges: [],
              },
            }),
          ),
      ],
    ]);
    window.history.replaceState(null, "", "/repo-graph?arch-mode=codemap");
    try {
      const root = await mountRepoGraph();
      await settle();
      await click(root, '[data-id="alpha"]');
      const view = readCodeMapView();
      expect(view?.repo).toBe("fixture-repo");
      expect(view?.selection?.kind).toBe("folder");
      expect(view?.selection?.title).toContain("alpha");
      expect(view?.selection?.files).toEqual(["src/alpha/a.ts"]);
      expect(view?.selection?.calledBy).toEqual(["beta"]);
    } finally {
      window.history.replaceState(null, "", "/repo-graph");
    }
  });
});

