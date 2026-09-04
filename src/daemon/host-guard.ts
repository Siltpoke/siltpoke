// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * DNS-rebinding guard — validates the `Host` header on every request before
 * it reaches any route. Without this, a page on an attacker-controlled
 * domain that DNS-rebinds its hostname to 127.0.0.1 becomes same-origin in
 * the browser (browsers key same-origin by hostname, not resolved IP),
 * letting it `fetch("/")`, parse the daemon secret out of the embedded SSR
 * HTML, and then replay that secret against every secret-gated route.
 *
 * A browser ALWAYS sends a `Host` header on HTTP/1.1+ requests, so rejecting
 * a missing or mismatched Host is safe for browser traffic. This daemon's
 * own internal callers (`src/cli/report.ts`, `src/hooks/on-stop.ts`) all
 * `fetch("http://127.0.0.1:<port>/...")`, and
 * `fetch()` sets a matching `Host` header from the URL automatically — they
 * are unaffected by this guard.
 */
import type { Context, Next } from "hono";

/** Allowed local hostnames — the daemon binds 127.0.0.1 only, never remote. */
const ALLOWED_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Pure predicate (unit-testable without spinning up a server). `hostHeader`
 * is the raw `Host` request header value (e.g. `"127.0.0.1:9876"`); `port`
 * is the daemon's actual bound port.
 */
export function isAllowedHost(hostHeader: string | undefined | null, port: number): boolean {
  if (!hostHeader) return false;
  return ALLOWED_HOSTNAMES.some((hostname) => hostHeader === `${hostname}:${port}`);
}

/**
 * Hono middleware factory. Takes a `getPort` thunk (not a plain number)
 * because `opts.port` may be `0` (ephemeral — used by tests): the real bound
 * port is only known after `Bun.serve()` returns, but this middleware must
 * be *registered* before that call so it gates every route, including plain
 * reads and SSE. The daemon updates the boxed port value once `Bun.serve()`
 * resolves; this closure reads it fresh on every request.
 */
export function hostAllowlistMiddleware(getPort: () => number) {
  return async (c: Context, next: Next) => {
    const host = c.req.header("host");
    if (!isAllowedHost(host, getPort())) {
      return c.json({ success: false, data: null, error: "forbidden_host" }, 403);
    }
    await next();
  };
}
