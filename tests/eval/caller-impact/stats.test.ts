import { describe, expect, it } from "bun:test";
import {
  type McNemarResult,
  mcnemarExact,
  verdict,
  wilsonInterval,
} from "../../../src/eval/caller-impact/stats";

describe("mcnemarExact", () => {
  it("counts b/c correctly", () => {
    // i: 0 graph& !grep (b), 1 !graph&grep (c), 2 both, 3 neither
    const graph = [true, false, true, false];
    const grep = [false, true, true, false];
    const r = mcnemarExact(graph, grep);
    expect(r.b).toBe(1);
    expect(r.c).toBe(1);
    expect(r.discordant).toBe(2);
  });

  it("matches hand-computed exact p for b=8, c=0 (n=8)", () => {
    // Hand: n=8, min(b,c)=0. tail = C(8,0)*0.5^8 = 1/256 = 0.00390625.
    // p = 2*tail = 0.0078125.
    const graph = Array(8).fill(true);
    const grep = Array(8).fill(false);
    const r = mcnemarExact(graph, grep);
    expect(r.b).toBe(8);
    expect(r.c).toBe(0);
    expect(r.discordant).toBe(8);
    expect(r.pValue).toBeCloseTo(0.0078125, 7);
  });

  it("matches hand-computed exact p for b=6, c=1 (n=7)", () => {
    // Hand: n=7, min=1. tail = (C(7,0)+C(7,1))*0.5^7 = (1+7)/128 = 8/128 = 0.0625.
    // p = 2*0.0625 = 0.125.
    const graph = [...Array(6).fill(true), false, ...Array(3).fill(true)];
    const grep = [...Array(6).fill(false), true, ...Array(3).fill(true)];
    const r = mcnemarExact(graph, grep);
    expect(r.b).toBe(6);
    expect(r.c).toBe(1);
    expect(r.discordant).toBe(7);
    expect(r.pValue).toBeCloseTo(0.125, 6);
  });

  it("p = 1 when there are no discordant pairs", () => {
    const r = mcnemarExact([true, false], [true, false]);
    expect(r.discordant).toBe(0);
    expect(r.pValue).toBe(1);
  });

  it("throws on unequal-length arrays", () => {
    expect(() => mcnemarExact([true], [true, false])).toThrow();
  });
});

describe("wilsonInterval", () => {
  it("matches hand-computed 8/10 case (z=1.96)", () => {
    // Hand: phat=0.8, z2=3.8416, n=10, denom=1.38416.
    // center=(0.8+0.19208)/1.38416 = 0.71674.
    // margin=1.96*sqrt(0.016+0.0096040)/1.38416 = 0.22659.
    // lo ≈ 0.49015, hi ≈ 0.94333.
    const w = wilsonInterval(8, 10);
    expect(w.point).toBeCloseTo(0.8, 6);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
  });

  it("clamps to [0,1] and returns full interval for n=0", () => {
    const w = wilsonInterval(0, 0);
    expect(w.lo).toBe(0);
    expect(w.hi).toBe(1);
    expect(w.point).toBe(0);
  });
});

function mc(b: number, c: number): McNemarResult {
  const graph = [...Array(b).fill(true), ...Array(c).fill(false)];
  const grep = [...Array(b).fill(false), ...Array(c).fill(true)];
  return mcnemarExact(graph, grep);
}

describe("verdict (pre-registered)", () => {
  it("returns underpowered when discordant < floor", () => {
    // b=3,c=1 => discordant 4 < floor 6.
    const v = verdict({
      mcnemar: mc(3, 1),
      graphCatch: 10,
      grepCatch: 6,
      controlCatch: 4,
      fpRates: {},
      discordantFloor: 6,
    });
    expect(v.earnsKeep).toBe("underpowered");
  });

  it("returns yes when graph beats grep (significant) AND beats control", () => {
    // b=8,c=0 => discordant 8 >= 6, p=0.0078 < 0.05.
    const v = verdict({
      mcnemar: mc(8, 0),
      graphCatch: 12,
      grepCatch: 4,
      controlCatch: 5,
      fpRates: {},
      discordantFloor: 6,
    });
    expect(v.earnsKeep).toBe("yes");
  });

  it("returns no when graph does not beat control even if it beats grep", () => {
    const v = verdict({
      mcnemar: mc(8, 0),
      graphCatch: 12,
      grepCatch: 4,
      controlCatch: 12, // tie with control => not strictly greater
      fpRates: {},
      discordantFloor: 6,
    });
    expect(v.earnsKeep).toBe("no");
  });

  it("returns no when GREP beats graph on the discordant direction (c>b, significant)", () => {
    // c=8,b=0 => discordant 8 >= 6, p=0.0078 < 0.05, but grep is the winner.
    // graphCatch <= grepCatch must block "yes" regardless of significance.
    const v = verdict({
      mcnemar: mc(0, 8),
      graphCatch: 4,
      grepCatch: 12,
      controlCatch: 3,
      fpRates: {},
      discordantFloor: 6,
    });
    expect(v.earnsKeep).toBe("no");
  });

  it("returns no when graph does not beat grep (not significant)", () => {
    // b=4,c=3 => discordant 7 >= 6 but p not < 0.05.
    const v = verdict({
      mcnemar: mc(4, 3),
      graphCatch: 7,
      grepCatch: 6,
      controlCatch: 3,
      fpRates: {},
      discordantFloor: 6,
    });
    expect(v.earnsKeep).toBe("no");
  });
});
