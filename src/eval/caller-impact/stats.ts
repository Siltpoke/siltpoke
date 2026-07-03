// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pre-registered statistics for the caller-impact probe. Semantics are fixed
 * BEFORE any paid run (no p-hacking): graph earns keep only if it beats both
 * grep (McNemar-significant) AND the coherent-irrelevant control, on a
 * sufficiently powered discordant set.
 */

function binomCoeff(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}

export interface McNemarResult {
  /** graph-caught & grep-missed. */
  b: number;
  /** grep-caught & graph-missed. */
  c: number;
  /** b + c. */
  discordant: number;
  /** exact two-sided binomial p over the discordant pairs. */
  pValue: number;
}

/**
 * Exact McNemar test (two-sided binomial) on paired boolean outcomes.
 * b = positions where graph caught and grep missed; c = the reverse.
 * Under H0 the discordant split is Binomial(b+c, 0.5); the two-sided exact p
 * is 2 * P(X <= min(b,c)), capped at 1. Equal arrays required.
 */
export function mcnemarExact(
  graphCaught: boolean[],
  grepCaught: boolean[],
): McNemarResult {
  if (graphCaught.length !== grepCaught.length) {
    throw new Error("mcnemarExact: arrays must be equal length");
  }
  let b = 0;
  let c = 0;
  for (let i = 0; i < graphCaught.length; i++) {
    if (graphCaught[i] && !grepCaught[i]) b += 1;
    else if (!graphCaught[i] && grepCaught[i]) c += 1;
  }
  const n = b + c;
  let pValue: number;
  if (n === 0) {
    pValue = 1;
  } else {
    const lo = Math.min(b, c);
    let tail = 0;
    for (let k = 0; k <= lo; k++) {
      tail += binomCoeff(n, k) * 0.5 ** n;
    }
    pValue = Math.min(1, 2 * tail);
  }
  return { b, c, discordant: n, pValue };
}

export interface WilsonInterval {
  lo: number;
  hi: number;
  point: number;
}

/**
 * Wilson score interval for a binomial proportion. More honest than normal
 * approximation at the small-n / near-boundary cases this corpus lives in.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96,
): WilsonInterval {
  if (n === 0) return { lo: 0, hi: 1, point: 0 };
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((phat * (1 - phat)) / n + z2 / (4 * n * n))) / denom;
  return {
    lo: Math.max(0, center - margin),
    hi: Math.min(1, center + margin),
    point: phat,
  };
}

export type EarnsKeep = "yes" | "no" | "underpowered";

export interface VerdictArgs {
  mcnemar: McNemarResult;
  /** Graph catch count over non-control examples. */
  graphCatch: number;
  /** Grep catch count over non-control examples. */
  grepCatch: number;
  /** Coherent-irrelevant control catch count over non-control examples. */
  controlCatch: number;
  /** Per-arm false-positive rates on clean controls, keyed by arm name. */
  fpRates: Record<string, number>;
  /** Minimum discordant pairs required for an adequately powered call. */
  discordantFloor?: number;
}

export interface Verdict {
  earnsKeep: EarnsKeep;
  rationale: string;
}

/**
 * Pre-registered verdict. Graph EARNS KEEP only if ALL hold:
 *  1. discordant pairs >= floor (else "underpowered" — never massaged to "no")
 *  2. McNemar significant (p < 0.05) AND graph caught strictly more than grep
 *  3. graph beat the coherent-irrelevant control (strictly more catches)
 * Otherwise "no". Under-power is reported honestly, not as a negative result.
 */
export function verdict(args: VerdictArgs): Verdict {
  const floor = args.discordantFloor ?? 6;
  const { mcnemar, graphCatch, grepCatch, controlCatch } = args;

  if (mcnemar.discordant < floor) {
    return {
      earnsKeep: "underpowered",
      rationale: `discordant pairs ${mcnemar.discordant} < floor ${floor}; not enough signal to decide (pre-registered: report underpowered, do not call it a loss)`,
    };
  }

  const beatsGrep = mcnemar.pValue < 0.05 && graphCatch > grepCatch;
  const beatsControl = graphCatch > controlCatch;

  if (beatsGrep && beatsControl) {
    return {
      earnsKeep: "yes",
      rationale: `graph beats grep (McNemar p=${mcnemar.pValue.toFixed(4)} < 0.05, b=${mcnemar.b} vs c=${mcnemar.c}, graph ${graphCatch} > grep ${grepCatch}) AND beats coherent-irrelevant control (graph ${graphCatch} > control ${controlCatch}); discordant ${mcnemar.discordant} >= floor ${floor}`,
    };
  }

  const reasons: string[] = [];
  if (!beatsGrep) {
    reasons.push(
      `does not beat grep (p=${mcnemar.pValue.toFixed(4)}, graph ${graphCatch} vs grep ${grepCatch})`,
    );
  }
  if (!beatsControl) {
    reasons.push(
      `does not beat coherent-irrelevant control (graph ${graphCatch} vs control ${controlCatch})`,
    );
  }
  return {
    earnsKeep: "no",
    rationale: `graph ${reasons.join("; ")}; discordant ${mcnemar.discordant} >= floor ${floor} so adequately powered`,
  };
}
