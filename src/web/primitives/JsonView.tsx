// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * JsonView — collapsible JSON pretty-print using <details>/<summary>.
 *
 * Uses native HTML <details> for collapse — no JS needed.
 * Falls back to plain preformatted text if JSON is a string/number/null.
 */
import { tokens } from "../tokens/tokens";

export interface JsonViewProps {
  value: unknown;
  label?: string;
  /** Start collapsed (default: false = open) */
  collapsed?: boolean;
  /**
   * "collapsible" (default) — wraps body in <details> with expand/collapse toggle.
   * "expanded"              — renders colored body directly, no toggle.
   */
  mode?: "collapsible" | "expanded";
}

const INDENT = 2;

function syntaxColor(type: "key" | "string" | "number" | "boolean" | "null"): string {
  switch (type) {
    case "key":
      return tokens.color.sky;
    case "string":
      return tokens.color.moss;
    case "number":
      return tokens.color.amber;
    case "boolean":
      return "#c8a87f";
    case "null":
      return tokens.color.ink3;
  }
}

function JsonLeaf({ value }: { value: string | number | boolean | null }) {
  if (value === null) {
    return <span style={{ color: syntaxColor("null") }}>null</span>;
  }
  if (typeof value === "boolean") {
    return <span style={{ color: syntaxColor("boolean") }}>{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span style={{ color: syntaxColor("number") }}>{String(value)}</span>;
  }
  return <span style={{ color: syntaxColor("string") }}>"{value}"</span>;
}

interface JsonNodeProps {
  value: unknown;
  depth: number;
}

function JsonNode({ value, depth }: JsonNodeProps) {
  if (value === null || typeof value !== "object") {
    return (
      <JsonLeaf value={value as string | number | boolean | null} />
    );
  }

  const indent = " ".repeat(depth * INDENT);
  const innerIndent = " ".repeat((depth + 1) * INDENT);

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>{"[]"}</span>;
    return (
      <details open={depth < 2} style={{ display: "inline" }}>
        <summary
          style={{
            display: "inline",
            cursor: "pointer",
            color: tokens.color.ink3,
            fontFamily: tokens.font.mono,
            fontSize: 11,
          }}
        >
          {"["}{value.length} items{"]"}
        </summary>
        <span>
          {"[\n"}
          {value.map((item, i) => (
            <span key={i}>
              {innerIndent}
              <JsonNode value={item} depth={depth + 1} />
              {i < value.length - 1 ? "," : ""}
              {"\n"}
            </span>
          ))}
          {indent}
          {"]"}
        </span>
      </details>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span>{"{}"}</span>;

  return (
    <details open={depth < 2} style={{ display: "inline" }}>
      <summary
        style={{
          display: "inline",
          cursor: "pointer",
          color: tokens.color.ink3,
          fontFamily: tokens.font.mono,
          fontSize: 11,
        }}
      >
        {"{"}...{"}"}
      </summary>
      <span>
        {"{\n"}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {innerIndent}
            <span style={{ color: syntaxColor("key") }}>"{k}"</span>
            {": "}
            <JsonNode value={v} depth={depth + 1} />
            {i < entries.length - 1 ? "," : ""}
            {"\n"}
          </span>
        ))}
        {indent}
        {"}"}
      </span>
    </details>
  );
}

const preStyle = {
  fontFamily: tokens.font.mono,
  fontSize: 11,
  background: tokens.color.paper,
  border: `1px solid ${tokens.color.edge}`,
  borderRadius: tokens.radius.md,
  padding: "10px 12px",
  overflowX: "auto" as const,
  margin: 0,
  lineHeight: 1.5,
  color: tokens.color.ink2,
  whiteSpace: "pre-wrap" as const,
  wordBreak: "break-word" as const,
};

export function JsonView({ value, label, collapsed = false, mode = "collapsible" }: JsonViewProps) {
  const parsed = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      })()
    : value;

  const body = (
    <pre style={preStyle}>
      <JsonNode value={parsed} depth={0} />
    </pre>
  );

  return (
    <div style={{ marginBottom: 12 }}>
      {label && (
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 4,
          }}
        >
          {label}
        </div>
      )}
      {mode === "expanded" ? (
        body
      ) : (
        <details open={!collapsed}>
          <summary
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.sky,
              cursor: "pointer",
              marginBottom: 4,
            }}
          >
            {collapsed ? "expand" : "collapse"}
          </summary>
          {body}
        </details>
      )}
    </div>
  );
}
