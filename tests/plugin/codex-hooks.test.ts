import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const hooksJson = JSON.parse(readFileSync(join(ROOT, "hooks.json"), "utf8"));
const stopSh = readFileSync(join(ROOT, "hooks", "codex-stop.sh"), "utf8");

describe("Codex plugin-root hooks.json", () => {
  test("declares Stop + SessionStart with relative-path commands", () => {
    expect(hooksJson.hooks.Stop).toBeDefined();
    expect(hooksJson.hooks.SessionStart).toBeDefined();
    const cmds = JSON.stringify(hooksJson);
    // relative paths only — never an absolute /Users or src/ source path
    expect(cmds).toContain("./hooks/codex-stop.sh");
    expect(cmds).not.toContain("/src/hooks/");
  });

  test("is NOT declared in the codex plugin manifest (validator rejects the field)", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
    expect(manifest.hooks).toBeUndefined();
  });

  test("stop wrapper guards: silent exit on missing config/bun/bundle + honors SILTPOKE_INTERNAL", () => {
    expect(stopSh).toContain("config.json");
    expect(stopSh).toContain("command -v bun");
    expect(stopSh).toContain("SILTPOKE_INTERNAL");
    expect(stopSh).toContain("dist/codex-stop.js");
  });
});
