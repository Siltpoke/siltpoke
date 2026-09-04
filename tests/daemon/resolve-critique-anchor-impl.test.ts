// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Unit tests for `resolveCritiqueAnchorImpl` (Task 4 — server.ts
 * binding). Covers the Task 3 review finding (B): `proj_hash` is untrusted
 * request input (it only passed `isValidCritiqueAnchor`'s TYPE-only check
 * at the route boundary) and must be FORMAT-validated with the real
 * `isValidProjHash` guard BEFORE it reaches `resolveRepoByHash`'s path join
 * — never a hand-rolled regex, never a throw on malformed input.
 *
 * Deps are injected (not the real `resolveRepoByHash` / `resolveCritiqueContext`)
 * so the format guard is provably exercised BEFORE any repo/path resolution
 * — a spy proves `resolveRepoByHash` is never even called for a malformed hash.
 */
import { describe, expect, test } from "bun:test";
import type { AnchorContext } from "../../src/chat/anchor-context";
import type { ResolveCritiqueResult } from "../../src/chat/critique-context";
import { resolveCritiqueAnchorImpl } from "../../src/daemon/server";
import { GLOBAL_ONLY } from "../../src/memory/memory";
import type { RepoLocationByHash } from "../../src/repo-graph/repo-registry";

const RESOLVED_CTX: AnchorContext = {
  nodeId: "c-1a2b",
  nodeName: "critique c-1a2b",
  nodeType: "critique",
  path: "/repo",
  contextBundle: "bundle",
  systemPrompt: "prompt",
  fingerprint: null,
  includedSources: [],
  truncated: false,
};

describe("resolveCritiqueAnchorImpl — proj_hash format guard (Task 4 review finding B)", () => {
  test("malformed proj_hash → critique_not_found WITHOUT calling resolveRepoByHash", async () => {
    let repoByHashCalls = 0;
    const resolveRepoByHash = async (): Promise<RepoLocationByHash | null> => {
      repoByHashCalls += 1;
      return null;
    };
    let critiqueContextCalls = 0;
    const resolveCritiqueContext = async (): Promise<ResolveCritiqueResult> => {
      critiqueContextCalls += 1;
      return { kind: "resolved", context: RESOLVED_CTX };
    };

    // Not 12 lowercase hex chars — path-traversal-shaped, uppercase, and
    // too-short variants all must be refused BEFORE any path-touching call.
    for (const badHash of ["../../etc/passwd", "ABC123ABC123", "short", ""]) {
      const result = await resolveCritiqueAnchorImpl(
        { proj_hash: badHash, critique_id: "c-1a2b" },
        { homeBase: "/tmp/irrelevant", resolveRepoByHash, resolveCritiqueContext },
      );
      expect(result).toEqual({ kind: "critique_not_found", critique_id: "c-1a2b" });
    }

    // The format guard short-circuits: neither downstream fn is ever invoked
    // for a malformed hash — proves the guard runs BEFORE repo/path resolution,
    // not merely that resolveRepoByHash happens to also reject it internally.
    expect(repoByHashCalls).toBe(0);
    expect(critiqueContextCalls).toBe(0);
  });

  test("well-formed proj_hash that resolves to a repo → memScope is the project_root", async () => {
    const resolveRepoByHash = async (): Promise<RepoLocationByHash | null> => ({
      proj_hash: "abc123abc123",
      storage_dir: "/home/.siltpoke/repo-memory/abc123abc123",
      project_root: "/Users/dev/my-project",
    });
    let capturedMemScope: unknown;
    const resolveCritiqueContext = async (input: {
      critiqueId: string;
      homeBase: string;
      memScope: unknown;
      now: Date;
    }): Promise<ResolveCritiqueResult> => {
      capturedMemScope = input.memScope;
      return { kind: "resolved", context: RESOLVED_CTX };
    };

    const result = await resolveCritiqueAnchorImpl(
      { proj_hash: "abc123abc123", critique_id: "c-1a2b" },
      { homeBase: "/home/.siltpoke", resolveRepoByHash, resolveCritiqueContext },
    );

    expect(result.kind).toBe("resolved");
    expect(capturedMemScope).toBe("/Users/dev/my-project");
  });

  test("well-formed proj_hash with NO resolvable repo → memScope falls back to GLOBAL_ONLY", async () => {
    const resolveRepoByHash = async (): Promise<RepoLocationByHash | null> => null;
    let capturedMemScope: unknown;
    const resolveCritiqueContext = async (input: {
      critiqueId: string;
      homeBase: string;
      memScope: unknown;
      now: Date;
    }): Promise<ResolveCritiqueResult> => {
      capturedMemScope = input.memScope;
      return { kind: "critique_not_found", critique_id: input.critiqueId };
    };

    await resolveCritiqueAnchorImpl(
      { proj_hash: "abc123abc123", critique_id: "c-1a2b" },
      { homeBase: "/home/.siltpoke", resolveRepoByHash, resolveCritiqueContext },
    );

    expect(capturedMemScope).toBe(GLOBAL_ONLY);
  });
});
