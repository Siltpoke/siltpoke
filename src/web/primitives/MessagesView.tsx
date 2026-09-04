// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * MessagesView — chat-style role cards for LLM spans.
 *
 * Parses siltpoke.input JSON. If it contains a `messages: [{role, content}]` array,
 * renders each as a styled role-card. Falls back to plain text.
 *
 * Also renders siltpoke.output as the assistant reply card.
 */
import { tokens } from "../tokens/tokens";

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role | string;
  content: string | unknown;
}

export interface ParsedInput {
  messages?: Message[];
  system?: string;
  [key: string]: unknown;
}

const ROLE_COLOR: Record<string, string> = {
  system: tokens.color.ink3,
  user: tokens.color.sky,
  assistant: tokens.color.moss,
  tool: tokens.color.amber,
};

const ROLE_BG: Record<string, string> = {
  system: tokens.color.paper,
  user: tokens.color.roleBgUser,
  assistant: tokens.color.roleBgAssistant,
  tool: tokens.color.roleBgTool,
};

function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? tokens.color.ink2;
}

function roleBg(role: string): string {
  return ROLE_BG[role] ?? tokens.color.paper;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          if (b["type"] === "text" && typeof b["text"] === "string") return b["text"];
          return JSON.stringify(block);
        }
        return String(block);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function MessageCard({ role, content }: { role: string; content: unknown }) {
  const text = contentToString(content);
  const truncated = text.length > 2000 ? text.slice(0, 2000) + "… [truncated]" : text;

  return (
    <div
      style={{
        marginBottom: 10,
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.color.edge}`,
        background: roleBg(role),
        overflow: "hidden",
      }}
    >
      {/* Role header */}
      <div
        style={{
          padding: "4px 10px",
          borderBottom: `1px solid ${tokens.color.edge}`,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: roleColor(role),
            fontWeight: "bold",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {role}
        </span>
      </div>
      {/* Content */}
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink2,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.55,
          overflowX: "auto",
        }}
      >
        {truncated}
      </pre>
    </div>
  );
}

export interface MessagesViewProps {
  /** JSON string from siltpoke.input */
  inputJson: string;
  /** JSON string from siltpoke.output (will be shown as assistant reply if set) */
  outputJson?: string;
}

export function MessagesView({ inputJson, outputJson }: MessagesViewProps) {
  // Try to parse as messages array
  let parsed: ParsedInput | null = null;
  try {
    const p = JSON.parse(inputJson) as unknown;
    if (typeof p === "object" && p !== null) {
      parsed = p as ParsedInput;
    }
  } catch {
    // not valid JSON — fall back
  }

  const messages: Message[] = [];

  // Extract system prompt if present
  if (parsed?.["system"] && typeof parsed["system"] === "string") {
    messages.push({ role: "system", content: parsed["system"] });
  }

  // Extract messages array
  if (Array.isArray(parsed?.["messages"])) {
    for (const m of parsed["messages"] as Message[]) {
      if (m && typeof m === "object" && "role" in m) {
        messages.push(m);
      }
    }
  }

  const hasMessages = messages.length > 0;

  return (
    <div>
      {hasMessages ? (
        <>
          {messages.map((m, i) => (
            <MessageCard key={i} role={String(m.role)} content={m.content} />
          ))}
          {outputJson && outputJson !== "" && outputJson !== "null" && (
            <>
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 9,
                  color: tokens.color.ink3,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: 4,
                  marginTop: 12,
                }}
              >
                Response
              </div>
              <MessageCard role="assistant" content={parseOutput(outputJson)} />
            </>
          )}
        </>
      ) : (
        // Fallback: raw display
        <div>
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Input (raw)
          </div>
          <pre
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 11,
              background: tokens.color.paper,
              border: `1px solid ${tokens.color.edge}`,
              borderRadius: tokens.radius.md,
              padding: "10px 12px",
              margin: 0,
              overflowX: "auto",
              color: tokens.color.ink2,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {inputJson.slice(0, 4096)}
          </pre>
        </div>
      )}
    </div>
  );
}

function parseOutput(outputJson: string): string {
  try {
    const p = JSON.parse(outputJson) as unknown;
    if (typeof p === "string") return p;
    return JSON.stringify(p, null, 2);
  } catch {
    return outputJson;
  }
}
