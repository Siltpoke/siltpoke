import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoAbsolutePaths, findPathShaped, findSecretShaped, findSecretShapedInMarkup } from "../../../src/web/client/export/privacy";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import { buildAppendixMd } from "../../../src/web/client/export/appendix";
import { fontFaceCss } from "../../../src/web/client/export/fonts";
import { STAMP, model, trust } from "./fixtures";

describe("assertNoAbsolutePaths", () => {
  const bad = ["/Users/x/a", "/home/x/a", "/root/x", "/Volumes/x", "/mnt/x", "/var/folders/x", "/private/var/x", "/run/user/x",
    "C:\\Users\\a", "c:/users/a", "D:\\Documents and Settings\\a", "\\\\srv\\a", '<text>/Users/x/a.ts</text>', 'x="/home/x/passwd"',
    // escaped-quote and odd-neighbour probes (the char before `/` is `;` or a symbol after esc())
    "say &quot;/Users/x/a&quot;", "it&#39;s &#39;/home/x/a&#39;", "path:/Users/x", "a;/home/x", "→/Users/x",
    "file:///Users/x", "file://anything", "FILE://x", "(📁 /Users/x)", "&lt;/Users/x&gt;", "a&amp;b &quot;/root/a&quot;",
  ];
  for (const s of bad) {
    test(`throws on ${JSON.stringify(s)}`, () => {
      expect(() => assertNoAbsolutePaths(s)).toThrow(/^absolute path in export: /);
    });
  }
  const ok = [
    "src/a.ts",
    "<outside repo>",
    "a/b:12",
    "AI listed 2 / 4 files",
    '<rect x="1"/></text><path d="M0 0"/>',
    'xmlns="http://www.w3.org/2000/svg"',
    'd="M10 20 L30 40"', "reads/writes", "src/a/", "</text>", '"/>', '"M0 0"',
    'href="https://example.com/a/b"', "say &quot;src/a&quot;",
    // roots need a following segment, and POSIX roots are case-sensitive (decision 2026-09-29)
    "/home", "/Users", "/Users/", "/home/ x", "/users/login", "POST /Home/x", "src/Users.ts", "~/.config", "\\\\d+", "\\\\host alone",
  ];
  for (const s of ok) {
    test(`passes on ${JSON.stringify(s)}`, () => {
      expect(() => assertNoAbsolutePaths(s)).not.toThrow();
    });
  }
});

