// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, mkdirSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

export interface BundleSpec {
  entry: string;
  out: string;
  /**
   * Module specifiers Bun.build must NOT bundle (left as a runtime
   * `require`/`import`). Needed for deps that ship native (.node) addons —
   * bundling them makes Bun.build copy the platform-specific binary next to
   * the output, which breaks the plugin's cross-platform distribution (a
   * Linux/Windows install would ship + fail to load a Darwin-only .node).
   * Only the daemon entry pulls in such a dep (fastembed, via the few-shot /
   * repo-memory routes' lazy embedder) — see src/few-shot/embedder.ts.
   */
  external?: string[];
}

export const BUNDLES: BundleSpec[] = [
  // external fastembed: the Stop-hook now reaches the few-shot chain (anti-
  // examples wiring), which pulls fastembed → @anush008/tokenizers, a
  // PLATFORM-SPECIFIC native binding. Bundling it embeds a darwin/linux .node +
  // an absolute __dirname, breaking check:dist's cross-platform byte-compare.
  // Externalizing keeps it out (same as the daemon below); embedder.ts already
  // falls back to a stub when fastembed can't be resolved at runtime.
  { entry: "src/hooks/on-stop.ts", out: "dist/siltpoke-stop.js", external: ["fastembed"] },
  { entry: "src/hooks/on-distil-worker.ts", out: "dist/siltpoke-distil.js" },
  { entry: "src/face/wrapper.ts", out: "dist/siltpoke-card.js" },
  {
    // src/cli/daemon.ts, NOT src/daemon/server.ts: server.ts only EXPORTS
    // startDaemon/stopDaemon — a bundle of it is a library with no entry point,
    // so `bun dist/siltpoke-daemon.js start` would exit 0 having served nothing.
    // The autostart shim (installer/shim.ts) execs this bundle, so it has to be
    // the runnable CLI (start | stop | status | restart | install-autostart).
    entry: "src/cli/daemon.ts",
    out: "dist/siltpoke-daemon.js",
    external: ["fastembed"],
  },
  { entry: "src/cli/configure.ts", out: "dist/siltpoke-configure.js" },
  {
    // The command surface. Every non-setup slash command shells out to this one
    // bundle (`… /dist/siltpoke-cli.js <subcommand>`) — a plugin cache has no
    // `src/` and no `node_modules`, so the commands cannot invoke `src/cli/*.ts`
    // directly. See src/cli/plugin-cli.ts.
    entry: "src/cli/plugin-cli.ts",
    out: "dist/siltpoke-cli.js",
  },
  // external fastembed for the same reason as siltpoke-stop above (codex-stop
  // reaches handle-stop → the few-shot chain). agy-stop does NOT: it's a thin
  // dispatcher that Bun.spawns dist/siltpoke-stop.js, so it never bundles the
  // chain and needs no external.
  { entry: "src/hooks/codex-stop.ts", out: "dist/codex-stop.js", external: ["fastembed"] },
  { entry: "src/hooks/agy-stop.ts", out: "dist/agy-stop.js" },
  { entry: "src/hooks/handle-session-start.ts", out: "dist/handle-session-start.js" },
  // The repo indexer, spawned by the daemon's dashboard "Index a repo" flow.
  // It MUST be a bundle: the daemon itself runs as dist/siltpoke-daemon.js, and
  // a plugin cache ships no `src/` and no `node_modules`, so a `.ts` target is
  // unspawnable there. Before this entry existed the daemon spawned
  // `join(import.meta.dir, "../../cli/index-repo.ts")` — correct from source,
  // two levels above the repo root from dist/ — so every dashboard index died
  // with `Module not found`. Landing here makes it a sibling of the daemon
  // bundle, which is what resolveIndexerTarget() relies on.
  { entry: "src/cli/index-repo.ts", out: "dist/siltpoke-index-repo.js" },
];

export const WASM_SOURCES: string[] = [
  "node_modules/web-tree-sitter/web-tree-sitter.wasm",
  "node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm",
  "node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm",
  "node_modules/tree-sitter-python/tree-sitter-python.wasm",
];

