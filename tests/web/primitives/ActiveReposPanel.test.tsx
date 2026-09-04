/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { ActiveReposPanel, type ActiveRepoView } from "../../../src/web/primitives/ActiveReposPanel";
import type { RepoCard } from "../../../src/repo-graph/repo-card";

const NOW = new Date("2026-06-27T12:00:00Z");

function view(over: Partial<ActiveRepoView> & { project_id: string }): ActiveRepoView {
  return {
    project_id: over.project_id,
    project_root: over.project_root ?? "/Users/x/code/app",
    display_name: over.display_name ?? "app",
    last_active_at: over.last_active_at ?? "2026-06-27T09:00:00Z",
    chat_count: over.chat_count ?? 0,
    latest_summary: over.latest_summary ?? "",
    fact_count: over.fact_count ?? 0,
    repo: over.repo,
  };
}

function repo(over: Partial<RepoCard> = {}): RepoCard {
  return {
    files: over.files ?? 499,
    components: over.components ?? 23,
    indexed_at: over.indexed_at ?? "2026-06-23T09:00:00Z",
    areas: over.areas ?? ["Surfaces", "Server & UI"],
    component_titles: over.component_titles ?? ["Daemon", "Critic", "Brain"],
    // Use !== undefined so an explicit `summary_text: null` (no-summary case)
    // isn't collapsed back to the default by ??.
    summary_text: over.summary_text !== undefined ? over.summary_text : "A local AI coding companion.",
  };
}

describe("ActiveReposPanel", () => {
  test("honest empty state when no projects", () => {
    const html = String(
      <ActiveReposPanel activeProjects={[]} currentProjectId="" homeDir="/Users/x" now={NOW} />,
    );
    expect(html).toContain("Active Repos");
    expect(html).toContain("projects appear here as siltpoke learns them");
  });

  test("an indexed repo shows stats + an expandable repo-graph digest", () => {
    const html = String(
      <ActiveReposPanel
        activeProjects={[
          view({ project_id: "p1", display_name: "siltpoke", project_root: "/Users/x/code/siltpoke", repo: repo() }),
        ]}
        currentProjectId="p1"
        homeDir="/Users/x"
        now={NOW}
      />,
    );
    expect(html).toContain("siltpoke");
    expect(html).toContain("~/code/siltpoke");
    expect(html).toContain("499 files · 23 components · indexed 4d ago");
    expect(html).toContain('x-data="repoRow"');
    expect(html).toContain('data-project-root="/Users/x/code/siltpoke"');
    expect(html).toContain('role="button"');
    expect(html).toContain("A local AI coding companion.");
    expect(html).toContain("2 areas");
    expect(html).toContain("Surfaces");
    expect(html).toContain("23 components");
    expect(html).toContain("Daemon");
  });

  test("renders every component chip with no truncation", () => {
    const titles = Array.from({ length: 20 }, (_, i) => `Comp${i}`);
    const html = String(
      <ActiveReposPanel
        activeProjects={[view({ project_id: "p1", repo: repo({ components: 20, component_titles: titles }) })]}
        currentProjectId=""
        homeDir="/Users/x"
        now={NOW}
      />,
    );
    expect(html).toContain("Comp0");
    expect(html).toContain("Comp19"); // last chip shown — nothing hidden
    expect(html).not.toContain("more"); // no "+N more" affordance
    expect(html).not.toContain('x-show="showAll"');
  });

  test("a never-indexed repo shows 'not indexed' and is not expandable", () => {
    const html = String(
      <ActiveReposPanel
        activeProjects={[view({ project_id: "p1", display_name: "scratch", repo: null })]}
        currentProjectId=""
        homeDir="/Users/x"
        now={NOW}
      />,
    );
    expect(html).toContain("not indexed");
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('x-show="open"');
  });

  test("an indexed repo with no summary yet still expands to areas/components", () => {
    const html = String(
      <ActiveReposPanel
        activeProjects={[view({ project_id: "p1", repo: repo({ summary_text: null }) })]}
        currentProjectId=""
        homeDir="/Users/x"
        now={NOW}
      />,
    );
    expect(html).toContain('role="button"'); // still expandable (areas/components present)
    expect(html).toContain("2 areas");
    // offers an on-demand generate affordance + empty data-summary
    expect(html).toContain("✨ Generate summary");
    expect(html).toContain('x-on:click="generate()"');
    expect(html).toContain('data-summary=""');
  });

  test("an indexed repo with no arch-model + no summary is now expandable with a generate hint", () => {
    // Structural-index-only repo (fresh /siltpoke-index): no areas,
    // no components, no summary. Must still expand + offer generate + show the
    // honest hint, and must NOT render empty areas/components chip sections.
    const html = String(
      <ActiveReposPanel
        activeProjects={[
          view({
            project_id: "p1",
            display_name: "fresh",
            repo: repo({ areas: [], component_titles: [], components: 0, summary_text: null }),
          }),
        ]}
        currentProjectId=""
        homeDir="/Users/x"
        now={NOW}
      />,
    );
    expect(html).toContain('role="button"'); // now expandable
    expect(html).toContain("Structural index only"); // honest hint
    expect(html).toContain("✨ Generate summary"); // generate offered
    expect(html).toContain('x-on:click="generate()"');
    // empty areas/components sections omitted (chip classes absent)
    expect(html).not.toContain("ar-chip-area");
    expect(html).not.toContain('class="mono ar-chip"');
  });

  test("marks the current project active with a filled marker", () => {
    const html = String(
      <ActiveReposPanel
        activeProjects={[
          view({ project_id: "cur", display_name: "current", repo: repo() }),
          view({ project_id: "other", display_name: "other", repo: repo() }),
        ]}
        currentProjectId="cur"
        homeDir="/Users/x"
        now={NOW}
      />,
    );
    expect(html).toContain("· active");
    expect(html).toContain("◉");
    expect(html).toContain("○");
  });
});
