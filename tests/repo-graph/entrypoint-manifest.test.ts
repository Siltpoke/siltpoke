import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, parseScriptEntry, remapToSource } from "../../src/repo-graph/entrypoint-manifest";
import { emptyQueryIndex } from "../../src/repo-graph/types";

const dirs: string[] = [];
function tmp(pkg: Record<string, unknown>, extra?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "ep-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  extra?.(root);
  return root;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("readManifest", () => {
  test("normalizes string-form bin to a name→path map using the package name", () => {
    const root = tmp({ name: "mytool", bin: "./cli.js" });
    expect(readManifest(root)?.bin).toEqual({ mytool: "./cli.js" });
  });
  test("keeps object-form bin as-is", () => {
    const root = tmp({ name: "x", bin: { foo: "dist/foo.js" } });
    expect(readManifest(root)?.bin).toEqual({ foo: "dist/foo.js" });
  });
  test("returns null on malformed package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "ep-")); dirs.push(root);
    writeFileSync(join(root, "package.json"), "{ not json");
    expect(readManifest(root)).toBeNull();
  });
  test("falls back to the bin path's basename when there is no package name", () => {
    const root = tmp({ bin: "./cli.js" });
    expect(readManifest(root)?.bin).toEqual({ cli: "./cli.js" });
  });
});

describe("parseScriptEntry", () => {
  test("extracts the file from node/tsx/bun forms", () => {
    expect(parseScriptEntry("node dist/server.js")).toBe("dist/server.js");
    expect(parseScriptEntry("tsx src/index.ts")).toBe("src/index.ts");
    expect(parseScriptEntry("node -r dotenv/config dist/app.js")).toBe("dist/app.js");
    expect(parseScriptEntry("./bin/run.js")).toBe("./bin/run.js");
  });
  test("skips opaque commands (framework CLI, task runner, chains)", () => {
    expect(parseScriptEntry("next dev")).toBeNull();
    expect(parseScriptEntry("vite --host")).toBeNull();
    expect(parseScriptEntry("concurrently 'a' 'b'")).toBeNull();
    expect(parseScriptEntry("node dist/a.js && echo done")).toBeNull();
  });
});

describe("remapToSource", () => {
  test("direct hit when the manifest path is an indexed file", () => {
    const qi = emptyQueryIndex();
    qi.path_to_node_ids["src/cli.ts"] = ["file:src/cli.ts:"];
    expect(remapToSource(qi, "src/cli.ts", "/repo")).toEqual({ filePath: "src/cli.ts", resolvedBy: "direct" });
  });
  test("dist→src remap via extension swap, unique match, resolvedBy=remap", () => {
    const qi = emptyQueryIndex();
    qi.path_to_node_ids["src/cli.ts"] = ["file:src/cli.ts:"];
    expect(remapToSource(qi, "dist/cli.js", "/repo")).toEqual({ filePath: "src/cli.ts", resolvedBy: "remap" });
  });
  test("returns null when no candidate matches an indexed file", () => {
    expect(remapToSource(emptyQueryIndex(), "dist/cli.js", "/repo")).toBeNull();
  });
  test("ambiguous remap (>1 candidate matches) → null, never guess (spec §5)", () => {
    const qi = emptyQueryIndex();
    qi.path_to_node_ids["src/cli.ts"] = ["file:src/cli.ts:"];
    qi.path_to_node_ids["src/cli/index.ts"] = ["file:src/cli/index.ts:"];
    expect(remapToSource(qi, "dist/cli.js", "/repo")).toBeNull();
  });
});
