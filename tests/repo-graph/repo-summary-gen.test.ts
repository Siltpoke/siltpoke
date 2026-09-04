import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSummaryContext,
  parseSummaryOutput,
  writeRepoSummary,
  repoSummaryPath,
  type RepoSummaryRecord,
} from "../../src/repo-graph/repo-summary-gen";
import { anchoredRepoRoot, foreignRepoRoot, cleanupArchRepoRoots } from "../_shared/arch-repo-root";

afterAll(cleanupArchRepoRoots);

describe("buildSummaryContext", () => {
  test("assembles repo name + layers + component descriptions from an arch-model", () => {
    const ctx = buildSummaryContext({
      boundary: { value: "siltpoke", evidence: [] },
      bands: [{ label: { value: "Surfaces" } }, { label: { value: "LLM Orchestration" } }],
      nodes: [
        { title: { value: "Daemon" }, desc: { value: "Hono HTTP server" } },
        { title: { value: "Critic" }, desc: { value: "rubric + Brain review" } },
      ],
    }, null);
    expect(ctx).toContain("Repo name: siltpoke");
    expect(ctx).toContain("Architecture layers: Surfaces, LLM Orchestration");
    expect(ctx).toContain("- Daemon: Hono HTTP server");
    expect(ctx).toContain("- Critic: rubric + Brain review");
  });

  test("tolerates a component with no description (title only)", () => {
    const ctx = buildSummaryContext({ boundary: { value: "x" }, nodes: [{ title: { value: "Utils" } }] }, null);
    expect(ctx).toContain("- Utils");
    expect(ctx).not.toContain("- Utils:");
  });

  test("degrades to 'unknown' name + empty sections on a malformed arch-model", () => {
    const ctx = buildSummaryContext({ junk: true }, null);
    expect(ctx).toContain("Repo name: unknown");
    expect(ctx).toContain("Architecture layers: ");
  });

  test("out-of-scope reviewer externals never reach the paid prompt", () => {
    // The prompt is what Siltpoke pays to send. A model generated before the
    // repo scope existed still carries these nodes on disk, so the filter has
    // to run here — not only where the diagram is rendered.
    const model = {
      boundary: { value: "some-travel-app" },
      nodes: [
        { title: { value: "Search Agent" }, desc: { value: "finds flights" } },
        {
          kind: "ext", provenance: "registry-declared", externalFamily: "qoder",
          title: { value: "Qoder CLI" },
          desc: { value: "External review CLI (registry-declared; reachability unverified)" },
        },
      ],
    };
    const ctx = buildSummaryContext(model, foreignRepoRoot());
    expect(ctx).toContain("- Search Agent: finds flights");
    expect(ctx).not.toContain("Qoder");
  });

  test("a repo that carries the registry anchor keeps its reviewer externals", () => {
    const model = {
      boundary: { value: "siltpoke" },
      nodes: [
        { kind: "ext", provenance: "registry-declared", externalFamily: "qoder", title: { value: "Qoder CLI" } },
      ],
    };
    expect(buildSummaryContext(model, anchoredRepoRoot())).toContain("Qoder CLI");
  });
});

describe("parseSummaryOutput", () => {
  test("extracts a trimmed summary string", () => {
    expect(parseSummaryOutput({ summary: "  A local AI pet.  " })).toBe("A local AI pet.");
  });
  test("throws on missing summary field", () => {
    expect(() => parseSummaryOutput({ notSummary: "x" })).toThrow();
  });
  test("throws on empty/whitespace summary", () => {
    expect(() => parseSummaryOutput({ summary: "   " })).toThrow();
  });
  test("throws on non-object", () => {
    expect(() => parseSummaryOutput("just a string")).toThrow();
  });
});

describe("writeRepoSummary / repoSummaryPath", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-sumgen-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("writes repo-summary.json under the project's repo-memory dir", () => {
    const record: RepoSummaryRecord = {
      text: "A local AI coding companion.",
      model: "claude-haiku-4-5",
      generated_ts: "2026-06-28T12:00:00Z",
      cost_usd: 0.0012,
    };
    writeRepoSummary(home, "/code/demo", record);
    const path = repoSummaryPath(home, "/code/demo");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
  });
});
