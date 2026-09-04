// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * "switch" — the Active Repos row's link to read a different project.
 *
 * Split out of `ActiveReposPanel.tsx` rather than written inline: adding it
 * there put that file at 403 lines, one past the 400-LOC ratchet, and the
 * panel's row callback is already the most complex function in the file.
 *
 * `?repo=` on the page the reader is already on, which is what every other
 * consumer of that param already means by it: read this project. The daemon
 * persists the choice as its pin, so the rest of the dashboard follows — this
 * row was the one place that listed the repos without offering to open any of
 * them.
 *
 * `path` is passed in rather than hardcoded. The first draft linked to `/`,
 * on the assumption that the panel lived on the dashboard home; it lives on
 * `/memory`, so every switch would have thrown the reader off the page they
 * were reading to answer a question they asked about that page. The caller
 * knows where it is mounted; this component does not get to guess.
 *
 * The hash is recomputed from `project_root`. `project_id` is RIGHT THERE on
 * the row and its first twelve characters look like a proj_hash, but they are
 * a different hash over a different input (the project's INITIAL path) — in a
 * real eleven-project store two of them disagreed, and those two rows would
 * have linked nowhere.
 *
 * The caller renders this as a SIBLING of the expandable row head, never
 * inside it: that head carries `role="button"`, and a link nested in a button
 * is a shape this dashboard has shipped and had to undo twice. A `.stop`
 * modifier would suppress the double-fire while leaving the nesting intact.
 *
 * The label reads "read this repo", not "switch". The first version said
 * "switch" and the first person to see it asked what it meant — a verb with no
 * object, next to eight other rows, does not say switch WHAT or to WHERE. The
 * longer label is the whole affordance: what happens is that the dashboard
 * starts reading that repo.
 */
import { computeProjHash } from "../../repo-graph/proj-hash";
import { tokens } from "../tokens/tokens";

export interface ActiveRepoSwitchLinkProps {
  projectRoot: string;
  displayName: string;
  /** The path this panel is mounted on — the switch stays on it. */
  path: string;
}

export function ActiveRepoSwitchLink({ projectRoot, displayName, path }: ActiveRepoSwitchLinkProps) {
  const hash = computeProjHash(projectRoot);
  // `?` or `&` depending on what `path` already carries — the same join
  // `src/web/client/islands/repo-graph.ts` uses for its own `?repo=`. Today's
  // one caller passes a bare `/memory`, so a naive `?` would work; the second
  // caller to pass a path that already has a query string would produce
  // `...?doc=x?repo=...`, and would produce it silently.
  const sep = path.includes("?") ? "&" : "?";
  return (
    <a
      class="active-repos-switch"
      href={`${path}${sep}repo=${encodeURIComponent(hash)}`}
      data-active-repo-switch={hash}
      title={`Point the dashboard at ${displayName}`}
      style={{
        flexShrink: 0,
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color: tokens.color.tealInk,
        textDecoration: "none",
        border: `1px solid ${tokens.color.tealWashEdge}`,
        borderRadius: "5px",
        padding: "1px 7px",
        marginTop: "1px",
      }}
    >
      read this repo
    </a>
  );
}