/**
 * Runtime template files the bundles `readFile` at run time (NOT inlined by
 * Bun.build — a `readFile(join(here, "x.md"))` is resolved live against the
 * bundle's own directory). They must sit flat next to the bundles in dist/,
 * or the plugin install (which has no `src/`) can't find them and the review
 * degrades to no personality/language prompt. The stop bundle reads
 * system-prompt.md via `buildSystemPrompt` (src/brain/personality.ts), whose
 * `here = dirname(import.meta.url)` resolves to dist/ once bundled.
 *
 * Sibling of the static.ts + cwd launchd-runs-dist path bugs.
 */
export const ASSET_SOURCES: string[] = [
  "src/brain/system-prompt.md",
];

/**
 * Runs the actual `Bun.build` call for one bundle spec, into `outdir`.
 *
 * Pulled out of `buildAll()` so tests can exercise this exact wiring —
 * including the `...(external ? { external } : {})` spread — against a real
 * `Bun.build` invocation and a scratch outdir, instead of only asserting on
 * the static `BundleSpec` object (see tests/scripts/build-dist.test.ts).
 */
export async function buildBundle(
  { entry, out, external }: BundleSpec,
  outdir: string,
): Promise<Bun.BuildOutput> {
  return Bun.build({
    entrypoints: [entry],
    target: "bun",
    outdir,
    naming: basename(out),
    ...(external ? { external } : {}),
  });
}

export async function buildAll(): Promise<void> {
  mkdirSync("dist/wasm", { recursive: true });

  for (const spec of BUNDLES) {
    const { entry, out } = spec;
    if (!existsSync(entry)) {
      console.log(`skip ${entry} (not written yet)`);
      continue;
    }
    const result = await buildBundle(spec, "dist");
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`bundle failed: ${entry}`);
    }
    console.log(`built ${out}`);
  }

  for (const src of WASM_SOURCES) {
    copyFileSync(src, join("dist/wasm", basename(src)));
    console.log(`copied ${basename(src)}`);
  }

  for (const src of ASSET_SOURCES) {
    copyFileSync(src, join("dist", basename(src)));
    console.log(`copied ${basename(src)}`);
  }

  copyAgyPluginSelfContained();
}

/**
 * agy `plugin install <repo>/.antigravity-plugin` copies ONLY that subdir
 * (proven by the live spike, an internal design note
 * Approach A) — an agy-native install never sees the rest of the repo. So the
 * manifest's wrapper (hooks/agy-stop.sh) and the bundle it execs
 * (dist/agy-stop.js) must be duplicated INSIDE .antigravity-plugin/ itself, or
 * the shipped plugin has a hooks.json pointing at files that don't exist.
 *
 * Must run after the BUNDLES loop above — dist/agy-stop.js is the copy
 * source and only exists once that bundle has been built.
 *
 * These copies are build-generated, not source: .antigravity-plugin/hooks/
 * and .antigravity-plugin/dist/ are gitignored. Only plugin.json + hooks.json
 * (the hand-authored manifest) are committed.
 */
function copyAgyPluginSelfContained(): void {
  const pluginDir = join(".antigravity-plugin");
  const hooksDir = join(pluginDir, "hooks");
  const distDir = join(pluginDir, "dist");

  mkdirSync(hooksDir, { recursive: true });

  // Ship the FULL dist/ tree, not just agy-stop.js. agy-stop.js is only a thin
  // dispatcher: it spawns its sibling dist/siltpoke-stop.js (the real on-stop
  // review pipeline), which in turn loads dist/index.js + the tree-sitter wasm
  // + system-prompt.md + a data file at runtime. Copying agy-stop.js alone left
  // the detached on-stop spawn pointing at a nonexistent target, so the plugin
  // installed and the Stop hook fired but reviewed NOTHING (silent no-op).
  rmSync(distDir, { recursive: true, force: true });
  cpSync("dist", distDir, { recursive: true });
  console.log("copied full dist/ -> .antigravity-plugin/dist/");

  copyFileSync("hooks/agy-stop.sh", join(hooksDir, "agy-stop.sh"));
  console.log("copied .antigravity-plugin/hooks/agy-stop.sh");
}

if (import.meta.main) {
  await buildAll();
}
