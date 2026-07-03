/** @jsxImportSource hono/jsx */
import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import {
  mountPreviewRoutes,
  buildRegistry,
  loadDefaultRegistry,
  type PreviewModule,
} from "../../../src/web/routes/preview";

function _fakeRegistry(): { entries: PreviewModule[] } {
  return buildRegistry({
    "../atoms/Card.preview.tsx": {
      default: [
        { name: "default", render: () => "card-default-html" },
        { name: "elevated", render: () => "card-elevated-html" },
      ],
    },
    "../atoms/Pill.preview.tsx": {
      default: [{ name: "default", render: () => "pill-default-html" }],
    },
    "../shells/Dashboard.preview.tsx": {
      default: [{ name: "default", render: () => "dashboard-shell-html" }],
    },
  }) as unknown as { entries: PreviewModule[] };
}

describe("buildRegistry", () => {
  test("parses category + componentName from path", () => {
    const reg = buildRegistry({
      "../atoms/Card.preview.tsx": { default: [] },
    });
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0]?.category).toBe("atoms");
    expect(reg.entries[0]?.componentName).toBe("Card");
    expect(reg.entries[0]?.slug).toBe("atoms-card");
  });

  test("ignores files not matching the preview convention", () => {
    const reg = buildRegistry({
      "../atoms/Card.tsx": { default: [] },
      "../atoms/Card.preview.tsx": { default: [] },
      "../random.preview.tsx": { default: [] },
    });
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0]?.componentName).toBe("Card");
  });

  test("sorts by category then componentName", () => {
    const reg = buildRegistry({
      "../shells/Wizard.preview.tsx": { default: [] },
      "../atoms/Pill.preview.tsx": { default: [] },
      "../atoms/Card.preview.tsx": { default: [] },
    });
    expect(reg.entries.map((e) => e.slug)).toEqual([
      "atoms-card",
      "atoms-pill",
      "shells-wizard",
    ]);
  });
});

describe("/dev/preview routes (dev mode)", () => {
  function app() {
    const a = new Hono();
    const reg = buildRegistry({
      "../atoms/Card.preview.tsx": {
        default: [
          { name: "default", render: () => "card-default-html" },
          { name: "elevated", render: () => "card-elevated-html" },
        ],
      },
      "../atoms/Pill.preview.tsx": {
        default: [{ name: "default", render: () => "pill-default-html" }],
      },
      "../shells/Dashboard.preview.tsx": {
        default: [{ name: "default", render: () => "dashboard-shell-html" }],
      },
    });
    const r = mountPreviewRoutes(a, { enabled: true, registry: reg });
    return { app: a, mounted: r.mounted };
  }

  test("index page lists every registered slug grouped by category", async () => {
    const { app: a, mounted } = app();
    expect(mounted).toBe(true);
    const res = await a.request("/dev/preview");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/dev/preview/atoms-card");
    expect(html).toContain("/dev/preview/atoms-pill");
    expect(html).toContain("/dev/preview/shells-dashboard");
    expect(html).toContain("atoms (2)");
    expect(html).toContain("shells (1)");
  });

  test("per-slug page renders all stories for that component", async () => {
    const { app: a } = app();
    const res = await a.request("/dev/preview/atoms-card");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("card-default-html");
    expect(html).toContain("card-elevated-html");
    expect(html).toContain("default");
    expect(html).toContain("elevated");
  });

  test("unknown slug returns 404", async () => {
    const { app: a } = app();
    const res = await a.request("/dev/preview/bogus-slug");
    expect(res.status).toBe(404);
  });

  test("empty registry shows hint message", async () => {
    const a = new Hono();
    mountPreviewRoutes(a, {
      enabled: true,
      registry: buildRegistry({}),
    });
    const res = await a.request("/dev/preview");
    const html = await res.text();
    expect(html).toContain("no preview files registered");
  });
});

describe("loadDefaultRegistry", () => {
  test("scans the real src/web/{atoms,primitives,creature,shells} tree", async () => {
    // Pin the wire that was previously missing — server.ts must hand the
    // result of this helper to mountPreviewRoutes, otherwise /dev/preview
    // shows zero entries despite ~20 .preview.tsx files on disk.
    const reg = await loadDefaultRegistry();
    expect(reg.entries.length).toBeGreaterThan(0);
    // Every shipped category should contribute at least one entry.
    const cats = new Set(reg.entries.map((e) => e.category));
    expect(cats.has("atoms")).toBe(true);
    expect(cats.has("primitives")).toBe(true);
    expect(cats.has("creature")).toBe(true);
    expect(cats.has("shells")).toBe(true);
  });
});

describe("/dev/preview env gate", () => {
  test("does NOT mount when enabled=false (prod sim)", async () => {
    const a = new Hono();
    const r = mountPreviewRoutes(a, { enabled: false });
    expect(r.mounted).toBe(false);
    const res = await a.request("/dev/preview");
    expect(res.status).toBe(404);
  });

  test("mounts when enabled=true", async () => {
    const a = new Hono();
    const r = mountPreviewRoutes(a, { enabled: true });
    expect(r.mounted).toBe(true);
    const res = await a.request("/dev/preview");
    expect(res.status).toBe(200);
  });

  test("respects SILTPOKE_ENV=production when option omitted", async () => {
    const prev = process.env.SILTPOKE_ENV;
    process.env.SILTPOKE_ENV = "production";
    try {
      const a = new Hono();
      const r = mountPreviewRoutes(a);
      expect(r.mounted).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SILTPOKE_ENV;
      else process.env.SILTPOKE_ENV = prev;
    }
  });

  test("mounts when SILTPOKE_ENV is unset (dev default)", async () => {
    const prev = process.env.SILTPOKE_ENV;
    delete process.env.SILTPOKE_ENV;
    try {
      const a = new Hono();
      const r = mountPreviewRoutes(a);
      expect(r.mounted).toBe(true);
    } finally {
      if (prev !== undefined) process.env.SILTPOKE_ENV = prev;
    }
  });
});
