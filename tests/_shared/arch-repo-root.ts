// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Repo-root fixtures for the reviewer-external reconcile scope.
 *
 * `resolveExternalScope` gates registry-declared injection on the registry's
 * evidence anchor (`src/brain/registry.ts`, and the token that must sit on the
 * cited LINE) actually being present in the repo being analyzed. Tests that want
 * the injection therefore need a root that carries it, and tests that want the
 * foreign-repo behaviour need one that does not.
 *
 * Both are real tmp dirs rather than `process.cwd()` so the tests state their own
 * premise instead of borrowing siltpoke's tree — a checkout that ever moved
 * `src/brain/registry.ts` would otherwise turn these into silent no-ops.
 *
 * Every root created here is tracked so a suite can remove them; call
 * `cleanupArchRepoRoots()` from `afterAll`. Without it a full run leaves dozens
 * of orphaned directories under $TMPDIR.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAMILY_BINARY_ANCHOR_LINE, FAMILY_BINARY_ANCHOR_TOKEN } from "../../src/brain/registry";

const created: string[] = [];

function track(root: string): string {
  created.push(root);
  return root;
}

/** Remove every fixture root made by this module. Safe to call more than once. */
export function cleanupArchRepoRoots(): void {
  while (created.length > 0) {
    const root = created.pop()!;
    rmSync(root, { recursive: true, force: true });
  }
}

/** Give an EXISTING directory the registry anchor, so the repo rooted there
 * resolves in scope. Exported because route-level tests own their own tmp repo
 * (created by their own `beforeEach`) and must not hand-roll the file: writing
 * `// anchor` at the wrong line looks right and silently fails the check. */
export function writeRegistryAnchor(root: string): void {
  mkdirSync(join(root, "src", "brain"), { recursive: true });
  const lines = Array.from({ length: FAMILY_BINARY_ANCHOR_LINE }, (_, i) =>
    i === FAMILY_BINARY_ANCHOR_LINE - 1
      ? `export function ${FAMILY_BINARY_ANCHOR_TOKEN}(family) { return null; }`
      : "// filler",
  );
  writeFileSync(join(root, "src", "brain", "registry.ts"), `${lines.join("\n")}\n`);
}

/** A repo root that DOES carry the registry anchor → externals stay in scope.
 *
 * The anchor token is written ON the cited line, not merely somewhere in the
 * file: the scope check reads that specific line, so a fixture that only has the
 * right filename would (correctly) fail to resolve. */
export function anchoredRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "arch-anchored-"));
  writeRegistryAnchor(root);
  return track(root);
}

/** A repo root with NO registry anchor → the foreign-repo case (scope empties). */
export function foreignRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "arch-foreign-"));
  mkdirSync(join(root, "src", "app"), { recursive: true });
  writeFileSync(join(root, "src", "app", "index.ts"), "// unrelated repo\n");
  return track(root);
}

/** A repo that happens to have a file at the same PATH, but whose cited line is
 * unrelated content — the lookalike the path-only check could not tell apart. */
export function lookalikeRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "arch-lookalike-"));
  mkdirSync(join(root, "src", "brain"), { recursive: true });
  const lines = Array.from({ length: FAMILY_BINARY_ANCHOR_LINE + 5 }, () => "// some other project's registry");
  writeFileSync(join(root, "src", "brain", "registry.ts"), `${lines.join("\n")}\n`);
  return track(root);
}
