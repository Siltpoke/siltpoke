import { describe, test, expect } from "bun:test";
import { scanTaint } from "../../../src/critic/security/taint-scan";

describe("scanTaint", () => {
  test("exec(req.body.cmd) → command injection HIGH", () => {
    const result = scanTaint({
      file: "src/shell.ts",
      source: `
import { exec } from "child_process";
const cmd = req.body.cmd;
exec(req.body.cmd, callback);
`,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.some((r) => r.rule_id === "taint-cmd")).toBe(true);
    expect(result[0].severity).toBe("high");
  });

  test("fetch(req.query.url) → SSRF HIGH", () => {
    const result = scanTaint({
      file: "src/proxy.ts",
      source: `
async function proxy(req) {
  return fetch(req.query.url);
}
`,
    });
    expect(result.some((r) => r.rule_id === "taint-ssrf")).toBe(true);
  });

  test("fs.readFile(req.params.path) → path traversal HIGH", () => {
    const result = scanTaint({
      file: "src/file-server.ts",
      source: `
const data = fs.readFile(req.params.path, "utf8");
`,
    });
    expect(result.some((r) => r.rule_id === "taint-path")).toBe(true);
  });

  test("db.raw with string concatenation → SQLi HIGH", () => {
    const result = scanTaint({
      file: "src/db.ts",
      source: `
const row = db.raw('SELECT * FROM users WHERE id = ' + req.query.id);
`,
    });
    expect(result.some((r) => r.rule_id === "taint-sqli")).toBe(true);
  });

  test("dangerouslySetInnerHTML with userInput → XSS HIGH", () => {
    const result = scanTaint({
      file: "src/Widget.tsx",
      source: `
function Widget({ userInput }) {
  return <div dangerouslySetInnerHTML={{__html: userInput}} />;
}
`,
    });
    expect(result.some((r) => r.rule_id === "taint-xss")).toBe(true);
  });

  test("sanitized exec → no trigger", () => {
    const result = scanTaint({
      file: "src/safe-shell.ts",
      source: `
const safeCmd = sanitize(req.body.cmd);
exec(safeCmd, callback);
`,
    });
    expect(result.filter((r) => r.rule_id === "taint-cmd")).toHaveLength(0);
  });

  test("addedLines filter: only flags specified line numbers", () => {
    // Tainted call on line 2; unrelated code separated by a blank line to avoid window overlap
    const source = `
const data = fs.readFile(req.params.path, "utf8");

const x = 1;
const y = 2;
`;
    const allLines = scanTaint({ file: "f.ts", source });
    // Line 5 is clean — not adjacent to the tainted line 2
    const onlyLine5 = scanTaint({ file: "f.ts", source, addedLines: new Set([5]) });
    expect(allLines.some((r) => r.rule_id === "taint-path")).toBe(true);
    expect(onlyLine5.filter((r) => r.rule_id === "taint-path")).toHaveLength(0);
  });

  test("no source taint → no trigger", () => {
    const result = scanTaint({
      file: "src/static.ts",
      source: `
exec("ls -la", callback);
fetch("https://example.com/api");
`,
    });
    expect(result).toHaveLength(0);
  });

  test("includes file and line metadata", () => {
    const result = scanTaint({
      file: "src/handler.ts",
      source: `const x = eval(req.body.code);`,
    });
    expect(result[0].file).toBe("src/handler.ts");
    expect(result[0].line).toBe(1);
    expect(result[0].tier).toBe(2);
  });
});
