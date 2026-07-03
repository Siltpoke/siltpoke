import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeBiasAuditDelta } from "../../../src/critic/bias-audit/delta-computer";

function makeEntry(
  haikuSeverity: string,
  ollamaSeverity: string,
  haikuCategory: string,
  ollamaCategory: string,
  ts = new Date().toISOString(),
): string {
  return JSON.stringify({
    ts,
    haiku: { severity: haikuSeverity, confidence: "high", category: haikuCategory },
    ollama: { severity: ollamaSeverity, confidence: "high", category: ollamaCategory },
  });
}

async function createAuditDir(entries: { day: string; lines: string[] }[]): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "siltpoke-delta-test-"));
  const auditDir = join(tmpDir, "bias-audit");
  await mkdir(auditDir, { recursive: true });
  for (const { day, lines } of entries) {
    await writeFile(join(auditDir, `${day}.jsonl`), `${lines.join("\n")}\n`);
  }
  return auditDir;
}

describe("computeBiasAuditDelta", () => {
  test("returns zeros when audit dir does not exist", async () => {
    const result = await computeBiasAuditDelta({
      auditDir: "/tmp/nonexistent-bias-audit-dir-xyz",
    });
    expect(result.sampleSize).toBe(0);
    expect(result.severityDisagreementPct).toBe(0);
    expect(result.categoryDisagreementPct).toBe(0);
    expect(result.alert).toBe(false);
  });

  test("returns zeros when dir exists but is empty", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "siltpoke-delta-empty-"));
    const auditDir = join(tmpDir, "bias-audit");
    await mkdir(auditDir, { recursive: true });
    const result = await computeBiasAuditDelta({ auditDir });
    expect(result.sampleSize).toBe(0);
    expect(result.alert).toBe(false);
  });

  test("computes 0% disagreement when haiku and ollama always agree", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const auditDir = await createAuditDir([
      {
        day: today,
        lines: [
          makeEntry("med", "med", "correctness", "correctness"),
          makeEntry("high", "high", "security", "security"),
          makeEntry("info", "info", "readability", "readability"),
        ],
      },
    ]);
    const result = await computeBiasAuditDelta({ auditDir });
    expect(result.sampleSize).toBe(3);
    expect(result.severityDisagreementPct).toBe(0);
    expect(result.categoryDisagreementPct).toBe(0);
    expect(result.alert).toBe(false);
  });

  test("computes 100% severity disagreement when all severities differ", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const auditDir = await createAuditDir([
      {
        day: today,
        lines: [
          makeEntry("med", "high", "correctness", "correctness"),
          makeEntry("low", "critical", "design", "design"),
        ],
      },
    ]);
    const result = await computeBiasAuditDelta({ auditDir });
    expect(result.sampleSize).toBe(2);
    expect(result.severityDisagreementPct).toBe(100);
    expect(result.categoryDisagreementPct).toBe(0);
    expect(result.alert).toBe(true);
  });

  test("computes partial disagreement correctly", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const auditDir = await createAuditDir([
      {
        day: today,
        lines: [
          // 1 severity agree, 1 severity disagree → 50%
          makeEntry("med", "med", "correctness", "security"),   // cat disagree
          makeEntry("med", "high", "design", "design"),          // sev disagree
        ],
      },
    ]);
    const result = await computeBiasAuditDelta({ auditDir });
    expect(result.sampleSize).toBe(2);
    expect(result.severityDisagreementPct).toBe(50);
    expect(result.categoryDisagreementPct).toBe(50);
    // 50% > 15% threshold
    expect(result.alert).toBe(true);
  });

  test("only reads files within last 7 days", async () => {
    const now = new Date("2026-05-20T12:00:00Z");
    const today = "2026-05-20";
    const oldDay = "2026-05-12"; // 8 days ago — outside window

    const auditDir = await createAuditDir([
      {
        day: today,
        lines: [makeEntry("med", "high", "correctness", "correctness")],
      },
      {
        day: oldDay,
        lines: [
          // These entries are in an old file and should NOT be counted
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
        ],
      },
    ]);

    const result = await computeBiasAuditDelta({ auditDir, now });
    // Should only see today's 1 entry (severity disagrees)
    expect(result.sampleSize).toBe(1);
    expect(result.severityDisagreementPct).toBe(100);
  });

  test("alert is true when severity disagreement exceeds custom threshold", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const auditDir = await createAuditDir([
      {
        day: today,
        lines: [
          makeEntry("med", "high", "correctness", "correctness"),
          makeEntry("med", "high", "correctness", "correctness"),
          makeEntry("med", "high", "correctness", "correctness"),
          // 30% agree:
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
          makeEntry("info", "info", "readability", "readability"),
        ],
      },
    ]);
    // 3/10 = 30% disagree > 20% threshold
    const result = await computeBiasAuditDelta({ auditDir, alertThreshold: 0.20 });
    expect(result.sampleSize).toBe(10);
    expect(result.alert).toBe(true);
  });

  test("skips malformed JSONL lines gracefully", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const tmpDir = await mkdtemp(join(tmpdir(), "siltpoke-delta-malformed-"));
    const auditDir = join(tmpDir, "bias-audit");
    await mkdir(auditDir, { recursive: true });
    await writeFile(
      join(auditDir, `${today}.jsonl`),
      `${[
        makeEntry("med", "med", "correctness", "correctness"),
        "{ broken json",
        "",
        makeEntry("high", "high", "security", "security"),
      ].join("\n")}\n`,
    );
    const result = await computeBiasAuditDelta({ auditDir });
    // Should have 2 valid entries
    expect(result.sampleSize).toBe(2);
    expect(result.severityDisagreementPct).toBe(0);
  });
});
