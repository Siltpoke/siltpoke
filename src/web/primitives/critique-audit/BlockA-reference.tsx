// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { AuditSection, MonoBlock, PlaceholderNote, SubLabel } from "./shared";

/**
 * The user's words and the agent's reply. Captured and archived for this page,
 * never sent to the reviewer (defect [37]) — so they sit outside "WHAT I READ",
 * under a heading that says so.
 */
export function ReferenceSection(props: {
  userQuery: string | null;
  missingNote: string;
  queryTruncated: boolean;
  agentReply: string | null;
  agentReplyLabel: string;
}) {
  return (
    <AuditSection
      id="ref"
      label="FOR YOUR REFERENCE"
      note="not sent to the reviewer — kept so you can compare"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <SubLabel>user raw query (verbatim)</SubLabel>
        {props.userQuery ? (
          <MonoBlock>{props.userQuery}</MonoBlock>
        ) : (
          <PlaceholderNote text={props.missingNote} />
        )}
        {props.queryTruncated && (
          <PlaceholderNote text="long prompt — only the first 2000 characters were stored" />
        )}
      </div>

      {props.agentReply && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SubLabel>{props.agentReplyLabel}</SubLabel>
          <MonoBlock>{props.agentReply}</MonoBlock>
        </div>
      )}
    </AuditSection>
  );
}