describe("assertNoAbsolutePaths details", () => {
  test("the error names the offending token", () => {
    expect(() => assertNoAbsolutePaths("say &quot;/Users/x/a&quot; ok")).toThrow("absolute path in export: /Users/x/a");
    expect(() => assertNoAbsolutePaths("f: file:///Users/x")).toThrow("absolute path in export: file:///Users/x");
    expect(() => assertNoAbsolutePaths("C:\\Users\\a\\b")).toThrow("absolute path in export: C:\\Users\\a\\b");
    expect(() => assertNoAbsolutePaths("\\\\srv\\share\\a")).toThrow("absolute path in export: \\\\srv\\share\\a");
    // trailing markup punctuation is trimmed from the reported token
    expect(() => assertNoAbsolutePaths("&lt;/Users/x&gt;")).toThrow(/^absolute path in export: \/Users\/x$/);
  });
  test("a real embedded woff2 data URI passes, and a path hidden in embedded CSS is cleared only when named", () => {
    const dir = join(import.meta.dir, "../../../public/static/fonts");
    const b64 = readFileSync(join(dir, "Geist-Regular.woff2")).toString("base64");
    const css = `@font-face{src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
    expect(() => assertNoAbsolutePaths(css)).not.toThrow();
    const own = "@font-face{src:url(/Users/v/fonts/a.woff2)}";
    expect(() => assertNoAbsolutePaths(`<defs><style>${own}</style></defs>`)).toThrow("absolute path in export: /Users/v/fonts/a.woff2");
    expect(() => assertNoAbsolutePaths(`<defs><style>${own}</style></defs>`, [own])).not.toThrow();
    // an empty "embedded" string must not blank out the text (split("") would space every character)
    expect(() => assertNoAbsolutePaths("/Users/alice", [""])).toThrow("absolute path in export: /Users/alice");
    // only the named string is cleared, not a different path next to it
    expect(() => assertNoAbsolutePaths(`${own} /home/me/x`, [own])).toThrow("absolute path in export: /home/me/x");
  });
});

describe("assertNoAbsolutePaths — nothing that imitates embedded content can hide a path", () => {
  for (const s of [
    "x;base64,/Users/x/a",
    "notes;base64,/home/me/secret",
    "url(data:font/woff2;base64,/Users/x/a)",
    "<text>data:font/woff2;base64,/Users/x</text>",
    // shapes that imitated the old skip rules (appendix is unescaped markdown)
    "## <style>/Users/x/y</style>",
    `url(data:font/woff2;base64,${"A".repeat(1100)}+/Users/x/y)`,
    "</home/me>",
    // path ended or preceded by punctuation
    "see /home/x!", "in /mnt/x?", "a|/root/z|b", "//Users/alice", "///home/x/y", "v2/Users/x",
  ]) {
    test(`throws on ${JSON.stringify(s)}`, () => {
      expect(() => assertNoAbsolutePaths(s)).toThrow("absolute path in export: /");
    });
  }
});

describe("assertNoAbsolutePaths on a real export", () => {
  const fontsDir = join(import.meta.dir, "../../../public/static/fonts");
  const fromDisk = (async (u: RequestInfo | URL) =>
    new Response(readFileSync(join(fontsDir, String(u).replace("/static/fonts/", ""))))) as typeof fetch;

  test("a built SVG with the real embedded fonts passes; a planted path in a title trips it", async () => {
    const fontCss = await fontFaceCss(fromDisk);
    for (const theme of ["light", "dark"] as const) {
      const clean = buildExportSvg(model(), trust(), { theme, fontCss, stampLine: STAMP }).svg;
      expect(clean.length).toBeGreaterThan(100_000);
      expect(clean).toContain(fontCss);
      expect(() => assertNoAbsolutePaths(clean, [fontCss])).not.toThrow();

      const m = model();
      const id = Object.keys(m.N)[0] as string;
      (m.N[id] as { title: string }).title = 'Reads "/Users/v/proj"';
      const planted = buildExportSvg(m, trust(), { theme, fontCss, stampLine: STAMP }).svg;
      expect(() => assertNoAbsolutePaths(planted, [fontCss])).toThrow("absolute path in export: /Users/v/proj");
    }
    expect(() => assertNoAbsolutePaths(buildAppendixMd(model(), trust(), STAMP))).not.toThrow();
  });
});

describe("findSecretShaped — invisible characters and entities cannot break a key's shape", () => {
  const key = `ghp_${"A".repeat(36)}`;
  for (const [label, text] of [
    ["zero-width space", `ghp_\u200b${"A".repeat(36)}`],
    ["soft hyphen", `AKIA\u00adIOSFODNN7EXAMPLE`],
    ["word joiner", `sk-${"a".repeat(16)}\u2060${"b".repeat(16)}`],
    ["numeric entity", `ghp&#95;${"A".repeat(36)}`],
  ] as const) {
    test(`catches a key split by a ${label}`, () => {
      expect(findSecretShaped([{ where: "t", text }])).toBe("t");
      expect(findSecretShapedInMarkup([{ where: "m", text: `<text>${text}</text>` }])).toBe("m");
    });
  }
  test("control: the plain key is caught and ordinary prose is not", () => {
    expect(findSecretShaped([{ where: "k", text: key }])).toBe("k");
    expect(findSecretShaped([{ where: "p", text: "sk- prefix and ghp_ prefix are token shapes" }])).toBeNull();
  });
});

describe("findSecretShaped", () => {
  const secrets = [
    "AKIAIOSFODNN7EXAMPLE",
    `ghp_${"a".repeat(36)}`,
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    `sk-${"b".repeat(32)}`,
    "xoxb-1-2-abc",
  ];
  const fields = ["title", "desc", "verb", "band label"];
  for (const secret of secrets) {
    for (const where of fields) {
      test(`hits ${secret.slice(0, 12)} in ${where}`, () => {
        const strings = [
          { where: "other", text: "ordinary prose" },
          { where, text: `prefix ${secret} suffix` },
        ];
        expect(findSecretShaped(strings)).toBe(where);
      });
    }
  }
  test("returns the FIRST hit's where", () => {
    expect(
      findSecretShaped([
        { where: "a", text: "AKIAIOSFODNN7EXAMPLE" },
        { where: "b", text: "xoxb-1-2-abc" },
      ]),
    ).toBe("a");
  });
  test("misses ordinary prose, including near-misses", () => {
    expect(
      findSecretShaped([
        { where: "a", text: "Handles the sk-learn adapter and a ghp_ prefix, AKIA short, task-runner-based skeleton" },
        { where: "b", text: "" },
      ]),
    ).toBeNull();
  });
});

