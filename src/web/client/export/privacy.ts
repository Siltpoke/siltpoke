// Export-time privacy checks (spec §7.6). Both are loud, never scrubbing:
// a hit aborts or blocks the export (Q5 rejected silent redaction).

// Personal / machine paths. Two layers, both loud (never scrubbing):
//  - findPathShaped: each AI-written string, BEFORE rendering — no wrapping,
//    truncation or escaping has touched it yet, and the hit names the field.
//  - assertNoAbsolutePaths: the finished SVG / appendix, as a second net.
//
// Decision 2026-09-29 (the maintainer): block only paths that reveal a person or their
// machine layout. Routes (`POST /users/login`), regexes (`/foo/i`), XPath and
// `/opt/app/bin` are ordinary code-map prose and pass. Blocked:
//  - POSIX roots `/Users /home /root /Volumes /mnt /var/folders /private/var
//    /run/user` + one more segment of non-space, non-`/` characters
//    (`(archive)`, `!urgent`, `**alice**`, a one-letter user). A regex such as
//    `/home/i` also reads as one — rare in a code map, and a missed user is worse.
//    Case-SENSITIVE, matched anywhere except inside an http(s) URL, which names
//    a website, not this machine. `/home/<service account>` (node, app, runner …
//    — the users container images and CI ship with) names no person and passes.
//    `/media` is not a root here: web apps route `/media/images` far more often
//    than anyone automounts a drive.
//  - Windows `X:\Users\<seg>` / `X:/Documents and Settings/<seg>` (any case;
//    doubled separators, as markdown-escaped `C:\\Users`, count).
//  - UNC `\\host\share` (host AND share); `file://` followed by a location.
// Scanned text is NORMALIZED first: invisible characters removed, every HTML
// entity form decoded, NFKC, then slash/backslash look-alikes folded to ASCII.
// Nothing is skipped by shape; the caller names the exact strings it embedded
// itself (the font CSS) and only those are removed.
const SERVICE_HOMES = "node|app|runner|ubuntu|circleci|gitpod|vscode|codespace|jovyan|www-data|git|nobody";
const POSIX_PERSONAL = new RegExp(
  `(?:/Users|/home(?!/(?:${SERVICE_HOMES})(?:[/\\s"'\`<>)]|$))|/root|/Volumes|/mnt|/var/folders|/private/var|/run/user)/[^\\s/]+(?:/[^\\s"'\`<>)\\]]*)?`,
);
const WIN_PERSONAL = /[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\s\\/]+(?:[\\/][^\s"'`<>)]*)?/i;
// Only characters a URL is written with, and not `,` `;` `|`: Chinese prose puts
// no space after a link, so `仓库https://github.com/a/b，本地/Users/v/proj` (the
// full-width comma is `,` after NFKC) must end the URL before the local path.
const WEB_URL = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+=%]+/gi;
// Host is hostname-shaped and at least two characters, so regex/escape prose
// (`\\d+\\s*`, `\\n\\t`) does not read as `\\host\share`.
const UNC_SHARE = /\\\\[A-Za-z0-9][A-Za-z0-9.-]+\\[\w$.-]+(?:\\[^\s"'`<>)]*)?/;
const FILE_URL = /file:\/\/[^\s"'`<>),]+/i;
// Every character Unicode says renders as nothing (zero-width, bidi isolates,
// grapheme joiner, variation selectors …), not a hand-kept list.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const NAMED: Record<string, string> = {
  quot: '"', apos: "'", lt: "<", gt: ">", amp: "&", sol: "/", bsol: "\\", colon: ":", nbsp: " ",
  frasl: "\u2044", // `&zwsp;` `&zwnj;` `&shy;` need no entry: the markdown view drops every unknown entity
};

function decodeEntities(t: string, dropUnknown: boolean): string {
  // Repeat until stable so `&amp;#47;` cannot survive as a path one layer down.
  for (let i = 0; i < 4; i++) {
    const next = t.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? (dropUnknown ? "" : m);
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
    if (next === t) break;
    t = next;
  }
  return t;
}

const normalize = (t: string, dropUnknown: boolean): string =>
  decodeEntities(t.replace(INVISIBLE, ""), dropUnknown)
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(/[\u2215\u2044\u29f8\u2571\ufe6f]/g, "/")
    .replace(/[\u29f5\u2216\u29f9\u2572]/g, "\\");

function firstPath(plain: string): string | null {
  const local = plain.replace(WEB_URL, " ");
  for (const re of [FILE_URL, POSIX_PERSONAL, WIN_PERSONAL, UNC_SHARE]) {
    const m = re.exec(local); // an http(s) URL names a website, not this machine
    if (m) return m[0].replace(/["'`<>)\]},;.!?]+$/, "");
  }
  return null;
}

// A well-formed tag, tolerating quoted attribute values that contain `>`.
const TAG = /<\/?[A-Za-z][\w:-]*(?:\s(?:[^<>"']|"[^"]*"|'[^']*')*)?\/?>/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;

/** Two views of rendered markup, taken BEFORE entities are decoded (so an
 * escaped `&lt;/Users/x&gt;` is never mistaken for a tag). A hit in EITHER counts:
 *  c. what a renderer shows: comments and tags removed with nothing left behind
 *     (a path split by the line-wrap, `<span>/</span>Users` or an inline comment
 *     reads whole again), `*` `_` `` ` `` `~~` markers gone, `[text](url)` reduced to
 *     its text, unknown `&name;` dropped (`/&zwsp;Users`);
 *  d. angle brackets removed, attribute text kept (`<a href="/Users/x">`), which
 *     is also the raw text for everything a renderer would not touch.
 * (A "tags as a space" view and a tspan re-join view were dropped: mutation-
 * checking showed both fully subsumed by these two.) */
function views(markup: string): Array<{ s: string; drop: boolean }> {
  return [
    { s: markup.replace(COMMENT, "").replace(TAG, "").replace(MD_LINK, "$1").replace(/\*|`|~~|_/g, ""), drop: true },
    { s: markup.replace(/[<>]/g, ""), drop: false },
  ];
}

function scan(markup: string): string | null {
  for (const v of views(markup)) {
    const hit = firstPath(normalize(v.s, v.drop));
    if (hit) return hit;
  }
  return null;
}

/** `embedded`: exact strings the caller put into `text` itself (the font CSS);
 * each is removed verbatim before scanning. Anything else is scanned. */
export function assertNoAbsolutePaths(text: string, embedded: readonly string[] = []): void {
  let own = text;
  for (const e of embedded) if (e) own = own.split(e).join(" ");
  const hit = scan(own);
  if (hit) throw new Error(`absolute path in export: ${hit}`);
}

/** Each AI-written string before rendering; returns the `where` of the first hit. */
export function findPathShaped(strings: Array<{ where: string; text: string }>): string | null {
  for (const s of strings) if (scan(s.text)) return s.where;
  return null;
}

// High-confidence shapes only: a false positive blocks a share, so no entropy heuristics.
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}/,
  /\bsk-[A-Za-z0-9_-]{32,}/,
  /\bxox[baprs]-[A-Za-z0-9-]+/,
];

const secretShaped = (t: string): boolean => SECRET_SHAPES.some((re) => re.test(t));

/** Raw, and normalized the same way as the path check (invisible characters
 * removed, entities decoded, NFKC): `ghp_<zero-width space>AAAA…` renders as a key. */
export function findSecretShaped(strings: Array<{ where: string; text: string }>): string | null {
  for (const s of strings) if (secretShaped(s.text) || secretShaped(normalize(s.text, true))) return s.where;
  return null;
}

const TSPAN_SEAM = /<\/tspan>\s*<tspan\b[^>]*>/g;
const ANY_TAG = /<\/?[A-Za-z][^<>]*>/g;

/** The same shapes, over finished markup: each text is scanned raw AND with the
 * line-wrap seams closed. The SVG breaks an unbreakable token (a long key in a
 * folder name) across `<tspan>` lines, so `ghp_AAAA…</tspan><tspan …>AAAA…` matches
 * no shape until the seam is removed. Any other tag becomes a space, so words in
 * different elements never fuse into a shape. */
export function findSecretShapedInMarkup(strings: Array<{ where: string; text: string }>): string | null {
  const joined = strings.map((s) => ({ where: s.where, text: s.text.replace(TSPAN_SEAM, "").replace(ANY_TAG, " ") }));
  return findSecretShaped(strings) ?? findSecretShaped(joined);
}
