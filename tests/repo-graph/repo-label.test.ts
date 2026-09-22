// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { repoDisplayName } from "../../src/repo-graph/repo-label";

describe("repoDisplayName", () => {
  test("a folder inside a repo → `repo / relative path`", () => {
    expect(repoDisplayName({ proj_hash: "h", project_root: "/p/kata/TypeScript/src", repo_root: "/p/kata" })).toBe("kata / TypeScript/src");
  });
  test("no repo_root (the repo itself, or an old index) → the folder name, as before", () => {
    expect(repoDisplayName({ proj_hash: "h", project_root: "/p/kata" })).toBe("kata");
    expect(repoDisplayName({ proj_hash: "h", project_root: "/p/kata", repo_root: null })).toBe("kata");
  });
  test("a repo_root that does not contain the root is ignored, not rendered as ../", () => {
    expect(repoDisplayName({ proj_hash: "h", project_root: "/p/kata-2", repo_root: "/p/kata" })).toBe("kata-2");
  });
  test("no project_root → the hash", () => {
    expect(repoDisplayName({ proj_hash: "abc123abc123", project_root: null })).toBe("abc123abc123");
  });
});