describe("path shapes that got past the output scan (adversarial review, round 3)", () => {
  const leaks = [
    "/​Users/alice", // zero-width space after the slash
    "/­Users/alice", // soft hyphen
    "&#47;Users&#47;alice", // numeric entity (appendix is unescaped markdown)
    "&#x2F;Users/alice",
    "&sol;Users/alice",
    "&amp;#47;Users&amp;#47;alice", // double-encoded
    "<span>/</span>Users/alice", // inline HTML in markdown
    "C\u200b:\\Users\\alice", // invisible char inside a drive letter
    "\uff0fUsers\uff0falice", // fullwidth solidus reads as a path
    "foo<b></b>/Users/alice", // a removed tag must not glue text onto the path
  ];
  for (const s of leaks) {
    test(`output scan throws on ${JSON.stringify(s)}`, () => {
      expect(() => assertNoAbsolutePaths(`## ${s}`)).toThrow("absolute path in export:");
    });
    test(`pre-render check names the field for ${JSON.stringify(s)}`, () => {
      expect(findPathShaped([{ where: "ok", text: "fine" }, { where: "title of api", text: s }])).toBe("title of api");
    });
  }

  test("a path split by line-wrapping right after `/` is caught in the real SVG", async () => {
    const fontsDir = join(import.meta.dir, "../../../public/static/fonts");
    const fromDisk = (async (u: RequestInfo | URL) =>
      new Response(readFileSync(join(fontsDir, String(u).replace("/static/fonts/", ""))))) as typeof fetch;
    const fontCss = await fontFaceCss(fromDisk);
    const m = model();
    const id = Object.keys(m.N)[0] as string;
    // 14 wide glyphs glued to the path: the unbreakable run is cut by code point, right after its first `/`.
    (m.N[id] as { title: string }).title = "wwwwwwwwwwwwww/Users/alice/work/secret";
    const svg = buildExportSvg(m, trust(), { theme: "light", fontCss, stampLine: STAMP }).svg;
    // The title really is wrapped at the slash — otherwise this test proves nothing.
    expect(svg).toMatch(/\/<\/tspan><tspan[^>]*>Users\/alice/);
    expect(() => assertNoAbsolutePaths(svg, [fontCss])).toThrow("absolute path in export: /Users/alice");
  });

  const prose = ["v2/api", "I/O", "TCP/IP", "2026/09/29", "and/or", "w/o", "km/h", "1/2 of files", "~/.config",
    "https://a.com/b/c", "a/b/c", "reads/writes", "src/a.ts:12",
    "use <code>x</code> here", "a <em>b</em> c", "</etc>", "/tmp", "GET /health", "and /or"]; // well-formed tags are markup, not visible text
  for (const s of prose) {
    test(`no false block on ${JSON.stringify(s)}`, () => {
      expect(() => assertNoAbsolutePaths(`## ${s}`)).not.toThrow();
      expect(findPathShaped([{ where: "t", text: s }])).toBeNull();
    });
  }
});

