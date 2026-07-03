import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "../../src/cli/report";

let tmp: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-report-"));
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const noon = new Date("2026-05-14T12:00:00Z");

test("buildReport: writes self-contained HTML to outPath", async () => {
  writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({ name: "Mochi", species: "cat", language: "en" }),
  );
  const outPath = join(homeBase, "report.html");
  const result = await buildReport({ homeBase, outPath, now: () => noon });
  expect(result.outPath).toBe(outPath);
  const html = readFileSync(outPath, "utf8");
  expect(html).toContain("<!doctype html>");
  expect(html).toContain("Mochi");
  expect(html).toContain("cat");
  expect(html).toContain("LAST 7 DAYS");
  expect(html).toContain("RECENT CALLS");
  // every right-column section is now collapsible via <details class="panel">
  expect(html).toContain("details class=\"panel\"");
});

test("buildReport: surfaces pending critiques per project", async () => {
  const project = join(tmp, "proj-x");
  const archive = join(project, ".siltpoke", "critiques", "archive", "2026-05-14");
  mkdirSync(archive, { recursive: true });
  const mdPath = join(archive, "c-rep1.md");
  writeFileSync(
    mdPath,
    `---\nschemaVersion: 1\ncritique_id: c-rep1\nstatus: pending\n---\nbody`,
  );
  writeFileSync(
    join(project, ".siltpoke", "critiques", "history.jsonl"),
    `${JSON.stringify({
      timestamp: noon.toISOString(),
      critique_id: "c-rep1",
      cwd: project,
      severity: "high",
      confidence: "high",
      bubble_short: "ship me",
      path: mdPath,
    })}\n`,
  );
  // Need a brain-calls row so the project is discovered.
  appendFileSync(
    join(homeBase, "brain-calls.jsonl"),
    `${JSON.stringify({ timestamp: noon.toISOString(), cwd: project })}\n`,
  );

  const outPath = join(homeBase, "report.html");
  const result = await buildReport({ homeBase, outPath, now: () => noon });
  expect(result.pendingTotal).toBe(1);
  expect(result.projectsTouched).toBe(1);
  const html = readFileSync(outPath, "utf8");
  expect(html).toContain("c-rep1");
  expect(html).toContain("ship me");
  expect(html).toContain("proj-x");
});

test("buildReport: escapes user-provided text into HTML safely", async () => {
  writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({ name: "<img src=x onerror=alert(1)>", species: "cat" }),
  );
  const outPath = join(homeBase, "report.html");
  await buildReport({ homeBase, outPath, now: () => noon });
  const html = readFileSync(outPath, "utf8");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

test("buildReport: empty state still produces a valid HTML doc", async () => {
  const outPath = join(homeBase, "report.html");
  const result = await buildReport({ homeBase, outPath, now: () => noon });
  expect(result.pendingTotal).toBe(0);
  expect(result.projectsTouched).toBe(0);
  const html = readFileSync(outPath, "utf8");
  expect(html).toContain("</html>");
  expect(html).toContain("inbox clean");
});
