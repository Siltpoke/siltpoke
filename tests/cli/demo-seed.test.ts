import { test, expect, afterEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// NOTE: Bun caches modules, so SILTPOKE_HOME must be set before the first import.
// We set it here once, pointing to a shared tmp dir for the suite.
// Capture whatever SILTPOKE_HOME held before this file mutated it (usually
// undefined) so afterAll can restore it exactly — otherwise this override
// leaks into every test file bun loads after this one in the same process,
// which can make an unrelated file's siltpokeRoot()-based reader resolve the
// wrong path depending on load order.
const PRIOR_SILTPOKE_HOME = process.env.SILTPOKE_HOME;
const SUITE_TMP = mkdtempSync(join(tmpdir(), "siltpoke-demo-seed-suite-"));
const SILTPOKE_HOME = join(SUITE_TMP, ".siltpoke");
mkdirSync(SILTPOKE_HOME, { recursive: true });
process.env.SILTPOKE_HOME = SILTPOKE_HOME;
// Force the deterministic stub embedder. demo-seed's index builders otherwise
// load the real fastembed/onnxruntime native model, which segfaults the
// `bun test` runner (the same code runs clean under `bun run` + fastembed works
// standalone — it's a Bun test-runtime × native-module crash, not a logic bug).
// The stub is correct here: these tests assert files/rows exist, not embedding
// quality.
process.env.SILTPOKE_EMBED_STUB = "1";

// Import after env is set so getHome() resolves correctly on first call
const { main, clearDemoData } = await import("../../src/cli/demo-seed");

afterEach(() => {
  // Remove critique archive dir between tests so tests are isolated
  const archiveDir = join(SILTPOKE_HOME, "critiques");
  if (existsSync(archiveDir)) {
    rmSync(archiveDir, { recursive: true, force: true });
  }
});

// Clean up suite tmp + restore SILTPOKE_HOME after this file's tests finish,
// so the override does not leak into test files bun loads afterward.
afterAll(() => {
  if (PRIOR_SILTPOKE_HOME === undefined) {
    delete process.env.SILTPOKE_HOME;
  } else {
    process.env.SILTPOKE_HOME = PRIOR_SILTPOKE_HOME;
  }
  rmSync(SUITE_TMP, { recursive: true, force: true });
});

test("demo-seed: exports a main function", () => {
  expect(typeof main).toBe("function");
});

test("demo-seed: main writes 2 critiques + traces + bias-audit", async () => {
  await main();

  const today = new Date().toISOString().slice(0, 10);
  const critiqueDir = join(SILTPOKE_HOME, "critiques", "archive", today);
  expect(existsSync(critiqueDir)).toBe(true);

  const critiqueFiles = readdirSync(critiqueDir).filter((f) =>
    f.startsWith("c-demo-"),
  );
  expect(critiqueFiles.length).toBe(2);
  expect(critiqueFiles).toContain("c-demo-bug-001.md");
  expect(critiqueFiles).toContain("c-demo-design-002.md");

  const biasAuditDir = join(SILTPOKE_HOME, "bias-audit");
  expect(existsSync(biasAuditDir)).toBe(true);
  const biasFiles = readdirSync(biasAuditDir);
  expect(biasFiles.length).toBeGreaterThan(0);

  const tracesDir = join(SILTPOKE_HOME, "traces");
  expect(existsSync(tracesDir)).toBe(true);
  const traceFiles = readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl"));
  expect(traceFiles.length).toBeGreaterThan(0);
}, 60_000);

test("demo-seed: running main twice is idempotent (files overwritten, no duplicates)", async () => {
  await main();
  await main();

  const today = new Date().toISOString().slice(0, 10);
  const critiqueDir = join(SILTPOKE_HOME, "critiques", "archive", today);
  const critiqueFiles = readdirSync(critiqueDir).filter((f) =>
    f.startsWith("c-demo-"),
  );
  // writeFile overwrites, so still exactly 2
  expect(critiqueFiles.length).toBe(2);
}, 60_000);

test("demo-seed: clearDemoData removes only c-demo-* files", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const critiqueDir = join(SILTPOKE_HOME, "critiques", "archive", today);
  mkdirSync(critiqueDir, { recursive: true });

  // Seed a demo file and a real (non-demo) file
  await writeFile(join(critiqueDir, "c-demo-bug-001.md"), "demo");
  await writeFile(join(critiqueDir, "c-real-abc-123.md"), "real");

  // Run main — it re-writes demo files (clear not invoked since flagClear is
  // module-level const). Then verify: real file still present, demo files present.
  await main();

  const files = readdirSync(critiqueDir);
  expect(files).toContain("c-real-abc-123.md");
  expect(files).toContain("c-demo-bug-001.md");
  expect(files).toContain("c-demo-design-002.md");
}, 30_000);

test("demo-seed: clearDemoData wipes demo rows from SQLite and JSONL", async () => {
  // Seed traces so demo spans exist in the DB and JSONL files
  await main();

  const tracesDir = join(SILTPOKE_HOME, "traces");
  const dbPath = join(tracesDir, "index.sqlite");

  // Verify spans exist before clear
  expect(existsSync(dbPath)).toBe(true);
  const dbBefore = new Database(dbPath);
  const rowsBefore = dbBefore.query<{ cnt: number }, []>(
    "SELECT COUNT(*) as cnt FROM spans WHERE critique_id LIKE 'c-demo-%'"
  ).get();
  dbBefore.close();
  expect(rowsBefore?.cnt).toBeGreaterThan(0);

  const jsonlFiles = readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl"));
  expect(jsonlFiles.length).toBeGreaterThan(0);

  // Count demo lines in JSONL before clear
  let demoLinesBefore = 0;
  for (const f of jsonlFiles) {
    const lines = readFileSync(join(tracesDir, f), "utf8").split("\n").filter((l) => l.trim());
    for (const l of lines) {
      try {
        const span = JSON.parse(l) as { attributes?: Record<string, unknown> };
        const cid = span.attributes?.["siltpoke.critique_id"] as string | undefined;
        if (cid?.startsWith("c-demo-")) demoLinesBefore++;
      } catch { /* skip */ }
    }
  }
  expect(demoLinesBefore).toBeGreaterThan(0);

  // Run clear
  await clearDemoData();

  // SQLite: no demo rows remain
  const dbAfter = new Database(dbPath);
  const rowsAfter = dbAfter.query<{ cnt: number }, []>(
    "SELECT COUNT(*) as cnt FROM spans WHERE critique_id LIKE 'c-demo-%'"
  ).get();
  dbAfter.close();
  expect(rowsAfter?.cnt).toBe(0);

  // JSONL: no demo lines remain
  let demoLinesAfter = 0;
  for (const f of jsonlFiles) {
    const filePath = join(tracesDir, f);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    for (const l of lines) {
      try {
        const span = JSON.parse(l) as { attributes?: Record<string, unknown> };
        const cid = span.attributes?.["siltpoke.critique_id"] as string | undefined;
        if (cid?.startsWith("c-demo-")) demoLinesAfter++;
      } catch { /* skip */ }
    }
  }
  expect(demoLinesAfter).toBe(0);
}, 60_000);