// Confusable slashes, entities and Markdown shapes a reader sees as a personal path (cross-family review, 2026-09-29).
describe("look-alike and rendered shapes of a personal path", () => {
  const leaks = [
    // slash / backslash look-alikes that NFKC does not fold
    "\u2215Users\u2215alice", "\u2044Users\u2044alice", "\u29f8Users\u29f8alice", "\u2571Users\u2571alice",
    "C:\u29f5Users\u29f5alice", "\u29f5\u29f5server\u29f5share", "C:\u2216Users\u2216alice", "\u2216\u2216server\u2216share", "C:\u29f9Users\u29f9alice",
    "C:\uff3cUsers\uff3calice", "\ufe68\ufe68server\ufe68share",
    // round 5 (cross-family)
    "\ufe6fUsers\ufe6falice", "C:\u2572Users\u2572alice", "/\u034fUsers/alice", "/\u2066Users/alice", "/\ufe0fhome/bob/x",
    "/_Users_/alice", "/__home__/bob", "C:\\_Users_\\alice", "C:\\\\Users\\\\alice", "\\\\dev_server\\share",
    "/home/nodejs/app", "/home/node_alice/x", "file:///x", "a file://host/share/x link", "http://x/ then /Users/alice",
    // a local path glued onto a URL (no space, as Chinese prose writes it)
    "仓库https://github.com/a/b，本地/Users/sam/proj", "https://x.com,/Users/alice/secret",
    "https://x.com;/Users/alice/secret", "https://x.com/y|/home/alice/x", "see https://a.io/b（/Users/v/p）",
    // punctuation in a directory name
    "/Users/(archive)/notes", "/Users/[backup]/data", "/Users/{temp}/data", "/Users/!urgent/passwords",
    "/Users/*alice*/work", "/Users/**alice**/work", "/Users/`alice`",
    // Markdown markers around the ROOT: rendering removes them
    "/*Users*/alice", "/**Users**/alice", "/`Users`/alice", "/~~Users~~/alice",
    // comment, quoted `>` in an attribute, link text, attribute text
    "/Users/<!-- confidential -->alice", '/Users/<span title=">">alice', "[/Users](https://example.com)/alice",
    "[/](https://example.com)Users/alice", '<a href="/Users/alice/work">docs</a>',
    // entities that decode to an invisible character or a slash look-alike
    "/&zwsp;Users/alice", "/&zwnj;Users/alice", "/&zwj;Users/alice", "/&shy;Users/alice", "&frasl;Users&frasl;alice",
    "&bsol;&bsol;server&bsol;share", "/Us&notanentity;ers/alice",
    // slashes ahead of the root
    "//home/bob/src",
    // tag / comment sitting INSIDE the root; `>` inside a quoted attribute; entity split by an invisible char; `&colon;`
    "/<!-- x -->Users/alice", '/<span title=">">Users/alice', "/<span title='>'>Users/alice", "&sol\u200b;Users/alice", "/&#x200b;Users/alice", "/&#173;Users/alice", "C&colon;\\Users\\alice",
    "/</span>Users/alice",
  ];
  for (const s of leaks) {
    test(`output scan throws on ${JSON.stringify(s)}`, () => {
      expect(() => assertNoAbsolutePaths(`## ${s}`)).toThrow("absolute path in export:");
    });
    test(`pre-render check names the field for ${JSON.stringify(s)}`, () => {
      expect(findPathShaped([{ where: "ok", text: "fine" }, { where: "verb of x", text: s }])).toBe("verb of x");
    });
  }
});

