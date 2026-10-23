// The clickable half of the single-file HTML export (spec §8), running inside the
// exported file. Click a box → a side panel with the group's description, folders
// with coverage, and its edges with their evidence; Esc or a click elsewhere
// closes it; "Save as image" rasterizes the page's own SVG. Every string that
// came from the map is written with textContent, never innerHTML (AI prose can
// carry injected markup). Bundled on its own — see scripts/build-client.ts.
import type { TrustMap, TrustSource } from "../../../repo-graph/trust-map";
import type { ListedEdge } from "./edge-list";
import { exportFileName } from "./file-name";
import { placePanel } from "./panel-place";
import { renderPng } from "./render-png";

/** An outside-system or person box: no folders, just what the model says it is. */
interface OtherNode {
  id: string;
  kind: string;
  title: string;
  desc: string;
}
type Island = Pick<TrustMap, "containers"> & { source: TrustSource; edges: ListedEdge[]; nodes?: OtherNode[] };
type Container = Island["containers"][number];
type Edge = ListedEdge;

function node<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** The evidence in plain words (F4): what backs this edge, as a person would say it. */
function evidenceText(e: Edge): string {
  const ev = e.evidence;
  if (ev.kind === "import") return `${ev.count} import${ev.count === 1 ? "" : "s"}`;
  if (ev.kind === "cited") return `cited ${ev.file}:${ev.line}`;
  if (ev.reason === "citation-stale") return "the cited line is no longer in the code";
  return "no evidence recorded";
}

/** One connection, read like the image's key: `6  Daemon → Repo Graph — uses`, then its evidence. */
function connection(doc: Document, e: Edge, name: (id: string) => string): HTMLLIElement {
  const li = node(doc, "li");
  const verb = e.verb.trim();
  const head = `${e.n !== undefined ? `${e.n}  ` : ""}${name(e.source)} → ${name(e.target)}${verb ? ` — ${verb}` : ""}`;
  li.append(node(doc, "span", head, "conn"), node(doc, "span", `Evidence: ${evidenceText(e)}`, "evidence"));
  return li;
}

/** "Incoming (N)" / "Outgoing (N)", each row in number order; an empty side says so. */
function connections(doc: Document, panel: HTMLElement, sides: Array<[string, Edge[]]>, name: (id: string) => string): void {
  for (const [title, rows] of sides) {
    panel.append(node(doc, "h3", `${title} (${rows.length})`));
    if (rows.length === 0) panel.append(node(doc, "p", "(none)", "note"));
    else {
      const ul = node(doc, "ul", undefined, "conns");
      for (const e of [...rows].sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity))) ul.append(connection(doc, e, name));
      panel.append(ul);
    }
  }
}

function folderText(c: Container["folders"][number]): string {
  return c.listed === null ? c.folder : `${c.folder} · AI listed ${c.listed} of ${c.total} files`;
}

function list(doc: Document, items: string[], cls?: string): HTMLUListElement {
  const ul = node(doc, "ul");
  for (const t of items) ul.append(node(doc, "li", t, cls));
  return ul;
}

const KIND_NOTE: Record<string, string> = { ext: "Outside the system.", person: "A person." };

function fillPanel(doc: Document, panel: HTMLElement, island: Island, id: string, onClose: () => void): void {
  const c = island.containers.find((x) => x.id === id);
  const other = island.nodes?.find((x) => x.id === id);
  const name = (i: string): string => island.containers.find((x) => x.id === i)?.title ?? island.nodes?.find((x) => x.id === i)?.title ?? i;
  panel.replaceChildren();
  const title = node(doc, "h2", c?.title ?? other?.title ?? id);
  title.id = "panel-title"; // names the panel (aria-labelledby); focus lands here on a keyboard open
  title.tabIndex = -1;
  panel.append(title);
  if (c) panel.append(node(doc, "p", c.desc), node(doc, "p", "AI-written, unverified.", "note"));
  if (other) {
    if (other.desc) panel.append(node(doc, "p", other.desc));
    panel.append(node(doc, "p", `${KIND_NOTE[other.kind] ?? ""} AI-written, unverified.`.trim(), "note"));
  }
  if (c?.folders.length) panel.append(node(doc, "h3", "Folders"), list(doc, c.folders.map(folderText), "mono"));
  if (c?.listedFiles.length) panel.append(node(doc, "h3", "Files the AI listed"), list(doc, c.listedFiles, "mono"));
  // A self-edge is one connection: listed once, under Outgoing.
  const incoming = island.edges.filter((e) => e.target === id && e.source !== id);
  const outgoing = island.edges.filter((e) => e.source === id);
  connections(doc, panel, [["Incoming", incoming], ["Outgoing", outgoing]], name);
  const close = node(doc, "button", "Close");
  close.type = "button";
  close.addEventListener("click", onClose);
  panel.append(close);
  panel.hidden = false;
}

