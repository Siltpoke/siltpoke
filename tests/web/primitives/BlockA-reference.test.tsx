/** @jsxImportSource hono/jsx */
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Block A's reference section — defect [37] (install audit §51.2).
 *
 * The reviewer is never sent the user's words or the agent's reply; they are
 * archived for this page only. Listing them under "WHAT I READ" said the
 * reviewer read them, so they now sit in their own section that says so.
 */
import { describe, expect, test } from "bun:test";
import { AUDIT_ABSENCE_COPY } from "../../../src/state/audit-absence";
import type { CriticCall } from "../../../src/state/critic-event-log";
import type { V2SidecarData } from "../../../src/state/v2-sidecar";
import { BlockA } from "../../../src/web/primitives/CritiqueAuditBlocks";
import { BASE_CALL, BASE_V2 } from "./audit-block-fixtures";

describe("BlockA — reference section ([37])", () => {
  const REF = 'data-audit-block="ref"';
  const split = (html: string) => {
    const at = html.indexOf(REF);
    return { a: at < 0 ? html : html.slice(0, at), ref: at < 0 ? "" : html.slice(at) };
  };
  const WITH_REPLY: V2SidecarData = { ...BASE_V2, agent_reply: "I moved the key into .env" };

  test("[37] the user's words and the agent's reply are NOT under WHAT I READ", () => {
    const { a, ref } = split(String(<BlockA v2={WITH_REPLY} c={BASE_CALL} />));
    expect(a).not.toContain("fix the secret");
    expect(a).not.toContain("I moved the key into .env");
    expect(ref).toContain("fix the secret");
    expect(ref).toContain("I moved the key into .env");
  });

  test("[37] the reference section says the reviewer was not sent these", () => {
    const { ref } = split(String(<BlockA v2={WITH_REPLY} c={BASE_CALL} />));
    expect(ref).toContain("FOR YOUR REFERENCE");
    expect(ref).toContain("not sent to the reviewer");
  });

  test("[37] what the reviewer DID read stays under WHAT I READ", () => {
    const { a } = split(String(<BlockA v2={BASE_V2} c={BASE_CALL} />));
    expect(a).toContain("WHAT I READ");
    expect(a).toContain("src/auth.ts");
    expect(a).toContain("move secrets to env");
  });

  test("[37] only the user's words recorded: A says nothing was read, the words still show", () => {
    const onlyQuery: V2SidecarData = { ...BASE_V2, changed_files: [], diff_intent: null };
    const c = { ...BASE_CALL, diff_summary: null, audit_absence: "evidence_empty" as const };
    const { a, ref } = split(String(<BlockA v2={onlyQuery} c={c} />));
    expect(a).toContain(AUDIT_ABSENCE_COPY.evidence_empty);
    expect(a).not.toContain("fix the secret");
    expect(ref).toContain("fix the secret");
  });

  const EMPTY_CALL: CriticCall = { ...BASE_CALL, diff_summary: null };

  test("[37] nothing recorded at all: no empty reference section under the absence note", () => {
    const c = { ...EMPTY_CALL, audit_absence: "evidence_empty" as const };
    const html = String(<BlockA v2={null} c={c} />);
    expect(html).not.toContain('data-audit-block="ref"');
  });
});
