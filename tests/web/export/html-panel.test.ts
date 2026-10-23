/** The exported page's own script, driven in a DOM: a click on a box fills the panel with textContent only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildExportHtml } from "../../../src/web/client/export/build-html";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import { mountHtmlPanel } from "../../../src/web/client/export/html-panel";
import { registerDom, unregisterDom } from "../client/islands/_dom-harness";
import { model, STAMP, trust } from "./fixtures";

beforeAll(registerDom);
afterAll(unregisterDom);

const g = globalThis as unknown as Record<string, unknown>;
const saved: string[] = [];

/** Load a built file into the DOM (scripts do not run) and mount the panel by hand. */
function load(t = trust(), m = model(), extraSvg = ""): void {
  const built = buildExportSvg(m, t, { theme: "light", fontCss: "", stampLine: STAMP });
  // happy-dom's parser never leaves an SVG <style> (everything after it is dropped); a real
  // browser does. The panel does not read the style, so the test's copy has none.
  const svg = built.svg.replace(/<defs>[\s\S]*?<\/defs>/, "").replace("</svg>", `${extraSvg}</svg>`);
  const { width, height } = built;
  const html = buildExportHtml({ svg, width, height, model: m, trust: t, standaloneJs: "/* not run */", appendix: false });
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1];
  mountHtmlPanel(document);
}
const panel = (): HTMLElement => document.getElementById("panel")!;
const rect = (id: string): Element => document.querySelector(`rect[data-id="${id}"]`)!;
const click = (e: Element): void => void e.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
/** Each list row as text; a connection row's two lines are joined with " | ". */
const items = (): string[] =>
  Array.from(panel().querySelectorAll("li")).map((li) =>
    li.children.length ? Array.from(li.children).map((c) => c.textContent ?? "").join(" | ") : (li.textContent ?? ""));
const headings = (): string[] => Array.from(panel().querySelectorAll("h3")).map((h) => h.textContent ?? "");

describe("panel", () => {
  test("a click on a box opens the panel: description, folders with coverage, edges with evidence (AC25)", () => {
    load();
    expect(panel().hidden).toBe(true);
    click(rect("b"));
    expect(panel().hidden).toBe(false);
    expect(panel().querySelector("h2")!.textContent).toBe("Beta store");
    expect(panel().textContent).toContain("does beta");
    expect(items()).toEqual([
      "src/b · AI listed 1 of 2 files",
      "src/b2 · AI listed 3 of 9 files",
      // Read like the image's key (its number first), evidence in plain words underneath (F4).
      "1  Alpha core → Beta store — uses | Evidence: 3 imports",
      "3  Beta store → Gamma — writes | Evidence: the cited line is no longer in the code",
    ]);
    expect(headings()).toEqual(["Folders", "Incoming (1)", "Outgoing (1)"]);
    click(rect("a"));
    expect(items()).toContain("2  Alpha core → Some API — calls | Evidence: cited web/api.ts:40"); // an outside box is named by its title
    expect(headings()).toContain("Incoming (0)");
    expect(panel().textContent).toContain("(none)");
    expect(panel().textContent).not.toContain("←");
    expect(panel().textContent).not.toContain("×");
  });

  test("clicking a box's title text opens it too", () => {
    load();
    click(document.querySelector('text[data-for="c"] tspan')!);
    expect(panel().querySelector("h2")!.textContent).toBe("Gamma");
  });

});

describe("panel — outside-system boxes (review M1)", () => {
  test("an outside-system box has a panel too: its title, what it is, and its edges (review M1)", () => {
    load();
    click(document.querySelector('rect[data-node="ext"]')!);
    expect(panel().hidden).toBe(false);
    expect(panel().querySelector("h2")!.textContent).toBe("Some API");
    expect(panel().textContent).toContain("Outside the system.");
    expect(items()).toEqual(["2  Alpha core → Some API — calls | Evidence: cited web/api.ts:40"]);
    expect(document.querySelector('rect[data-node="ext"]')!.hasAttribute("data-selected")).toBe(true);
  });

  test("Esc and a click elsewhere close it; a click inside the panel does not; the box is marked selected", () => {
    load();
    click(rect("a"));
    expect(rect("a").hasAttribute("data-selected")).toBe(true);
    click(panel().querySelector("h2")!);
    expect(panel().hidden).toBe(false);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel().hidden).toBe(true);
    expect(rect("a").hasAttribute("data-selected")).toBe(false);
    click(rect("b"));
    click(document.body);
    expect(panel().hidden).toBe(true);
  });

  test("AI text is written as text: an injected <img> is a string, not an element", () => {
    const t = trust();
    t.containers[0].title = "<b>Alpha</b>";
    t.containers[0].desc = "<img src=x onerror=alert(1)>";
    t.containers[0].folders[0].folder = "<script>x</script>";
    load(t);
    click(rect("a"));
    expect(panel().querySelector("img,b,script")).toBeNull();
    expect(panel().querySelector("h2")!.textContent).toBe("<b>Alpha</b>");
    expect(panel().textContent).toContain("<img src=x onerror=alert(1)>");
    expect(items()[0]).toContain("<script>x</script>");
  });
});

