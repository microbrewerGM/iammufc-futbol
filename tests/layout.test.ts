import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { page } from "../worker/src/views/layout";

describe("localized page links", () => {
  it("uses the registered homepage paths without trailing slashes", () => {
    for (const locale of Object.values(LOCALES)) {
      const markup = page("", { title: "Home", locale, unprefixedPath: "/" });
      expect(markup).toContain('href="/en"');
      expect(markup).toContain('href="/es"');
      expect(markup).not.toContain('href="/en/"');
      expect(markup).not.toContain('href="/es/"');
    }
  });

  it("preserves nested paths and query strings", () => {
    const markup = page("", {
      title: "Query", locale: LOCALES.en,
      unprefixedPath: "/q?metric=goals&season=2024-25",
    });
    expect(markup).toContain('href="/en/q?metric=goals&amp;season=2024-25"');
    expect(markup).toContain('href="/es/q?metric=goals&amp;season=2024-25"');
  });

  it("links to the current host's Cloudflare Access logout endpoint", () => {
    const en = page("", { title: "Home", locale: LOCALES.en, unprefixedPath: "/" });
    const es = page("", { title: "Inicio", locale: LOCALES.es, unprefixedPath: "/" });

    for (const markup of [en, es]) {
      expect(markup.match(/href="\/cdn-cgi\/access\/logout"/g)).toHaveLength(1);
      expect(markup).toContain('referrerpolicy="no-referrer"');
      expect(markup).not.toContain("cloudflareaccess.com/cdn-cgi/access/logout");
    }
    expect(en).toContain('<nav class="session-nav" aria-label="Session">');
    expect(en).toContain(">Sign out of Access</a>");
    expect(en).toContain("Signs you out of all Cloudflare Access applications");
    expect(es).toContain('<nav class="session-nav" aria-label="Sesión">');
    expect(es).toContain(">Cerrar sesión de Access</a>");
    expect(es).toContain("Cierra la sesión en todas las aplicaciones de Cloudflare Access");
  });
});