function readIsland(doc: Document): Island | null {
  try {
    return JSON.parse(doc.getElementById("trust")?.textContent ?? "") as Island;
  } catch {
    return null;
  }
}

function boxId(t: EventTarget | null): string | null {
  const el = t instanceof Element ? t.closest("[data-id],[data-node],[data-for]") : null;
  return el ? (el.getAttribute("data-id") ?? el.getAttribute("data-node") ?? el.getAttribute("data-for")) : null;
}

async function saveImage(doc: Document, svgSource: string, w: number, h: number, source: TrustSource): Promise<void> {
  const { blob } = await renderPng(svgSource, w, h);
  const url = URL.createObjectURL(blob);
  const a = doc.createElement("a");
  a.href = url;
  a.download = exportFileName(source, new Date(), "png");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The box rects only: a group's (data-id) or an outside / person box's (data-node). Nothing
 * else that happens to carry one of those attributes is made focusable or treated as a box. */
const BOXES = "rect[data-id],rect[data-node]";
const boxKey = (r: Element): string => r.getAttribute("data-id") ?? r.getAttribute("data-node") ?? "";

function boxEl(svg: Element, id: string): Element | null {
  return Array.from(svg.querySelectorAll(BOXES)).find((r) => boxKey(r) === id) ?? null;
}

const isNarrow = (doc: Document, panel: HTMLElement): boolean => doc.defaultView?.getComputedStyle(panel).position !== "fixed";

/** Put the open panel level with `box`: in a wide window it is fixed beside the map, so it stays in
 * view; re-run on scroll it tracks the box while it is on screen and clamps at the window's edge.
 * Where it stacks under the map (narrow window) it is only scrolled into view when `reveal`. */
function placeBeside(doc: Document, panel: HTMLElement, box: Element | null, reveal: boolean): void {
  const win = doc.defaultView;
  if (!win || !box) return;
  for (const k of ["top", "left", "right", "maxHeight"] as const) panel.style[k] = "";
  if (isNarrow(doc, panel)) {
    if (reveal) panel.scrollIntoView?.({ block: "nearest" });
    return;
  }
  const at = placePanel(box.getBoundingClientRect().top, panel.offsetHeight, win.innerHeight);
  panel.style.top = `${at.top}px`;
  // Beside the map's right edge (the map may be narrower than the window), never off-screen.
  const map = doc.getElementById("map")?.getBoundingClientRect();
  if (map) {
    panel.style.left = `${Math.max(0, Math.min(map.right + 16, win.innerWidth - panel.offsetWidth - 16))}px`;
    panel.style.right = "auto";
  }
  if (at.maxHeight !== null) panel.style.maxHeight = `${at.maxHeight}px`;
}

/** Every box can be reached and opened from the keyboard: a button named after its title. */
function focusableBoxes(svg: Element, island: Island): void {
  const title = (id: string): string => island.containers.find((c) => c.id === id)?.title ?? island.nodes?.find((n) => n.id === id)?.title ?? id;
  for (const r of Array.from(svg.querySelectorAll(BOXES))) {
    r.setAttribute("tabindex", "0");
    r.setAttribute("role", "button");
    r.setAttribute("aria-label", `${title(boxKey(r))}: show details`);
  }
}

/** Keep the open panel beside its box as the page scrolls or the window resizes (one placement per
 * frame). A resize that crosses into the narrow, stacked layout scrolls the panel into view once;
 * later resizes there (a phone's address bar) do not yank the page. */
function follow(doc: Document, panel: HTMLElement, currentBox: () => Element | null): void {
  const win = doc.defaultView;
  if (!win) return;
  let queued = false;
  let narrow = isNarrow(doc, panel);
  const place = (fromResize: boolean): void => {
    const box = currentBox();
    if (!box || panel.hidden) return;
    const nowNarrow = isNarrow(doc, panel);
    placeBeside(doc, panel, box, fromResize && nowNarrow && !narrow);
    narrow = nowNarrow;
  };
  const schedule = (fromResize: boolean): void => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(() => {
      queued = false;
      place(fromResize);
    });
  };
  win.addEventListener("scroll", () => schedule(false), { passive: true });
  win.addEventListener("resize", () => schedule(true), { passive: true });
}

