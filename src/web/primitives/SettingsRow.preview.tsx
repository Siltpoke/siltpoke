// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { SettingsRow } from "./SettingsRow";

const Toggle = () => (
  <button
    style={{
      width: 36,
      height: 20,
      borderRadius: 999,
      border: "none",
      cursor: "pointer",
      background: tokens.color.moss,
      position: "relative",
      flexShrink: 0,
    }}
  >
    <i
      style={{
        position: "absolute",
        top: 2,
        left: 18,
        width: 16,
        height: 16,
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,.25)",
      }}
    />
  </button>
);

const stories: PreviewStory[] = [
  {
    name: "stacked with toggle control",
    render: () => (
      <div style={{ width: 340 }}>
        <SettingsRow
          label="Run on every save"
          sub="triggers after file write completes"
          right={<Toggle />}
        />
        <SettingsRow
          label="Show suppression log"
          sub="prints gate decisions to daemon.log"
          right={<Toggle />}
        />
      </div>
    ),
  },
  {
    name: "stacked with sub line only",
    render: () => (
      <div style={{ width: 340 }}>
        <SettingsRow
          label="Budget limit"
          sub="max spend per calendar day"
          value="$5.00"
        />
        <SettingsRow label="Model" sub="used for critique generation" value="sonnet-4.6" />
      </div>
    ),
  },
  {
    name: "inline mono value",
    render: () => (
      <div style={{ width: 340, display: "flex", flexDirection: "column", gap: 6 }}>
        <SettingsRow label="version" value="v1.4.2" inline mono />
        <SettingsRow label="daemon pid" value="38421" inline mono />
        <SettingsRow label="uptime" value="14h 22m" inline mono />
      </div>
    ),
  },
  {
    name: "inline plain value",
    render: () => (
      <div style={{ width: 340, display: "flex", flexDirection: "column", gap: 6 }}>
        <SettingsRow label="Theme" value="warm cream" inline />
        <SettingsRow label="Language" value="English" inline />
      </div>
    ),
  },
];

export default stories;
