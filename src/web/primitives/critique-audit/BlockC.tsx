// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Block C — RUBRIC CHECKLIST
 *
 * Renders the 13 rubric rules with ✓ / ✗ / ⊘ per rule, grouped by tier.
 * Differentiates "pipeline ran clean" (schemaVersion=2, 0 triggers) from
 * "legacy critique, no pipeline" (schemaVersion=1).
 *
 * Extracted from CritiqueAuditBlocks.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { V2SidecarData, V2RubricTrigger } from "../../../state/api";
import {
  AuditSection,
  PlaceholderNote,
  V2_MISSING_NOTE,
  TIER_LABEL,
} from "./shared";
import { ALL_RULES, type RuleDesc } from "./rules-data";
import { redactPath } from "./BlockA";

export interface BlockCProps {
  v2: V2SidecarData | null;
  /** Project cwd; used to redact absolute paths in trigger file:line rows. */
  cwd?: string | null;
}

type RuleState = "pass" | "fail" | "na";

interface RubricRowProps {
  rule: RuleDesc;
  state: RuleState;
  triggers: V2RubricTrigger[];
  cwd: string | null;
}

function RubricHeader({ rule, state, triggers }: Omit<RubricRowProps, "cwd">) {
  const icon = state === "pass" ? "✓" : state === "fail" ? "✗" : "⊘";
  const iconColor =
    state === "pass"
      ? tokens.color.moss
      : state === "fail"
        ? tokens.color.terra
        : tokens.color.ink3;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontFamily: tokens.font.mono,
        fontSize: 10,
      }}
    >
      <span style={{ color: iconColor, fontWeight: 700, fontSize: 11, width: 12, flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ color: tokens.color.ink, flex: 1 }}>{rule.label}</span>
      {state === "fail" && triggers.length > 0 && (
        <span style={{ color: tokens.color.terra, fontSize: 9 }}>
          {triggers.length} trigger{triggers.length !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}

function RubricTriggerDetail({ t, cwd }: { t: V2RubricTrigger; cwd: string | null }) {
  return (
    <div
      style={{
        marginLeft: 20,
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color: tokens.color.ink2,
        display: "flex",
        flexDirection: "column",
        gap: 2,
        paddingTop: 2,
        paddingBottom: 2,
        borderLeft: `1px solid ${tokens.color.edge}`,
        paddingLeft: 8,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ color: tokens.color.terra, fontWeight: 600 }} title={`${t.file}:${t.line}`}>
          {redactPath(t.file, cwd)}:{t.line}
        </span>
        {t.severity && (
          <span
            style={{
              fontSize: 8,
              color: tokens.color.ink3,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            · {t.severity}
          </span>
        )}
      </div>
      {t.message && (
        <div
          style={{
            color: tokens.color.ink,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.4,
          }}
        >
          {t.message}
        </div>
      )}
      {t.snippet && (
        <code
          style={{
            background: tokens.color.paper,
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: 2,
            padding: "1px 4px",
            color: tokens.color.ink2,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            display: "inline-block",
            marginTop: 2,
          }}
        >
          {t.snippet}
        </code>
      )}
    </div>
  );
}

function RubricRow({ rule, state, triggers, cwd }: RubricRowProps) {
  return (
    <div
      class={`rubric-row rubric-row--${state}`}
      data-rule-id={rule.id}
      style={{ display: "flex", flexDirection: "column", gap: 3 }}
    >
      <RubricHeader rule={rule} state={state} triggers={triggers} />
      {state === "fail" &&
        triggers.map((t, i) => <RubricTriggerDetail key={i} t={t} cwd={cwd} />)}
    </div>
  );
}

function renderRuleGroup(
  tierNum: 1 | 2,
  rules: RuleDesc[],
  triggersByRule: Map<string, V2RubricTrigger[]>,
  getRuleState: (r: RuleDesc) => RuleState,
  cwd: string | null,
) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 2,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {TIER_LABEL[tierNum]}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rules.map((rule) => (
          <RubricRow
            key={rule.id}
            rule={rule}
            state={getRuleState(rule)}
            triggers={triggersByRule.get(rule.id) ?? []}
            cwd={cwd}
          />
        ))}
      </div>
    </div>
  );
}

function Tier3Placeholder() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {TIER_LABEL[3]}
      </div>
      <div
        style={{
          fontFamily: tokens.font.body,
          fontSize: 11,
          color: tokens.color.ink3,
          fontStyle: "italic",
        }}
      >
        no Tier 3 rules implemented yet — placeholder for semantic / Brain-driven checks
      </div>
    </div>
  );
}

export function BlockC({ v2, cwd }: BlockCProps) {
  const projectCwd = cwd ?? null;
  if (!v2) {
    return (
      <AuditSection id="C" label="C · RUBRIC CHECKLIST">
        <PlaceholderNote text={V2_MISSING_NOTE} />
      </AuditSection>
    );
  }

  const triggersByRule = new Map<string, V2RubricTrigger[]>();
  for (const t of v2.rubric_triggers) {
    const arr = triggersByRule.get(t.rule_id) ?? [];
    arr.push(t);
    triggersByRule.set(t.rule_id, arr);
  }

  // schemaVersion: 2 sidecar = v2 pipeline ran (rubric + intent classifier).
  // schemaVersion: 1 (or null) = legacy critique pre-dating the pipeline.
  // Use this to differentiate "ran clean, 0 violations" from "didn't run at all".
  const pipelineRan = v2.schemaVersion === 2;

  const getRuleState = (rule: RuleDesc): RuleState => {
    if (triggersByRule.has(rule.id)) return "fail";
    return pipelineRan ? "pass" : "na";
  };

  const tier1Rules = ALL_RULES.filter((r) => r.tier === 1);
  const tier2Rules = ALL_RULES.filter((r) => r.tier === 2);

  return (
    <AuditSection
      id="C"
      label="C · RUBRIC CHECKLIST"
      note={
        v2.rubric_triggers.length > 0
          ? `${v2.rubric_triggers.length} trigger${v2.rubric_triggers.length !== 1 ? "s" : ""}`
          : pipelineRan
            ? "all rules pass — 0 triggers"
            : "rubric not run (legacy critique)"
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {renderRuleGroup(1, tier1Rules, triggersByRule, getRuleState, projectCwd)}
        {renderRuleGroup(2, tier2Rules, triggersByRule, getRuleState, projectCwd)}
        <Tier3Placeholder />
      </div>
    </AuditSection>
  );
}
