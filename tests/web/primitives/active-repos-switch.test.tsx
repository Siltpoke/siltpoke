// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The Active Repos row's switch link.
 *
 * The panel listed every repo siltpoke had learned and offered no way to open
 * any of them — the rows expanded and collapsed, and `?repo=` (which every
 * other surface in this dashboard already honours) was wired to nothing here.
 *
 * Two of these tests exist because of a specific way to get this wrong.
 * `project_id` is already on the row and its first twelve characters have the
 * shape of a proj_hash; they are a different hash over a different input, and
 * in a real eleven-project store two of eleven disagreed. And the head this
 * link sits beside is a `role="button"` — putting the link inside it would
 * nest one control in another, which is a shape this dashboard has shipped and
 * had to undo twice.
 */
import { describe, expect, test } from "bun:test";
import { ActiveReposPanel, type ActiveRepoView } from "../../../src/web/primitives/ActiveReposPanel";
import { computeProjHash } from "../../../src/repo-graph/proj-hash";

function html(node: unknown): string {
  return String(node);
}

function view(name: string, root: string, projectId: string): ActiveRepoView {
  return {
    project_id: projectId,
    project_root: root,
    display_name: name,
    last_active_at: "2026-08-11T00:00:00Z",
    chat_count: 0,
    latest_summary: "",
    fact_count: 0,
    repo: null,
  };
}

const NOW = new Date("2026-08-11T12:00:00Z");

describe("ActiveReposPanel — switch link", () => {
  test("links to ?repo= computed from project_root, not to the project_id sitting on the row", () => {
    // A project_id whose first 12 chars are a plausible-looking hash: a
    // `.slice(0, 12)` implementation renders a link that looks entirely
    // ordinary and resolves to nothing.
    const misleadingId = "dc6bfda9c2c05613";
    const root = "/Users/x/Projects/other-repo";
    const out = html(
      ActiveReposPanel({
        activeProjects: [view("other-repo", root, misleadingId)],
        currentProjectId: "some-other-project",
        homeDir: "/Users/x",
        now: NOW,
        switchPath: "/memory",
      }),
    );

    expect(out).toContain(`href="/memory?repo=${computeProjHash(root)}"`);
    expect(out).not.toContain(`repo=${misleadingId.slice(0, 12)}`);
  });

  test("the link is a sibling of the expandable head, never nested inside it", () => {
    const out = html(
      ActiveReposPanel({
        activeProjects: [view("other-repo", "/Users/x/other", "id-other")],
        currentProjectId: "current",
        homeDir: "/Users/x",
        now: NOW,
        switchPath: "/memory",
      }),
    );

    // The head's clickable region ends before the link begins. Asserting on
    // the rendered order is what makes "not nested" checkable at all: a link
    // moved back inside the `role="button"` head would land BEFORE that div
    // closed, and every other assertion here would still pass.
    const headStart = out.indexOf('class="active-repos-head"');
    const linkStart = out.indexOf('class="active-repos-switch"');
    expect(headStart).toBeGreaterThan(-1);
    expect(linkStart).toBeGreaterThan(headStart);
    const between = out.slice(headStart, linkStart);
    // One `</div>` more than `<div` in the span between them = the head closed.
    const opens = between.split("<div").length - 1;
    const closes = between.split("</div>").length - 1;
    expect(closes).toBeGreaterThan(opens);
  });

  test("the repo you are already reading gets no switch link", () => {
    const out = html(
      ActiveReposPanel({
        activeProjects: [view("this-repo", "/Users/x/this", "id-this")],
        currentProjectId: "id-this",
        homeDir: "/Users/x",
        now: NOW,
        switchPath: "/memory",
      }),
    );
    expect(out).toContain("◉");
    expect(out).not.toContain("active-repos-switch");
  });

  test("every other repo gets one, and the current one is excluded from the set", () => {
    const out = html(
      ActiveReposPanel({
        activeProjects: [
          view("a", "/Users/x/a", "id-a"),
          view("b", "/Users/x/b", "id-b"),
          view("c", "/Users/x/c", "id-c"),
        ],
        currentProjectId: "id-b",
        homeDir: "/Users/x",
        now: NOW,
        switchPath: "/memory",
      }),
    );
    expect(out.split('class="active-repos-switch"')).toHaveLength(3);
    expect(out).not.toContain(`repo=${computeProjHash("/Users/x/b")}`);
  });

  test("the label names its object — a bare verb is what made the first reader ask what it did", () => {
    const out = html(
      ActiveReposPanel({
        activeProjects: [view("other-repo", "/Users/x/other", "id-other")],
        currentProjectId: "current",
        homeDir: "/Users/x",
        now: NOW,
        switchPath: "/memory",
      }),
    );
    expect(out).toContain("read this repo");
    expect(out).toContain("Point the dashboard at other-repo");
    // The bare verb as the link's whole text. Lowercased before comparing:
    // a review proved that `>Switch<` slipped straight past the case-sensitive
    // version of this line. It survived only because the two assertions above
    // happen to fail first — which makes this line's own claim (that it pins
    // the thing that failed) false, and would become a real hole the moment
    // this assertion were reused on its own.
    expect(out.toLowerCase()).not.toContain(">switch<");
  });

  test("a path that already carries a query string joins with & — not a second ?", () => {
    const root = "/Users/x/other";
    const out = html(
      ActiveReposPanel({
        activeProjects: [view("other", root, "id-other")],
        currentProjectId: "current",
        homeDir: "/Users/x",
        now: NOW,
        switchPath: "/knowledge?doc=x",
      }),
    );
    // `&amp;` — hono/jsx escapes the separator into the attribute, which is
    // what a browser reads back as a single `&`.
    expect(out).toContain(`href="/knowledge?doc=x&amp;repo=${computeProjHash(root)}"`);
    expect(out).not.toContain("?doc=x?repo=");
  });

  test("a caller that names no path gets no switch links, rather than links to a guessed one", () => {
    // The first draft hardcoded `/`, on the assumption that this panel lived on
    // the dashboard home. It lives on `/memory`, so every switch threw the
    // reader off the page they were reading. A caller that has not said where
    // the switch should land gets no switch.
    const out = html(
      ActiveReposPanel({
        activeProjects: [view("other", "/Users/x/other", "id-other")],
        currentProjectId: "current",
        homeDir: "/Users/x",
        now: NOW,
      }),
    );
    expect(out).not.toContain("active-repos-switch");
    expect(out).toContain("other");
  });
});
