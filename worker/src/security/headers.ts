/**
 * Security headers.
 *
 * CSP is `script-src 'none'` because the site genuinely ships no JavaScript --
 * the chart is server-rendered SVG and the chat is a plain form POST. That is
 * the strongest possible policy and it costs nothing here.
 *
 * When client-side charting arrives, do NOT relax this to 'unsafe-inline'.
 * Inject a per-request nonce via HTMLRewriter instead, and record any deviation
 * in docs/exceptions.md. `starting_ideas/04` flags inline-script convenience as
 * the specific trap.
 */

export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'none'",
    "style-src 'self'", // stylesheet is a static asset, so no inline exception needed
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "X-Robots-Tag": "noindex", // M3 lifts this per-page, behind the substance gate
};

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
