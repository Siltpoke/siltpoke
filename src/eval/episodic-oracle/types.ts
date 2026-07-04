// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export interface CritiqueScenario {
  id: string;
  intent: string;
  files: string[];
  summary: string;
}

export interface EpisodicEntry {
  id: string;
  text: string;
  ts: string; // ISO write time — recency signal
  confidence: number; // 0..1 — importance signal
}

export interface RetrievalDecision {
  injected: string[];
  abstained: boolean;
}

export type RetrievePolicy = (
  scenario: CritiqueScenario,
  store: EpisodicEntry[],
) => RetrievalDecision;

export type FixtureKind = "positive" | "distractor" | "mixed";

const scenarioSchema = z.object({
  id: z.string(),
  intent: z.string(),
  files: z.array(z.string()),
  summary: z.string(),
});

const entrySchema = z.object({
  id: z.string(),
  text: z.string(),
  ts: z.string(),
  confidence: z.number().min(0).max(1),
});

export const oracleFixtureSchema = z.object({
  id: z.string(),
  kind: z.enum(["positive", "distractor", "mixed"]),
  scenario: scenarioSchema,
  store: z.array(entrySchema),
  expect: z.object({
    must_inject: z.array(z.string()),
    must_not_inject: z.array(z.string()),
    must_abstain: z.boolean(),
  }),
  must_not_regress: z.boolean().optional(),
});

export type OracleFixture = z.infer<typeof oracleFixtureSchema>;

export async function loadOracleFixtures(dir: string): Promise<OracleFixture[]> {
  const files = await readdir(dir);
  return Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) =>
        oracleFixtureSchema.parse(JSON.parse(await readFile(join(dir, f), "utf8"))),
      ),
  );
}
