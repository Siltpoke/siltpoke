// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { CritiqueScenario, EpisodicEntry, RetrievalDecision, RetrievePolicy } from "./types";

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

export const keywordPolicy: RetrievePolicy = (
  scenario: CritiqueScenario,
  store: EpisodicEntry[],
): RetrievalDecision => {
  const want = tokens(scenario.summary);
  const injected = store
    .filter((e) => overlap(tokens(e.text), want) >= 2)
    .map((e) => e.id);
  return { injected, abstained: injected.length === 0 };
};

export const injectEverythingPolicy: RetrievePolicy = (
  _scenario,
  store,
): RetrievalDecision => ({ injected: store.map((e) => e.id), abstained: false });

export const injectNothingPolicy: RetrievePolicy = (): RetrievalDecision => ({
  injected: [],
  abstained: true,
});