// Decision 2026-09-29 (the maintainer): these look like absolute paths but name no person or machine layout. They used
// to be blocked (or, for the last group, were never a question) and now PASS ON PURPOSE.
describe("not personal — passes by decision 2026-09-29", () => {
  const passes = [
    // formerly-blocked shapes of the old two-segment rule
    " /opt/a", 'x="/etc/passwd"', "/2026-proj/x/y", "/1password/x", "/-x/y", "/@scope/pkg", "/工作/项目", "C:\\a", "C:/a", "see /tmp/x!",
    "in /etc/x?", "x=/opt/y}", "a|/srv/z|b", "/opt/app/bin", "/tmp/x", "/etc/passwd", "C:\\Projects\\x", "C:/", "C:\\",
    "///opt/app/bin", "/!urgent/work/secret", "/&zwsp;opt/app",
    // round 5 (cross-family): not this machine, or no person
    "/media/x", "x=/media/y}", "Static assets served from /media/images", "API path /media/:fileId/stream",
    "Visit https://example.com/home/dashboard for stats", "CDN URL: https://cdn.app.com/media/images/logo.png",
    "Profile URL: https://example.com/Users/profile", "Use the file:// scheme for local links",
    "Supported schemes: http://, https://, file://", "Sets WORKDIR /home/node/app in Dockerfile",
    "CI checks out to /home/runner/work/repo", "/home/app/current", "/home/ubuntu", "/home/vscode/.bashrc",
    // routes, regexes, XPath, git refs, hash routes, escapes (cross-family review, wrongly-flagged list)
    "Matches /foo/i in input", "Use regex /pattern/g to replace", "Filter items using /query/m", "{ p: /path/i }",
    "Routes requests to /api/v1", "Handles POST /users/login", "Listens on /auth/callback", "Health check at /health/ready",
    "GET /api/repo-graph/arch/trust",
    "Mode: /read/write", "Operation: /insert/update", "Access: /rx/rw", "Result: /pass/fail", "Configured as /active/standby",
    "XPath query: /html/body", "Matches /svg/g/path",
    "Cloned from git@github.com:/org/repo", "Tracked at /origin/main", "Pushed to /refs/heads",
    "Navigates to #/dashboard/settings", "SPA route: https://app.io/#/users/profile",
    "Matches \\\\d+ regex pattern", "Pattern \\\\d+\\s* then \\w+", "Escapes \\\\n\\t in output", "Use \\\\w for word characters", "Escaped newline \\\\n in string", "Break lines using \\\\newline in LaTeX",
    "Type C:\\\\ or D:\\\\", "Drive C:/ is mounted",
  ];
  for (const s of passes) {
    test(`passes on ${JSON.stringify(s)}`, () => {
      expect(() => assertNoAbsolutePaths(`## ${s}`)).not.toThrow();
      expect(findPathShaped([{ where: "t", text: s }])).toBeNull();
    });
  }
  test("an XPath under a blocked root still blocks (`/root/item` is the root user's home): accepted, decision 2026-09-29", () => {
    expect(() => assertNoAbsolutePaths("Select node /root/item")).toThrow("absolute path in export: /root/item");
  });
  test("`&nbsp;` decodes to a space, which ends the path", () => {
    expect(() => assertNoAbsolutePaths("/Users&nbsp;/alice")).not.toThrow();
  });
  test("two innocent one-segment paths re-joined across a wrapped line stay innocent", () => {
    const svg = '<text><tspan x="0">Check /tmp</tspan><tspan x="0">/cache daily</tspan></text>';
    expect(() => assertNoAbsolutePaths(svg)).not.toThrow();
  });
});

describe("a planted /Users/v/proj in every AI field, through the real builders", () => {
  const P = "/Users/v/proj";
  const svgOf = (mut: (m: ReturnType<typeof model>, t: ReturnType<typeof trust>) => void): string => {
    const m = model();
    const t = trust();
    mut(m, t);
    return buildExportSvg(m, t, { theme: "light", fontCss: "", stampLine: STAMP }).svg;
  };
  const svgCases: Array<[string, (m: ReturnType<typeof model>) => void]> = [
    ["title", (m) => { (m.N.a as { title: string }).title = `Reads ${P}`; }],
    ["verb", (m) => { (m.E[0] as string[])[2] = P; }],
    ["band label", (m) => { (m.BANDS[0] as { label: string }).label = P; }],
    ["boundary label", (m) => { (m.BOUNDARY as { label: string }).label = P; }],
  ];
  for (const [name, mut] of svgCases) {
    test(`SVG ${name}: clean passes, planted throws`, () => {
      expect(() => assertNoAbsolutePaths(svgOf(() => {}))).not.toThrow();
      expect(() => assertNoAbsolutePaths(svgOf(mut))).toThrow("absolute path in export: /Users/v/proj");
    });
  }
  test("appendix title and verb: planted throws", () => {
    const t1 = trust();
    (t1.containers[0] as { title: string }).title = `Reads ${P}`;
    expect(() => assertNoAbsolutePaths(buildAppendixMd(model(), t1, STAMP))).toThrow("absolute path in export: /Users/v/proj");
    // The drawn verb (the model's), and the verb of a trust edge the image does not draw: both are table rows.
    const m2 = model();
    m2.E[0] = ["a", "b", P];
    expect(() => assertNoAbsolutePaths(buildAppendixMd(m2, trust(), STAMP))).toThrow("absolute path in export: /Users/v/proj");
    const t3 = trust();
    t3.edges.push({ source: "c", target: "a", verb: P, solid: false, evidence: { kind: "none", reason: "no-import-no-citation" } });
    expect(() => assertNoAbsolutePaths(buildAppendixMd(model(), t3, STAMP))).toThrow("absolute path in export: /Users/v/proj");
  });
});
