// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /dev/preview — filesystem-scanned component preview router.
 *
 * Discovers every sibling `<Name>.preview.tsx` in atoms / primitives /
 * shells / creature directories. Each preview file's default export is an
 * array of `{ name, render() }` story objects. The route serves an index
 * listing all entries grouped by category and a per-slug page rendering
 * one component's stories.
 *
 * Mounted ONLY when SILTPOKE_ENV !== "production". Gating at registration
 * time means zero overhead in prod — the routes simply don't exist.
 */
import type { Hono } from "hono";
import { Layout } from "../_shared/layout";
import { tokens } from "../tokens/tokens";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PreviewStory {
  name: string;
  render: () => unknown;
}

export type PreviewModule = {
  default?: PreviewStory[];
};

export interface PreviewEntry {
  slug: string;
  category: "atoms" | "primitives" | "creature" | "shells";
  componentName: string;
  module: PreviewModule;
}

export interface PreviewRegistry {
  entries: PreviewEntry[];
}

/**
 * Build a registry from an `import.meta.glob`-style record of module
 * specifiers → eager-imported modules. Exposed as a pure helper so tests
 * can hand-feed a fixture registry without scanning the FS.
 */
export function buildRegistry(
  modules: Record<string, PreviewModule>,
): PreviewRegistry {
  const entries: PreviewEntry[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    // path looks like "../atoms/Card.preview.tsx"
    const match = path.match(
      /\/(atoms|primitives|creature|shells)\/(\w+)\.preview\.tsx$/,
    );
    if (!match) continue;
    const category = match[1]! as PreviewEntry["category"];
    const componentName = match[2]!;
    const slug = `${category}-${componentName.toLowerCase()}`;
    entries.push({ slug, category, componentName, module: mod });
  }
  entries.sort((a, b) =>
    a.category === b.category
      ? a.componentName.localeCompare(b.componentName)
      : a.category.localeCompare(b.category),
  );
  return { entries };
}

