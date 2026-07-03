import { describe, test, expect } from "bun:test";
import { scanSecrets } from "../../../src/critic/security/secrets-scan";

describe("scanSecrets", () => {
  test("detects AWS access key", () => {
    const result = scanSecrets({
      file: "src/foo.ts",
      addedLines: [
        { line: 10, text: "const accessKey = 'AKIAIOSFODNN7EXAMPLE';" },
      ],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].rule_id).toBe("aws-access-key");
    expect(result[0].severity).toBe("high");
  });

  test("detects GitHub PAT", () => {
    const result = scanSecrets({
      file: "x.ts",
      addedLines: [{ line: 1, text: "token: ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789" }],
    });
    expect(result.length).toBe(1);
    expect(result[0].rule_id).toBe("github-pat");
  });

  test("no false positives on regular code", () => {
    const result = scanSecrets({
      file: "x.ts",
      addedLines: [
        { line: 1, text: "const greeting = 'Hello world';" },
        { line: 2, text: "function foo() { return 42; }" },
      ],
    });
    expect(result).toHaveLength(0);
  });

  test("detects Stripe secret key", () => {
    const result = scanSecrets({
      file: "payment.ts",
      addedLines: [
        { line: 5, text: "const stripe = new Stripe('sk_live_" + "ABCDEFGHIJKLMNOPQRSTUVWX');" },
      ],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((r) => r.rule_id === "stripe-secret")).toBe(true);
  });

  test("detects Slack token", () => {
    const result = scanSecrets({
      file: "config.ts",
      addedLines: [
        { line: 3, text: "const slackToken = 'xoxb-" + "123456789-abcdefghij';" },
      ],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((r) => r.rule_id === "slack-token")).toBe(true);
  });

  test("detects private key block", () => {
    const result = scanSecrets({
      file: "keys.ts",
      addedLines: [
        { line: 1, text: "-----BEGIN PRIVATE KEY-----" },
      ],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((r) => r.rule_id === "generic-private-key")).toBe(true);
  });

  test("includes file and line metadata", () => {
    const result = scanSecrets({
      file: "src/config/keys.ts",
      addedLines: [
        { line: 42, text: "const token = 'ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';" },
      ],
    });
    expect(result[0].file).toBe("src/config/keys.ts");
    expect(result[0].line).toBe(42);
    expect(result[0].tier).toBe(1);
  });

  test("empty addedLines returns no triggers", () => {
    const result = scanSecrets({ file: "empty.ts", addedLines: [] });
    expect(result).toHaveLength(0);
  });
});
