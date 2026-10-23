import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const hooksJson = JSON.parse(readFileSync(join(ROOT, "hooks.json"), "utf8"));
const stopSh = readFileSync(join(ROOT, "hooks", "codex-stop.sh"), "utf8");

describe("Codex plugin-root hooks.json", () => {
  test("declares Stop + SessionStart through PLUGIN_ROOT, never a source path", () => {
    expect(hooksJson.hooks.Stop).toBeDefined();
    expect(hooksJson.hooks.SessionStart).toBeDefined();
    const cmds = JSON.stringify(hooksJson);
    // codex runs a hook in the SESSION's cwd, so a `./hooks/` path would not
    // resolve; `${PLUGIN_ROOT}` is substituted by codex (rust-v0.162.1).
    expect(cmds).toContain(`\${PLUGIN_ROOT}/hooks/codex-stop.sh`);
    expect(cmds).not.toContain("./hooks/");
    expect(cmds).not.toContain("/src/hooks/");
  });

  test("IS declared in the codex plugin manifest — without it codex reads Claude Code's hooks/hooks.json", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
    expect(manifest.hooks).toBe("./hooks.json");
  });

  test("stop wrapper guards: silent exit on missing config/bun/bundle + honors SILTPOKE_INTERNAL", () => {
    expect(stopSh).toContain("config.json");
    expect(stopSh).toContain("command -v bun");
    expect(stopSh).toContain("SILTPOKE_INTERNAL");
    expect(stopSh).toContain("dist/codex-stop.js");
  });
});