function PreviewIndex(props: { registry: PreviewRegistry }) {
  const byCategory = new Map<string, PreviewEntry[]>();
  for (const e of props.registry.entries) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e);
    byCategory.set(e.category, list);
  }
  return (
    <Layout title="siltpoke / dev preview">
      <main
        style={{
          maxWidth: "780px",
          margin: "0 auto",
          padding: tokens.space["6"],
          fontFamily: tokens.font.body,
        }}
      >
        <h1
          style={{
            fontFamily: tokens.font.display,
            color: tokens.color.terra,
            marginBottom: tokens.space["6"],
          }}
        >
          siltpoke / dev preview
        </h1>
        {Array.from(byCategory.entries()).map(([cat, entries]) => (
          <section style={{ marginBottom: tokens.space["6"] }}>
            <h2
              style={{
                fontFamily: tokens.font.mono,
                fontSize: "14px",
                color: tokens.color.ink2,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: tokens.space["3"],
              }}
            >
              {cat} ({entries.length})
            </h2>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
              }}
            >
              {entries.map((e) => (
                <li style={{ marginBottom: tokens.space["1_5"] }}>
                  <a
                    href={`/dev/preview/${e.slug}`}
                    style={{
                      color: tokens.color.ink,
                      textDecoration: "none",
                      fontFamily: tokens.font.mono,
                      fontSize: "13px",
                    }}
                  >
                    /dev/preview/{e.slug}
                    {"  "}— {e.componentName}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {props.registry.entries.length === 0 ? (
          <p
            style={{
              color: tokens.color.ink3,
              fontFamily: tokens.font.mono,
            }}
          >
            no preview files registered. add a sibling `&lt;Name&gt;.preview.tsx`
            in src/web/atoms/, primitives/, creature/, or shells/.
          </p>
        ) : null}
      </main>
    </Layout>
  );
}

function PreviewPage(props: { entry: PreviewEntry }) {
  const stories = props.entry.module.default ?? [];
  return (
    <Layout title={`preview / ${props.entry.componentName}`}>
      <main
        style={{
          maxWidth: "780px",
          margin: "0 auto",
          padding: tokens.space["6"],
        }}
      >
        <nav style={{ marginBottom: tokens.space["4"] }}>
          <a
            href="/dev/preview"
            style={{
              color: tokens.color.ink3,
              fontFamily: tokens.font.mono,
              fontSize: "12px",
              textDecoration: "none",
            }}
          >
            ← all previews
          </a>
        </nav>
        <h1
          style={{
            fontFamily: tokens.font.display,
            color: tokens.color.terra,
            marginBottom: tokens.space["2"],
          }}
        >
          {props.entry.componentName}
        </h1>
        <div
          style={{
            color: tokens.color.ink3,
            fontFamily: tokens.font.mono,
            fontSize: "12px",
            marginBottom: tokens.space["6"],
          }}
        >
          {props.entry.category} · {stories.length} story
          {stories.length === 1 ? "" : "es"}
        </div>
        {stories.length === 0 ? (
          <p
            style={{
              color: tokens.color.ink3,
              fontFamily: tokens.font.mono,
            }}
          >
            no stories defined. add a default export array of {`{name, render}`}.
          </p>
        ) : (
          stories.map((s) => (
            <section
              style={{
                marginBottom: tokens.space["6"],
                padding: tokens.space["4"],
                background: tokens.color.paper,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.color.edge}`,
              }}
            >
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: "11px",
                  color: tokens.color.ink3,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  marginBottom: tokens.space["3"],
                }}
              >
                {s.name}
              </div>
              <div>{s.render() as unknown}</div>
            </section>
          ))
        )}
      </main>
    </Layout>
  );
}

export interface MountPreviewOptions {
  /** When omitted, defaults to `process.env.SILTPOKE_ENV !== "production"`. */
  enabled?: boolean;
  /**
   * Pre-built registry override. When omitted, callers should provide an
   * `import.meta.glob`-derived registry from the daemon assembly site.
   */
  registry?: PreviewRegistry;
}

/**
 * Default registry builder — scans the four preview directories via
 * Bun.Glob and dynamically imports every `<Name>.preview.tsx` found.
 *
 * Async because dynamic imports are async; callers must `await` before
 * mounting routes. In production the caller skips this entirely (no
 * env-gated overhead — the routes aren't mounted at all).
 */
export async function loadDefaultRegistry(): Promise<PreviewRegistry> {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = src/web/routes; siblings under src/web/{atoms,primitives,creature,shells}
  const webRoot = join(here, "..");
  const glob = new Bun.Glob("{atoms,primitives,creature,shells}/*.preview.tsx");
  const modules: Record<string, PreviewModule> = {};
  for await (const rel of glob.scan({ cwd: webRoot, absolute: false })) {
    const abs = join(webRoot, rel);
    const mod = (await import(abs)) as PreviewModule;
    // buildRegistry's regex expects a leading slash before the category
    // segment; prefix the relative path so it matches uniformly.
    modules[`/${rel}`] = mod;
  }
  return buildRegistry(modules);
}

export function mountPreviewRoutes(
  app: Hono,
  opts: MountPreviewOptions = {},
): { mounted: boolean } {
  const enabled = opts.enabled ?? process.env.SILTPOKE_ENV !== "production";
  if (!enabled) return { mounted: false };
  const registry = opts.registry ?? { entries: [] };

  app.get("/dev/preview", (c) => c.html(<PreviewIndex registry={registry} />));
  app.get("/dev/preview/:slug", (c) => {
    const slug = c.req.param("slug");
    const entry = registry.entries.find((e) => e.slug === slug);
    if (!entry) return c.text("not found", 404);
    return c.html(<PreviewPage entry={entry} />);
  });
  return { mounted: true };
}
