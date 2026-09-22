/**
 * Smoke tests for critique permalink routes
 *
 * GET /api/critiques/:id  → 401 without auth, 404 for unknown id, 200 for known
 * GET /critique/:id       → 404 HTML for unknown id, 200 HTML for known
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { mountCritiqueRoutes } from "../../src/daemon/routes/critique.tsx";

const CRITIQUE_MD = `---
schemaVersion: 1
timestamp: 2026-05-20T12:00:00.000Z
critique_id: c-test
session_id: sess-abc
cwd: /home/user/project
mood: neutral
pose: sit
severity: high
confidence: high
status: pending
---

# [SILTPOKE CRITIQUE]

## Bubble (user-facing)

Missing await on async call.

## Critique (for Claude, if forwarded)

\`\`\`
Move the await to the call site.
\`\`\`

## Severity / Confidence

severity: high
confidence: high
`;

// An empty critique writes NO fence — just a sentence (defect [15],
// `renderCritiqueSection` in src/state/critique.ts). The Evidence section
// below it is fenced, so a fence scan that is not bounded to this section
// walks straight into it and reports a diff snippet as the reviewer's
// critique. That is what this file's second fixture pins.
const EMPTY_CRITIQUE_MD = `---
schemaVersion: 1
timestamp: 2026-05-20T12:30:00.000Z
critique_id: c-empty
session_id: sess-abc
cwd: /home/user/project
mood: happy
pose: sit
severity: info
confidence: high
evidence_label: verified
status: pending
---

# [SILTPOKE CRITIQUE]

## Bubble (user-facing)

Looks clean.

## Critique (for Claude, if forwarded)

The reviewer had no actionable concerns this round, so there is nothing to forward. This is a clean review, not a failed one.

## Severity / Confidence

severity: info
confidence: high

## Evidence

label: verified

### Confirmed

- \`src/queries.py:47\` (git-diff)

\`\`\`
INNER JOIN profiles ON u.id = p.user_id
\`\`\`
`;

// A critique whose OWN body contains a `## ` line. Reviewers write markdown
// headings inside their critiques routinely — this shape is live in the archive
// (`.siltpoke/critiques/archive/2026-09-01/c-1e0c.md`, 1,477 chars). A fence
// scan that treats an in-fence `## ` as a section boundary loses the closing
// fence and serves the whole critique as blank.
const INNER_HEADING_MD = `---
schemaVersion: 1
timestamp: 2026-05-20T12:45:00.000Z
critique_id: c-inner
session_id: sess-abc
cwd: /home/user/project
mood: annoyed
pose: arms_crossed
severity: medium
confidence: high
status: pending
---

# [SILTPOKE CRITIQUE]

## Bubble (user-facing)

Two findings.

## Critique (for Claude, if forwarded)

\`\`\`
## Output shape regression

src/eval/run.ts:196 — the summarize loop now skips absent groups.

## Budget validation missing

src/eval/run.ts:267 — maxUsd is parsed but never checked.
\`\`\`

## Severity / Confidence

severity: medium
confidence: high

## Evidence

label: no_evidence
`;

let homeBase: string;
const SECRET = "test-secret-abc";

beforeEach(async () => {
  homeBase = join(tmpdir(), `critique-route-test-${randomUUID()}`);
  const archiveDir = join(homeBase, "critiques", "archive", "2026-05-20");
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, "c-test.md"), CRITIQUE_MD, "utf8");
  await writeFile(join(archiveDir, "c-empty.md"), EMPTY_CRITIQUE_MD, "utf8");
  await writeFile(join(archiveDir, "c-inner.md"), INNER_HEADING_MD, "utf8");
});

function buildApp(): Hono {
  const app = new Hono();
  mountCritiqueRoutes(app, { homeBase, secret: SECRET });
  return app;
}

describe("GET /api/critiques/:id", () => {
  test("returns 401 without auth when secret is set", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-test");
    expect(res.status).toBe(401);
  });

  test("returns 404 for unknown id with valid auth", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-unknown", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(404);
  });

  test("returns 200 JSON for known id with valid auth", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-test", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { critique: { id: string }; trace_ids: string[] };
    };
    expect(json.success).toBe(true);
    expect(json.data.critique.id).toBe("c-test");
    expect(Array.isArray(json.data.trace_ids)).toBe(true);
  });

  test("an unfenced (empty) critique does not pick up the Evidence snippet", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-empty", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const json = (await res.json()) as {
      data: { critique: { critique_for_claude?: string; severity: string } };
    };
    // Positive control: the file IS being parsed, so an absent critique below
    // is a real absence and not a failed read.
    expect(json.data.critique.severity).toBe("info");
    expect(json.data.critique.critique_for_claude).toBeUndefined();
  });

  test("a critique whose body contains a `## ` line survives intact", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-inner", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const json = (await res.json()) as {
      data: { critique: { critique_for_claude?: string } };
    };
    const body = json.data.critique.critique_for_claude ?? "";
    // Both halves of the fenced block, i.e. the parser did not stop at the
    // in-fence heading — and did not stop at the FIRST one either.
    expect(body).toContain("## Output shape regression");
    expect(body).toContain("## Budget validation missing");
    expect(body).toContain("maxUsd is parsed but never checked");
    // …and it did not run past its own closing fence into the next section.
    expect(body).not.toContain("severity: medium");
    expect(body).not.toContain("label: no_evidence");
  });

  test("JSON includes severity from frontmatter", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-test", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const json = (await res.json()) as { data: { critique: { severity: string } } };
    expect(json.data.critique.severity).toBe("high");
  });
});

describe("GET /critique/:id", () => {
  test("returns 404 HTML for unknown critique", async () => {
    const app = buildApp();
    const res = await app.request("/critique/c-missing");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("c-missing");
  });

  test("returns 200 HTML for known critique", async () => {
    const app = buildApp();
    const res = await app.request("/critique/c-test");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("c-test");
  });

  test("rendered page contains critique_for_claude body", async () => {
    const app = buildApp();
    const res = await app.request("/critique/c-test");
    const body = await res.text();
    expect(body).toContain("Move the await to the call site");
  });

  test("rendered page contains severity from frontmatter", async () => {
    const app = buildApp();
    const res = await app.request("/critique/c-test");
    const body = await res.text();
    expect(body).toContain("high");
  });
});

describe("the route reads data when data is there, and prose when it is not", () => {
  test("findings come from the sidecar, not from matching headings in prose", async () => {
    const archiveDir = join(homeBase, "critiques", "archive", "2026-05-20");
    await writeFile(
      join(archiveDir, "c-sidecar.md"),
      CRITIQUE_MD.replace("c-test", "c-sidecar"),
      "utf8",
    );
    await writeFile(
      join(archiveDir, "c-sidecar.json"),
      JSON.stringify({
        schemaVersion: 1,
        critique_id: "c-sidecar",
        brain_output: {
          mood: "concerned",
          pose: "base",
          bubble_short: "b",
          bubble_long: "",
          critique_for_claude: "the real prose, straight from the record",
          severity: "medium",
          confidence: "high",
          xp_earned_events: [],
          evidence: [],
          findings: [
            {
              title: "rate applied before tax",
              body: "why it matters",
              severity: "medium",
              file: "src/pay.ts",
              quote: "const total = subtotal * rate;",
            },
          ],
        },
      }),
      "utf8",
    );

    const app = new Hono();
    mountCritiqueRoutes(app, { homeBase, secret: "" });
    const res = await app.request("/api/critiques/c-sidecar");
    const body = (await res.json()) as {
      data: { critique: { findings: { id: string; quote: string }[]; critique_for_claude?: string } };
    };

    expect(body.data.critique.findings).toHaveLength(1);
    expect(body.data.critique.findings[0]?.id).toBe("f1");
    expect(body.data.critique.findings[0]?.quote).toBe("const total = subtotal * rate;");
    // The prose comes from the record too, not from a fence the parser found.
    expect(body.data.critique.critique_for_claude).toBe("the real prose, straight from the record");
  });

  /**
   * The route's cast widened to `PersistedFinding` so the range and the tier
   * survive the trip off disk. `loadSidecar` is a bare `JSON.parse`, so they
   * are there at runtime either way — the narrower cast would have typed them
   * away on the one surface a human can look at them on.
   */
  test("a finding's derived range and tier survive the trip off disk", async () => {
    const archiveDir = join(homeBase, "critiques", "archive", "2026-05-20");
    await writeFile(
      join(archiveDir, "c-derived.md"),
      CRITIQUE_MD.replace("c-test", "c-derived"),
      "utf8",
    );
    await writeFile(
      join(archiveDir, "c-derived.json"),
      JSON.stringify({
        schemaVersion: 1,
        critique_id: "c-derived",
        brain_output: {
          critique_for_claude: "prose",
          findings: [
            {
              id: "f1",
              title: "rate applied before tax",
              body: "why it matters",
              severity: "medium",
              file: "src/pay.ts",
              quote: "const total = subtotal * rate;",
              quote_tier: "strong",
              range_source: "hunk",
              start_line: 41,
              end_line: 43,
            },
            {
              // Older sidecar shape: no tier, no range. Must come back bare.
              title: "older finding",
              body: "from before any of this",
              severity: "low",
              file: "src/old.ts",
              quote: "const legacy = true;",
            },
          ],
        },
      }),
      "utf8",
    );

    const app = new Hono();
    mountCritiqueRoutes(app, { homeBase, secret: "" });
    const res = await app.request("/api/critiques/c-derived");
    type F = { id: string; quote_tier?: string; range_source?: string; start_line?: number; end_line?: number };
    const body = (await res.json()) as { data: { critique: { findings: F[] } } };

    const [derived, older] = body.data.critique.findings;
    expect(derived?.quote_tier).toBe("strong");
    expect(derived?.range_source).toBe("hunk");
    expect(derived?.start_line).toBe(41);
    expect(derived?.end_line).toBe(43);
    // Absent, not defaulted: nothing checked this one.
    expect(older?.quote_tier).toBeUndefined();
    expect(older?.start_line).toBeUndefined();
    // And it still got an id, because the route numbers what has none.
    expect(older?.id).toBe("f2");
  });

  test("a critique written before the sidecar existed still renders — nothing throws, findings are empty", async () => {
    const app = new Hono();
    mountCritiqueRoutes(app, { homeBase, secret: "" });
    const res = await app.request("/api/critiques/c-test");
    const body = (await res.json()) as {
      success: boolean;
      data: { critique: { findings: unknown[]; critique_for_claude?: string } };
    };

    expect(body.success).toBe(true);
    expect(body.data.critique.findings).toEqual([]);
    // AC9: the prose parse is still there and still the fallback that serves it.
    expect(body.data.critique.critique_for_claude).toBeTruthy();
  });
});
