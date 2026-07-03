/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { BiasAuditPanel } from "../../../src/web/primitives/BiasAuditPanel";

const ZERO_DELTA = {
  sampleSize: 0,
  severityDisagreementPct: 0,
  categoryDisagreementPct: 0,
  alert: false,
};

const WARN_DELTA = {
  sampleSize: 42,
  severityDisagreementPct: 28.5,
  categoryDisagreementPct: 12.3,
  alert: true,
};

const OK_DELTA = {
  sampleSize: 100,
  severityDisagreementPct: 8.0,
  categoryDisagreementPct: 5.5,
  alert: false,
};

describe("BiasAuditPanel", () => {
  test("renders nothing when disabled", () => {
    const html = String(<BiasAuditPanel config={{ enabled: false }} delta={ZERO_DELTA} />);
    expect(html).toBe("");
  });

  test("renders BIAS AUDIT header when enabled", () => {
    const html = String(<BiasAuditPanel config={{ enabled: true }} delta={OK_DELTA} />);
    expect(html).toContain("BIAS AUDIT");
  });

  test("has bias-audit-panel class on root element", () => {
    const html = String(<BiasAuditPanel config={{ enabled: true }} delta={OK_DELTA} />);
    expect(html).toContain('class="bias-audit-panel"');
  });

  test("shows OK status when no alert", () => {
    const html = String(<BiasAuditPanel config={{ enabled: true }} delta={OK_DELTA} />);
    expect(html).toContain("OK");
    expect(html).not.toContain("WARN");
  });

  test("shows WARN status when alert", () => {
    const html = String(<BiasAuditPanel config={{ enabled: true }} delta={WARN_DELTA} />);
    expect(html).toContain("WARN");
  });

  test("shows 7d sample size", () => {
    const html = String(<BiasAuditPanel config={{ enabled: true }} delta={OK_DELTA} />);
    expect(html).toContain("100");
    expect(html).toContain("7d sample");
  });

  test("shows severity disagreement percent", () => {
    const html = String(<BiasAuditPanel config={{ enabled: true }} delta={WARN_DELTA} />);
    expect(html).toContain("28.5%");
    expect(html).toContain("severity disagree");
  });

  test("shows category disagreement percent", () => {
    const html = String(<BiasAuditPanel config={{ enabled: true }} delta={WARN_DELTA} />);
    expect(html).toContain("12.3%");
    expect(html).toContain("category disagree");
  });

  test("renders zero delta with OK when sampleSize is 0", () => {
    const html = String(<BiasAuditPanel config={{ enabled: true }} delta={ZERO_DELTA} />);
    expect(html).toContain("0");
    expect(html).toContain("OK");
  });
});
