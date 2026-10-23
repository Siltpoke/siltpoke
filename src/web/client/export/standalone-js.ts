// The standalone script's source text, fetched once from the daemon for the HTML
// export to inline. One cache per fetch implementation, like fonts.ts.
const cache = new WeakMap<typeof fetch, Promise<string>>();

export async function standaloneJs(fetchImpl: typeof fetch = fetch): Promise<string> {
  let pending = cache.get(fetchImpl);
  if (!pending) {
    pending = fetchImpl("/static/export-standalone.js").then(async (res) => {
      if (!res.ok) throw new Error(`export script: HTTP ${res.status}`);
      return res.text();
    });
    pending.catch(() => cache.delete(fetchImpl));
    cache.set(fetchImpl, pending);
  }
  return pending;
}
