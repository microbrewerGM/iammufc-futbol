/**
 * HTML shell.
 *
 * The disclaimer and the attribution block are not decoration -- they are the
 * two things that must appear on every page from commit one. Attribution is
 * passed in from the artifact's lineage, never hard-coded here, so adding a
 * source cannot silently drop its required credit.
 */

import type { Locale } from "../core/locale";

export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface LayoutOptions {
  title: string;
  locale: Locale;
  /** Path WITHOUT the /en//es/ prefix, e.g. "/player/foo/2024-25". Used to
   *  build reciprocal hreflang links -- both trees must be crawlable and
   *  point at each other, not just the current page linking outward. */
  unprefixedPath: string;
  /** Resolved from the coverage cell's source, not written by hand. Still
   *  English-only -- see the honest gap noted in core/locale.ts. */
  attribution?: (string | null | undefined)[];
  snapshotId?: string | null;
}

export function page(body: string, opts: LayoutOptions): string {
  const { locale } = opts;
  const t = locale.strings;
  const credits = (opts.attribution ?? []).filter((a): a is string => Boolean(a));
  const unique = [...new Set(credits)];

  const enHref = `/en${opts.unprefixedPath}`;
  const esHref = `/es${opts.unprefixedPath}`;

  // Plain links, not a JS toggle -- the site ships script-src 'none' by
  // design (docs/design-principles.md: "the site genuinely ships no
  // JavaScript"). Switching language IS a server round-trip: a fresh request
  // hits the same catalog/D1 and renders in the other locale. No client-side
  // re-fetch is needed because there is nothing left for a script to do.
  // aria-current (not colour alone) marks which locale is active, so the
  // distinction survives colour-blindness -- same rule the coverage matrix
  // glyphs already follow.
  const langToggle = `<nav class="lang-toggle" aria-label="Language">
<a href="${esc(enHref)}"${locale.code === "en" ? ' aria-current="page"' : ""}>EN</a>
<a href="${esc(esHref)}"${locale.code === "es" ? ' aria-current="page"' : ""}>ES</a>
</nav>`;

  return `<!doctype html>
<html lang="${locale.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} — iammufc</title>
<link rel="stylesheet" href="/style.css">
<link rel="alternate" hreflang="en" href="${esc(enHref)}">
<link rel="alternate" hreflang="es" href="${esc(esHref)}">
<link rel="alternate" hreflang="x-default" href="${esc(enHref)}">
<link rel="canonical" href="${esc(locale.code === "es" ? esHref : enHref)}">
</head>
<body>
${langToggle}
<main>
${body}
</main>
<footer>
<p class="disclaimer">${esc(t.disclaimer)}</p>
${unique.map((c) => `<p>${esc(c)}</p>`).join("\n")}
<p>${esc(t.resultsAttribution)}</p>
${opts.snapshotId ? `<p>${esc(t.snapshotNote(opts.snapshotId.slice(0, 12)))}</p>` : ""}
</footer>
</body>
</html>`;
}

export function html(markup: string, status = 200): Response {
  return new Response(markup, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
