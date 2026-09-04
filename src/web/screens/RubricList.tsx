// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * RubricList screen — /rubric
 *
 * Lists all 13 rubric rules from ALL_RUBRIC_RULES, grouped by tier.
 * Shows calibration report trigger counts when available.
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { tokens } from "../tokens/tokens";
import type { RubricRule } from "../../critic/rubric/types";

const RULE_DESCRIPTIONS: Record<string, string> = {
  "god-file": "File exceeds 500 lines — likely doing too many things",
  "test-gap": "Changed code has no corresponding test coverage",
  "god-function": "Function exceeds LOC or cognitive complexity threshold",
  "deep-nesting": "Block nesting depth exceeds 3 — harms readability",
  "long-param-list": "Function has more than 4 positional parameters",
  "defensive-overreach": "Overly defensive guard clauses obscure happy-path logic",
  "sprawling-abstraction": "Abstraction touches too many unrelated concerns",
  "narrating-comment": "Comment just restates what the next line already says",
  "magic-number": "Unnamed numeric literal obscures intent",
  "boolean-param": "Boolean literal passed as positional arg — use named options",
  "commented-out-code": "Dead code left in comments creates noise",
  "repo-memory-inconsistency": "Code diverges from detected repo conventions",
  "repo-memory-convention": "Detected repo convention is not followed",
};

const TIER_LABELS: Record<number, string> = {
  1: "Deterministic",
  2: "Heuristic AST",
  3: "Semantic Brain (info only)",
};

export interface RubricListProps {
  rules: readonly RubricRule[];
  calibration: Record<string, number>;
}

/**
 * Tier badge fill + foreground.
 *
 * Returns a style OBJECT, not a CSS string. It used to return a string that
 * both call sites passed as a `cssText` key inside `style={{ … }}` — and Hono
 * JSX silently drops an unrecognised key from a style object, so the badges
 * have never actually rendered a background or a color. (The
 * `element.style.cssText = …` calls in src/web/client/islands/action-result.ts
 * are real DOM assignments and do work; this was that idiom copied into a
 * place where it is inert.) Verified against the rendered output: the `T1`
 * span carried no `background` at all before this change.
 *
 * Text color per tier uses the dedicated `onMoss`/`onAmber`/`onSky` tokens
 * (Task 10, decided item 2), not `onAccent` (white in light, where these
 * fills are also light — measured 2.06:1 amber / 3.18:1 moss / 2.35:1 sky)
 * and not `ink` (near-white in dark, measured 1.56:1 amber / 1.66:1 moss /
 * 1.83:1 sky on these same fills — the Task 7 finding this fixes). Gated by
 * tests/web/tokens/palette.test.ts "per-accent ink tokens".
 */
function tierBadgeStyle(tier: number): { background: string; color: string } {
  if (tier === 1) return { background: tokens.color.moss, color: tokens.color.onMoss };
  if (tier === 2) return { background: tokens.color.amber, color: tokens.color.onAmber };
  return { background: tokens.color.sky, color: tokens.color.onSky };
}

export function RubricList({ rules, calibration }: RubricListProps) {
  const tierGroups: Record<number, typeof rules> = { 1: [], 2: [], 3: [] };
  for (const rule of rules) {
    (tierGroups[rule.tier] as RubricRule[]).push(rule);
  }

  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="rubric">
      <div style={{ padding: 16 }}>
        <div style={{ marginBottom: 16 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              display: "block",
              marginBottom: 4,
            }}
          >
            RUBRIC · {rules.length} rules
          </span>
          <h1
            style={{
              margin: "0 0 4px",
              fontFamily: tokens.font.display,
              fontSize: 28,
              fontWeight: 400,
              color: tokens.color.ink,
              lineHeight: 1,
            }}
          >
            Rule Explorer
          </h1>
          <div style={{ fontFamily: tokens.font.body, fontSize: 13, color: tokens.color.ink3 }}>
            Deterministic + heuristic AST rules — 3 tiers
          </div>
        </div>

        {/* Tier breakdown */}
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          {([1, 2, 3] as const).map((tier) => (
            <div
              key={String(tier)}
              style={{
                padding: "6px 12px",
                borderRadius: tokens.radius.md,
                background: tokens.color.paper,
                border: `1px solid ${tokens.color.edge}`,
                fontFamily: tokens.font.mono,
                fontSize: 11,
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  padding: "1px 6px",
                  borderRadius: tokens.radius.sm,
                  fontSize: 10,
                  fontWeight: 700,
                  marginRight: 6,
                  ...tierBadgeStyle(tier),
                }}
              >
                T{tier}
              </span>
              <span style={{ color: tokens.color.ink2 }}>
                {TIER_LABELS[tier]}
              </span>
              <span style={{ color: tokens.color.ink3, marginLeft: 6 }}>
                ({tierGroups[tier]?.length ?? 0})
              </span>
            </div>
          ))}
        </div>

        {/* Rules table */}
        {([1, 2, 3] as const).map((tier) => {
          const tieredRules = tierGroups[tier] ?? [];
          if (tieredRules.length === 0) return null;
          return (
            <div key={String(tier)} style={{ marginBottom: 24 }}>
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink3,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 8,
                  paddingBottom: 4,
                  borderBottom: `1px solid ${tokens.color.edge}`,
                }}
              >
                Tier {tier} — {TIER_LABELS[tier]}
              </div>
              {tieredRules.map((rule) => {
                const count = calibration[rule.id];
                return (
                  <div
                    key={rule.id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "160px 32px 80px 1fr 64px",
                      gap: 8,
                      alignItems: "center",
                      padding: "6px 0",
                      borderBottom: `1px solid ${tokens.color.paperD}`,
                      fontFamily: tokens.font.mono,
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: tokens.color.sky }}>{rule.id}</span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "1px 4px",
                        borderRadius: tokens.radius.sm,
                        fontSize: 10,
                        fontWeight: 700,
                        ...tierBadgeStyle(rule.tier),
                      }}
                    >
                      T{rule.tier}
                    </span>
                    <span style={{ color: tokens.color.ink3, fontSize: 10 }}>
                      {rule.languages.join(", ")}
                    </span>
                    <span style={{ color: tokens.color.ink2, fontFamily: tokens.font.body, fontSize: 12 }}>
                      {RULE_DESCRIPTIONS[rule.id] ?? "—"}
                    </span>
                    <span style={{ color: count !== undefined ? tokens.color.terra : tokens.color.ink3, textAlign: "right" }}>
                      {count !== undefined ? `${count} hits` : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Dashboard>
  );
}
