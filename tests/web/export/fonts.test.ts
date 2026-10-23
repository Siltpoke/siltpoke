import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fontFaceCss } from "../../../src/web/client/export/fonts";

const FONT_DIR = join(import.meta.dir, "../../../public/static/fonts");
/** The vendored export files, read from disk so the list and the files cannot drift.
 * `Dash-*` files in the same folder are the dashboard's own (scripts/vendor-dashboard-fonts.ts). */
const onDisk = (): string[] =>
  readdirSync(FONT_DIR)
    .filter((f) => f.endsWith(".woff2") && !f.startsWith("Dash-"))
    .sort();
/** What each vendored file must be declared as — the intent of the font set. */
const DECLARED: Record<string, { family: string; weight: number }> = {
  "PixelifySans-SemiBold.woff2": { family: "Pixelify Sans", weight: 600 },
  "Geist-Regular.woff2": { family: "Geist", weight: 400 },
  "Geist-Medium.woff2": { family: "Geist", weight: 500 },
  "JetBrainsMono-Regular.woff2": { family: "JetBrains Mono", weight: 400 },
};

function makeFetch() {
  const calls: string[] = [];
  // Payload factory: a shared Response body can only be read once. The body is
  // the file's own name, so a rule's data URI says which file it came from.
  const impl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(new TextEncoder().encode(String(url).split("/").pop()));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("export fonts", () => {
  test("fontFaceCss returns one base64 @font-face rule per vendored file, then caches", async () => {
    const files = onDisk();
    expect(files.length).toBeGreaterThan(0);
    const { impl, calls } = makeFetch();
    const css = await fontFaceCss(impl);
    const rules = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBe(files.length);
    expect(calls.map((c) => c.split("/").pop()).sort()).toEqual(files);
    for (const rule of rules) {
      const b64 = /base64,([A-Za-z0-9+/=]+)\)/.exec(rule)?.[1] ?? "";
      const file = Buffer.from(b64, "base64").toString();
      const want = DECLARED[file];
      expect(want).toBeDefined();
      expect(rule).toContain(`font-family: "${want?.family}"`);
      expect(rule).toContain(`font-weight: ${want?.weight}`);
      expect(rule).toContain("src: url(data:font/woff2;base64,");
    }
    expect(Object.keys(DECLARED).sort()).toEqual(files);
    const before = calls.length;
    const again = await fontFaceCss(impl);
    expect(again).toBe(css);
    expect(calls.length).toBe(before);
  });

  test("one OFL licence per family exists on disk", async () => {
    const css = await fontFaceCss(makeFetch().impl);
    const families = new Set([...css.matchAll(/font-family: "([^"]+)"/g)].map((m) => m[1] as string));
    expect(families.size).toBe(3);
    for (const family of families) {
      expect(existsSync(join(FONT_DIR, `OFL-${family.replace(/ /g, "")}.txt`))).toBe(true);
    }
  });
});