/** A non-modal dialog named by its heading; focus moves in only when the keyboard opened it. */
function asDialog(panel: HTMLElement): void {
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "panel-title");
}

/** Wire the page. `doc` is the exported document (a test passes its own). */
export function mountHtmlPanel(doc: Document): void {
  const island = readIsland(doc);
  const svg = doc.querySelector("#map svg");
  const panel = doc.getElementById("panel");
  if (!island || !svg || !panel) return;
  // Serialized BEFORE any highlight or tabindex is added: the saved image is the export as built.
  const svgSource = new XMLSerializer().serializeToString(svg);
  const w = Number(svg.getAttribute("width"));
  const h = Number(svg.getAttribute("height"));
  focusableBoxes(svg, island);
  asDialog(panel);
  let opener: Element | null = null;
  let openId: string | null = null;
  const select = (id: string | null, focus: "none" | "box" | "panel" = "none"): void => {
    svg.querySelectorAll("[data-selected]").forEach((r) => {
      r.removeAttribute("data-selected");
    });
    doc.body.classList.toggle("panel-open", id !== null);
    if (id === null) {
      panel.hidden = true;
      if (focus === "box") (opener as SVGElement | null)?.focus?.(); // Close / Esc: back to the box that opened it
      openId = null;
      return;
    }
    openId = id;
    opener = boxEl(svg, id);
    opener?.setAttribute("data-selected", "");
    fillPanel(doc, panel, island, id, () => select(null, "box"));
    placeBeside(doc, panel, opener, true);
    if (focus === "panel") (panel.querySelector("#panel-title") as HTMLElement | null)?.focus();
  };
  const known = (id: string | null): id is string =>
    id !== null && (island.containers.some((c) => c.id === id) || !!island.nodes?.some((n) => n.id === id));
  svg.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const id = boxId(ev.target);
    // Every box has a panel: groups, and the outside-system / person boxes the island lists. A
    // mouse open leaves focus where it is.
    select(known(id) ? id : null);
  });
  // Enter or Space on a focused box opens it, like a click, and moves focus into the panel.
  svg.addEventListener("keydown", (ev) => {
    const id = boxId(ev.target);
    if (((ev as KeyboardEvent).key !== "Enter" && (ev as KeyboardEvent).key !== " ") || !known(id)) return;
    ev.preventDefault();
    select(id, "panel");
  });
  follow(doc, panel, () => (openId === null ? null : boxEl(svg, openId)));
  doc.addEventListener("click", () => select(null));
  panel.addEventListener("click", (ev) => ev.stopPropagation());
  doc.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && openId !== null) select(null, "box");
  });
  wireSave(doc, svgSource, w, h, island.source);
}

/** "Save as image": rasterize the page's own SVG, as built. */
function wireSave(doc: Document, svgSource: string, w: number, h: number, source: TrustSource): void {
  const status = doc.getElementById("status");
  const say = (t: string): void => { if (status) status.textContent = t; };
  doc.getElementById("save-img")?.addEventListener("click", () => {
    say("Saving…");
    saveImage(doc, svgSource, w, h, source).then(
      () => say(""),
      (e: unknown) => say(`Save failed — ${e instanceof Error ? e.message : String(e)}`),
    );
  });
}
