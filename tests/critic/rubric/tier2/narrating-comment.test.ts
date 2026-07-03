import { describe, test, expect } from "bun:test";
import { narratingCommentRule } from "../../../../src/critic/rubric/tier2/narrating-comment";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), `siltpoke-nc-${Date.now()}`);
mkdirSync(dir, { recursive: true });

function writeTsFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function makeInput(filePath: string) {
  return { cwd: dir, changedFiles: [filePath], diffHunks: [] };
}

describe("narrating-comment rule", () => {
  test("// increment counter → counter++ triggers MED", async () => {
    const src = `// increment counter\ncounter++;\n`;
    const path = writeTsFile("narrate1.ts", src);
    const result = await narratingCommentRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("med");
    expect(result.triggers[0].rule_id).toBe("narrating-comment");
  });

  test("// magic SDP keys → code with sdp keys triggers MED", async () => {
    const src = `// magic SDP keys\nconst sdpKeys = getSdpKeys();\n`;
    const path = writeTsFile("narrate2.ts", src);
    const result = await narratingCommentRule.run(makeInput(path));
    expect(result.triggers.length).toBeGreaterThan(0);
    expect(result.triggers[0].severity).toBe("med");
  });

  test("// IMPORTANT: this handles auth → tokens not subset, no trigger", async () => {
    const src = `// IMPORTANT: this handles auth\nconst x = processRequest();\n`;
    const path = writeTsFile("narrate3.ts", src);
    const result = await narratingCommentRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("single-word comment // flag → no trigger (length 1)", async () => {
    const src = `// flag\nconst flag = true;\n`;
    const path = writeTsFile("narrate4.ts", src);
    const result = await narratingCommentRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("JSDoc block /** Parses input */ → no trigger (jsdoc skipped)", async () => {
    const src = `/** Parses input */\nfunction parseInput(x: string) {\n  return x;\n}\n`;
    const path = writeTsFile("narrate5.ts", src);
    const result = await narratingCommentRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("unsupported file extension → no trigger", async () => {
    const src = `// increment counter\ncounter++\n`;
    const path = writeTsFile("narrate6.rb", src);
    const result = await narratingCommentRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });

  test("comment with no next sibling → no trigger", async () => {
    const src = `const x = 1;\n// increment counter\n`;
    const path = writeTsFile("narrate7.ts", src);
    const result = await narratingCommentRule.run(makeInput(path));
    expect(result.triggers).toHaveLength(0);
  });
});
