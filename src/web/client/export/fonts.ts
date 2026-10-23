// Vendored export fonts (SIL OFL 1.1), embedded as base64 @font-face so an SVG
// drawn through <img> needs no external font fetch. Spec §7.3.

const EXPORT_FONTS: ReadonlyArray<{
  family: "Pixelify Sans" | "Geist" | "JetBrains Mono";
  weight: 400 | 500 | 600;
  file: string;
}> = [
  { family: "Pixelify Sans", weight: 600, file: "PixelifySans-SemiBold.woff2" },
  { family: "Geist", weight: 400, file: "Geist-Regular.woff2" },
  { family: "Geist", weight: 500, file: "Geist-Medium.woff2" },
  { family: "JetBrains Mono", weight: 400, file: "JetBrainsMono-Regular.woff2" },
];

// One build per fetch implementation: the page always passes the global
// fetch, so in production this is a single cached build; a caller with its
// own fetch never sees another caller's result.
const cache = new WeakMap<typeof fetch, Promise<string>>();

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function build(fetchImpl: typeof fetch): Promise<string> {
  const rules = await Promise.all(
    EXPORT_FONTS.map(async (f) => {
      const res = await fetchImpl(`/static/fonts/${f.file}`);
      if (!res.ok) throw new Error(`font ${f.file}: HTTP ${res.status}`);
      const b64 = toBase64(new Uint8Array(await res.arrayBuffer()));
      return `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; font-style: normal; src: url(data:font/woff2;base64,${b64}) format("woff2"); }`;
    }),
  );
  return rules.join("\n");
}

export async function fontFaceCss(fetchImpl: typeof fetch = fetch): Promise<string> {
  let pending = cache.get(fetchImpl);
  if (!pending) {
    pending = build(fetchImpl).catch((err) => {
      cache.delete(fetchImpl);
      throw err;
    });
    cache.set(fetchImpl, pending);
  }
  return pending;
}