describe("Save as image (AC28)", () => {
  const keep: Record<string, unknown> = {};
  let realAnchorClick: (() => void) | undefined;
  beforeAll(() => {
    for (const k of ["Image", "requestAnimationFrame"]) keep[k] = g[k];
    g.Image = class { src = ""; decode = async () => {}; };
    g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
    Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: () => ({ data: [0, 0, 0, 255] }) })) as never;
    HTMLCanvasElement.prototype.toBlob = ((cb: (b: Blob) => void) => cb(new Blob(["png"]))) as never;
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = () => {};
    // Restored in afterAll: the class outlives this file's DOM registration, so a
    // click() left replaced here makes every later file's `<a>.click()` a no-op.
    realAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      saved.push(this.download);
    };
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(keep)) g[k] = v;
    if (realAnchorClick) HTMLAnchorElement.prototype.click = realAnchorClick;
  });

  test("rasterizes the page's own SVG and saves code-map-<source>-<date>.png", async () => {
    load();
    click(document.getElementById("save-img")!);
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^code-map-generated-\d{4}-\d{2}-\d{2}\.png$/);
    expect(document.getElementById("status")!.textContent).toBe("");
  });
});

describe("panel — connection wording (round 7)", () => {
  test("every evidence kind in plain words: 1 import (singular), cited, none recorded, no trust record", () => {
    const t = trust();
    t.edges[0] = { ...t.edges[0], evidence: { kind: "import", count: 1 } }; // a → b
    t.edges[1] = { ...t.edges[1], evidence: { kind: "none", reason: "no-import-no-citation" } }; // b → c
    const m = model();
    m.E.push(["c", "b", "answers"]); // drawn, but the trust map has no record of it
    load(t, m);
    click(rect("b"));
    const rows = items().filter((r) => r.includes(" → "));
    expect(rows).toContain("1  Alpha core → Beta store — uses | Evidence: 1 import");
    expect(rows).toContain("3  Beta store → Gamma — writes | Evidence: no evidence recorded");
    expect(rows).toContain("4  Gamma → Beta store — answers | Evidence: no evidence recorded");
    click(rect("a"));
    expect(items()).toContain("2  Alpha core → Some API — calls | Evidence: cited web/api.ts:40");
  });
  test("an edge each way between two boxes: one under Incoming, one under Outgoing", () => {
    const m = model();
    m.E.push(["b", "a", "replies"]);
    load(trust(), m);
    click(rect("a"));
    expect(headings()).toContain("Incoming (1)");
    expect(headings()).toContain("Outgoing (2)");
    expect(items().some((r) => r.includes("Beta store → Alpha core — replies"))).toBe(true);
  });
  test("a self-edge is listed once, under Outgoing", () => {
    const m = model();
    m.E.push(["a", "a", "recurses"]);
    load(trust(), m);
    click(rect("a"));
    expect(items().filter((r) => r.includes("Alpha core → Alpha core — recurses"))).toHaveLength(1);
    expect(headings()).toContain("Incoming (0)");
    expect(headings()).toContain("Outgoing (3)");
  });
});

describe("panel — keyboard", () => {
  const key = (e: Element, k: string): void => void e.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  test("every box is a named, focusable button", () => {
    load();
    for (const id of ["a", "b", "c"]) {
      const r = rect(id);
      expect(r.getAttribute("tabindex")).toBe("0");
      expect(r.getAttribute("role")).toBe("button");
    }
    expect(rect("b").getAttribute("aria-label")).toBe("Beta store: show details");
    expect(document.querySelector('rect[data-node="ext"]')!.getAttribute("tabindex")).toBe("0");
  });
  test("Enter on a focused box opens it; Close and Esc hand focus back to that box", () => {
    load();
    (rect("b") as SVGElement).focus();
    key(rect("b"), "Enter");
    expect(panel().hidden).toBe(false);
    expect(panel().querySelector("h2")!.textContent).toBe("Beta store");
    // A keyboard open moves focus into the panel — a non-modal dialog named by its heading.
    const heading = panel().querySelector("h2") as HTMLElement;
    expect(document.activeElement === heading).toBe(true);
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-modal")).toBe("false");
    expect(panel().getAttribute("aria-labelledby")).toBe(heading.id);
    const closeBtn = panel().querySelector("button") as HTMLButtonElement;
    closeBtn.focus(); // a keyboard user has tabbed into the panel
    expect(document.activeElement === closeBtn).toBe(true);
    closeBtn.click();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement === rect("b")).toBe(true); // booleans: a failing DOM diff is huge
    key(rect("a"), " ");
    expect(panel().querySelector("h2")!.textContent).toBe("Alpha core");
    (panel().querySelector("button") as HTMLButtonElement).focus();
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement === rect("a")).toBe(true);
  });
});

describe("panel — focus and what counts as a box (round 12)", () => {
  test("a mouse open does not move focus into the panel", () => {
    load();
    const before = document.activeElement;
    click(rect("b"));
    expect(panel().hidden).toBe(false);
    expect(document.activeElement === before).toBe(true);
  });
  test("only the box rects become focusable buttons, not another element carrying data-id", () => {
    load(trust(), model(), '<text id="decoy" data-id="b" x="0" y="0">decoy</text><g id="decoy2" data-node="ext"></g>');
    for (const d of ["decoy", "decoy2"]) {
      const e = document.getElementById(d)!;
      expect(e.hasAttribute("tabindex")).toBe(false);
      expect(e.hasAttribute("role")).toBe(false);
    }
    expect(rect("b").getAttribute("tabindex")).toBe("0");
  });
});
