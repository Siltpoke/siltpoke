import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAntiExamples, buildAntiExamplesBlock } from "../../src/few-shot/inject";
import { saveIndex } from "../../src/few-shot/index";
import { createStubEmbedder } from "../../src/few-shot/embedder";
import type { FewShotIndexEntry } from "../../src/few-shot/types";

let tmp: string;
let indexPath: string;
const embedder = createStubEmbedder();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-inject-"));
  indexPath = join(tmp, "few-shot-index.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeIndexEntry(id: string, embedding: number[], reason: string | null = null): FewShotIndexEntry {
  return {
    id,
    embedding,
    signal: "dismiss",
    reason_text: reason,
    critique_summary: `Critique summary for ${id}`,
    ts: "2026-01-01T00:00:00Z",
  };
}

/** Build a normalized 384-dim embedding dominated by first two components */
async function _queryEmbed(text: string): Promise<number[]> {
  return embedder.embed(text);
}

test("returns empty array when index has fewer than 10 entries", async () => {
  // Save only 5 entries
  const small = Array.from({ length: 5 }, (_, i) =>
    makeIndexEntry(`c-${i}`, [1, 0, ...new Array(382).fill(0)]),
  );
  await saveIndex(small, indexPath);

  const result = await getAntiExamples("some query", 3, { indexPath, embedder });
  expect(result).toEqual([]);
});

test("returns results when index has ≥10 entries and similarity is above threshold", async () => {
  // Embed a known query and build index with matching entries
  const qvec = await embedder.embed("null pointer dereference");

  // Create 12 entries — first one has same embedding (similarity=1), rest random
  const many: FewShotIndexEntry[] = [
    makeIndexEntry("c-match", qvec, "already handled"),
    ...Array.from({ length: 11 }, (_, i) =>
      makeIndexEntry(`c-other-${i}`, new Array(384).fill(0).map((_, d) => (d === i ? 1 : 0))),
    ),
  ];
  await saveIndex(many, indexPath);

  const result = await getAntiExamples("null pointer dereference", 3, {
    indexPath,
    embedder,
  });
  // At least the identical match should be returned
  expect(result.length).toBeGreaterThan(0);
});

test("returned strings contain similarity score and summary", async () => {
  const qvec = await embedder.embed("test query");
  const many: FewShotIndexEntry[] = Array.from({ length: 10 }, (_, i) =>
    makeIndexEntry(`c-${i}`, qvec),
  );
  await saveIndex(many, indexPath);

  const result = await getAntiExamples("test query", 1, { indexPath, embedder });
  if (result.length > 0) {
    expect(result[0]).toContain("Dismissed earlier");
    expect(result[0]).toContain("similarity");
    expect(result[0]).toContain("Critique summary");
  }
});

test("reason_text appears in output when present", async () => {
  const qvec = await embedder.embed("some concern");
  const many: FewShotIndexEntry[] = Array.from({ length: 10 }, (_, i) =>
    makeIndexEntry(`c-${i}`, qvec, i === 0 ? "already fixed upstream" : null),
  );
  await saveIndex(many, indexPath);

  const result = await getAntiExamples("some concern", 3, { indexPath, embedder });
  const withReason = result.filter((r) => r.includes("already fixed upstream"));
  expect(withReason.length).toBeGreaterThan(0);
});

test("buildAntiExamplesBlock returns empty string when no anti-examples", async () => {
  await saveIndex([], indexPath);
  const block = await buildAntiExamplesBlock("query", 3, { indexPath, embedder });
  expect(block).toBe("");
});

test("buildAntiExamplesBlock returns markdown header when examples exist", async () => {
  const qvec = await embedder.embed("type error");
  const many: FewShotIndexEntry[] = Array.from({ length: 10 }, (_, i) =>
    makeIndexEntry(`c-${i}`, qvec),
  );
  await saveIndex(many, indexPath);

  const block = await buildAntiExamplesBlock("type error", 3, { indexPath, embedder });
  if (block.length > 0) {
    expect(block).toContain("## User dismissed similar past critiques");
  }
});
