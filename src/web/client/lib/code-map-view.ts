/**
 * The bridge between the Code Map and the floating chat for things that
 * CANNOT be pinned (defect [44]).
 *
 * A file or a function is a graph node: the chat pins to it and the server
 * sends its source (`window.__siltpokeViewedNode`, see repo-graph.ts
 * `publishViewed`). A component box on the architecture view, or a folder, is
 * not a node. Selecting one used to publish nothing, so the chat knew only
 * that the user was on "Repo Graph" — and never which repository.
 *
 * This is the second channel: the page writes what is open to a window global
 * and the chat sends it with each message of an unpinned conversation. Same
 * pull model as the node bridge (a plain global plus the shared
 * `siltpoke:viewed-changed` event), for the same reason: the two islands are
 * mounted separately and one of them survives navigation.
 */

export interface CodeMapSelectionPayload {
  kind: "component" | "folder";
  title: string;
  tech?: string;
  description?: string;
  pieces?: Array<{ name: string; description: string }>;
  talksTo?: string[];
  calledBy?: string[];
  files?: string[];
}

export interface CodeMapViewPayload {
  repo: string;
  selection: CodeMapSelectionPayload | null;
  /** The open project's hash — chat runs there and may read it. */
  proj_hash?: string;
}

/** A component box on the architecture view, as the chat is told about it. */
export function componentSelection(
  n: { title: string; tech?: string; desc?: string; comp?: Array<[string, string]>; memberFiles?: string[] },
  talksTo: string[],
  calledBy: string[],
): CodeMapSelectionPayload {
  return {
    kind: "component",
    title: n.title,
    tech: n.tech,
    description: n.desc,
    pieces: (n.comp ?? []).map(([name, description]) => ({ name, description })),
    talksTo,
    calledBy,
    files: n.memberFiles,
  };
}

/** A source folder, as the chat is told about it. */
export function folderSelection(
  title: string,
  description: string,
  talksTo: string[],
  calledBy: string[],
  files: string[],
): CodeMapSelectionPayload {
  return { kind: "folder", title, description, talksTo, calledBy, files };
}

/**
 * The repo to name to the chat: only one that has a graph. With nothing
 * indexed the page still knows the folder it looks at, and naming it made the
 * chip read "Code Map · siltpoke" over an empty page.
 */
export function viewedRepoName(proj: { repo?: { name?: string }; subdirs?: unknown[] }): string {
  return (proj.subdirs?.length ?? 0) > 0 ? (proj.repo?.name ?? "") : "";
}

type Holder = { __siltpokeCodeMapView?: CodeMapViewPayload | null };

/** The page's side: say what is open. `null` = not on the Code Map any more. */
export function publishCodeMapView(view: CodeMapViewPayload | null): void {
  if (typeof window === "undefined") return;
  (window as unknown as Holder).__siltpokeCodeMapView = view;
  window.dispatchEvent(new CustomEvent("siltpoke:viewed-changed"));
}

/** The chat's side: what the page last said is open. */
export function readCodeMapView(): CodeMapViewPayload | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as Holder).__siltpokeCodeMapView ?? null;
}

/**
 * The `view` field of a chat request, or nothing: only an UNPINNED
 * conversation sends it (a pinned one discusses its node), and only while the
 * user is still on the Code Map — the chat outlives navigation and nothing
 * tells it the page changed.
 */
export function viewField(
  pinned: boolean,
  view: CodeMapViewPayload | null,
  onGraph: boolean,
): { view?: CodeMapViewPayload } {
  return !pinned && view && onGraph ? { view } : {};
}

/**
 * The page chip in the chat's context bar: the page label, then the repository
 * and the selected component when the Code Map has named them.
 * "Repo Graph" → "Repo Graph · siltpoke · Brain".
 */
export function viewChip(pageLabel: string, view: CodeMapViewPayload | null): string {
  if (!view) return pageLabel;
  return [pageLabel, view.repo, view.selection?.title ?? ""].filter((s) => s !== "").join(" · ");
}

/**
 * Is the node the user is viewing the one this conversation is pinned to?
 *
 * `anchorNodeId` is the server's canonical id (`type:path:name`), known once
 * the create or re-anchor call returned it. A trace view carries a node id and
 * compares directly. Everywhere else the page has a descriptor, so both the
 * path and the name have to match, each between colons: `:${name}` so "Fn"
 * does not match "myFn", `:${path}:` so `src/foo` does not match
 * `src/fooBar.ts`.
 */
export function viewedMatchesAnchor(
  viewed: { target: { node_id: string } | { name: string; path: string } },
  anchorNodeId: string,
): boolean {
  const t = viewed.target;
  if ("node_id" in t) return t.node_id === anchorNodeId;
  return anchorNodeId.endsWith(`:${t.name}`) && anchorNodeId.includes(`:${t.path}:`);
}
