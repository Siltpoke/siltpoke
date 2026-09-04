import { expect, test } from "bun:test";
import { resolveModuleName } from "../../src/repo-graph/module-resolve";

const mods = ["src/cli/", "src/daemon/", "src/critic/"];

test("exact segment match resolves", () => {
  expect(resolveModuleName("daemon", mods)).toEqual({ kind: "found", id: "src/daemon/" });
});
test("small typo resolves within threshold", () => {
  expect(resolveModuleName("daemn", mods)).toEqual({ kind: "found", id: "src/daemon/" });
});
test("unknown name is phantom, no suggestion leaked", () => {
  expect(resolveModuleName("authService", mods)).toEqual({ kind: "phantom" });
});
