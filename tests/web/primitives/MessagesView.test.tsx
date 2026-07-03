/** @jsxImportSource hono/jsx */
/**
 * MessagesView — chat-style role cards
 */
import { describe, test, expect } from "bun:test";
import { MessagesView } from "../../../src/web/primitives/MessagesView";

describe("MessagesView", () => {
  test("renders messages from JSON input with messages array", () => {
    const input = JSON.stringify({
      messages: [
        { role: "user", content: "Hello there!" },
        { role: "assistant", content: "Hi back!" },
      ],
    });
    const html = String(<MessagesView inputJson={input} />);
    expect(html).toContain("user");
    expect(html).toContain("Hello there!");
    expect(html).toContain("assistant");
    expect(html).toContain("Hi back!");
  });

  test("renders system role when present", () => {
    const input = JSON.stringify({
      system: "You are a helpful assistant.",
      messages: [{ role: "user", content: "Hello" }],
    });
    const html = String(<MessagesView inputJson={input} />);
    expect(html).toContain("system");
    expect(html).toContain("You are a helpful assistant.");
  });

  test("renders output as assistant reply when provided", () => {
    const input = JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
    });
    const output = JSON.stringify("This is my response.");
    const html = String(<MessagesView inputJson={input} outputJson={output} />);
    expect(html).toContain("Response");
    expect(html).toContain("assistant");
    expect(html).toContain("This is my response.");
  });

  test("falls back to plain raw display for non-messages JSON", () => {
    const input = JSON.stringify({ query: "test", result: "found" });
    const html = String(<MessagesView inputJson={input} />);
    expect(html).toContain("Input (raw)");
    expect(html).toContain("query");
  });

  test("falls back to raw display for non-JSON string", () => {
    const html = String(<MessagesView inputJson="plain text input" />);
    expect(html).toContain("Input (raw)");
    expect(html).toContain("plain text input");
  });

  test("handles multipart content blocks in message", () => {
    const input = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is 2+2?" },
            { type: "text", text: "Please answer." },
          ],
        },
      ],
    });
    const html = String(<MessagesView inputJson={input} />);
    expect(html).toContain("What is 2+2?");
    expect(html).toContain("Please answer.");
  });

  test("renders correct role badge colors via CSS classes", () => {
    const input = JSON.stringify({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    });
    const html = String(<MessagesView inputJson={input} />);
    // User has sky color (#7fb0c8), assistant has moss (#7a9a5e)
    expect(html).toContain("7fb0c8"); // sky = user
    expect(html).toContain("7a9a5e"); // moss = assistant
  });

  test("truncates very long content", () => {
    const longContent = "x".repeat(3000);
    const input = JSON.stringify({
      messages: [{ role: "user", content: longContent }],
    });
    const html = String(<MessagesView inputJson={input} />);
    expect(html).toContain("truncated");
  });

  test("does not render output section when outputJson is empty", () => {
    const input = JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
    });
    const html = String(<MessagesView inputJson={input} outputJson="" />);
    expect(html).not.toContain("Response");
  });
});
