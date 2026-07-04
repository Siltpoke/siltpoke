// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { RubricTrigger } from "../rubric/types";
import type { BrainOutputV2 } from "../../brain/schema-v2";

export type VerifierMode = "off" | "conditional" | "always";

export interface VerifierInput {
  firstPass: BrainOutputV2;
  triggers: ReadonlyArray<RubricTrigger>;
  mode: VerifierMode;
  callBrainVerifier: (
    firstPass: BrainOutputV2,
    triggers: ReadonlyArray<RubricTrigger>,
  ) => Promise<{ ungrounded_ids: string[] }>;
}

export interface VerifierResult {
  ran: boolean;
  vetoed_rule_ids: string[];
  filtered_triggers: RubricTrigger[];
}

export async function runVerifier(input: VerifierInput): Promise<VerifierResult> {
  const shouldRun =
    input.mode === "always" ||
    (input.mode === "conditional" && (
      input.firstPass.confidence === "low" ||
      input.triggers.some(t => t.severity === "high")
    ));

  if (!shouldRun) {
    return { ran: false, vetoed_rule_ids: [], filtered_triggers: [...input.triggers] };
  }

  const { ungrounded_ids } = await input.callBrainVerifier(input.firstPass, input.triggers);
  const vetoedHighIds = ungrounded_ids.filter(id =>
    input.triggers.find(t => t.rule_id === id && t.severity === "high"),
  );
  const filtered = input.triggers.filter(t => !vetoedHighIds.includes(t.rule_id));
  return { ran: true, vetoed_rule_ids: vetoedHighIds, filtered_triggers: filtered };
}
