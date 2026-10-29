import { describe, expect, it } from "vitest";
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { esc, html, page, type LayoutOptions } from "../worker/src/views/layout";
import { exampleQuestion, homeBody } from "../worker/src/views/pages";

function homeCatalog(overrides: Partial<CompiledCatalog> = {}): Catalog {
  const seasons = ["2020-21", "2021-22"];
  return new Catalog({
    version: 1,
    metrics: ["goals", "assists", "minutes"].map((metric_id) => ({
      metric_id,
      label_en: metric_id,
      label_es: metric_id,
      description: metric_id,
      description_es: metric_id,
      granularity: "box_score",
      unit: "count",
      decimals: 0,
    })),
    coverage: [
      ...seasons.flatMap((season) => ["goals", "assists", "minutes"].map((metric) => ({
        metric,
        entity_type: "player",
        granularity: "box_score" as const,
        season,
        competition: "PL",
        source_id: "fpl",
        redistributable: true,
        cost_class: "cheap" as const,
        attribution_asset: null,
        attribution_text: null,
        attribution_text_es: null,
        source_name: "Fantasy Premier League",
      }))),
      ...seasons.map((season) => ({
        metric: "goals",
        entity_type: "season",
        granularity: "box_score" as const,
        season,
        competition: "PL",
        source_id: "football_data_couk",
        redistributable: true,
        cost_class: "cheap" as const,
        attribution_asset: null,
        attribution_text: null,
        attribution_text_es: null,
        source_name: "Football-Data.co.uk",
      })),
    ],
    ...overrides,
  });
}

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

describe("homepage actions", () => {
  it("escapes gallery questions in the hidden value and visible submit label", () => {
    const question = '<img src=x onerror="alert(1)"> & \'hello\'';
    const markup = exampleQuestion(LOCALES.en, question);

    expect(markup).toContain('name="q" value="&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;hello&#39;"');
    expect(markup).toContain('<button type="submit">&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;hello&#39;</button>');
    expect(markup).not.toContain('<img src=x');
  });

  it("seeds the ask form with feasible examples in both languages", () => {
    for (const [locale, goals, assists] of [
      [LOCALES.en, "Top goals 2021-22", "Top assists table 2021-22"],
      [LOCALES.es, "Máximos goles 2021-22", "Máximas asistencias tabla 2021-22"],
    ] as const) {
      const markup = homeBody(homeCatalog(), locale);
      expect(markup).toContain(`action="/${locale.code}/ask"`);
      expect(markup).toContain(`name="q" value="${goals}"`);
      expect(markup).toContain(`name="q" value="${assists}"`);
      expect(markup).not.toContain("2024-25");
      expect(markup).not.toMatch(/shot map|mapa de tiros|expected goals|goles esperados/i);
      expect(markup).toContain(`href="/${locale.code}/history"`);
    }
  });

  it("links to supported comparison, stable career, and league-season views in both locales", () => {
    const career = { personId: "fpl:person-123", season: "2021-22" };
    const en = homeBody(homeCatalog(), LOCALES.en, undefined, career);
    const es = homeBody(homeCatalog(), LOCALES.es, undefined, career);

    for (const [markup, locale, playerLabel, careerLabel, seasonLabel] of [
      [en, "en", "Compare player goals per 90 · 2021-22", "View a player career", "Compare league seasons · 2021-22"],
      [es, "es", "Comparar goles de jugadores por 90 · 2021-22", "Ver carrera de un jugador", "Comparar temporadas de liga · 2021-22"],
    ] as const) {
      expect(markup).toContain(`href="/${locale}/compare?season=2021-22&amp;metric=goals"`);
      expect(markup).toContain(`href="/${locale}/player/fpl%3Aperson-123/2021-22"`);
      expect(markup).toContain(`href="/${locale}/season/2021-22#team-seasons"`);
      expect(markup).toContain(playerLabel);
      expect(markup).toContain(careerLabel);
      expect(markup).toContain(seasonLabel);
      expect(markup.match(/<li><a href=/g)).toHaveLength(3);
      expect(markup).not.toMatch(/shot map|mapa de tiros|progressive passes|pases progresivos|expected goals|goles esperados/i);
      expect(markup).not.toContain('role="button"');
    }
  });

  it("omits player actions when the comparison numerator or denominator is not supported", () => {
    const catalog = homeCatalog({
      coverage: [
        ...["goals", "assists"].map((metric) => ({
          metric,
          entity_type: "player",
          granularity: "box_score" as const,
          season: "2021-22",
          competition: "PL",
          source_id: "fpl",
          redistributable: true,
          cost_class: "cheap" as const,
          attribution_asset: null,
          attribution_text: null,
          attribution_text_es: null,
          source_name: "Fantasy Premier League",
        })),
        {
          metric: "goals",
          entity_type: "season",
          granularity: "box_score",
          season: "2021-22",
          competition: "PL",
          source_id: "football_data_couk",
          redistributable: true,
          cost_class: "cheap",
          attribution_asset: null,
          attribution_text: null,
          attribution_text_es: null,
          source_name: "Football-Data.co.uk",
        },
      ],
    });
    const markup = homeBody(catalog, LOCALES.en);

    expect(markup).not.toContain('/compare?');
    expect(markup).toContain('href="/en/season/2021-22#team-seasons"');
    expect(markup).not.toContain('/player/');
  });

  it("omits the career link when no verified stable career candidate is supplied", () => {
    const markup = homeBody(homeCatalog(), LOCALES.en);

    expect(markup).not.toContain('/player/');
    expect(markup.match(/<li><a href=/g)).toHaveLength(2);
  });
});

describe("esc", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(esc("&lt;")).toBe("&amp;lt;");
    expect(esc("plain")).toBe("plain");
  });
});

describe("page shell per locale", () => {
  const render = (code: "en" | "es", extra: Partial<LayoutOptions> = {}) =>
    page("<p>BODY</p>", { title: "T", locale: LOCALES[code], unprefixedPath: "/x", ...extra });

  it("escapes the title and keeps the brand suffix", () => {
    for (const locale of Object.values(LOCALES)) {
      const markup = page("", { title: `<b>"A" & 'B'</b>`, locale, unprefixedPath: "/" });
      expect(markup).toContain(
        "<title>&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt; — iammufc</title>",
      );
      expect(markup).not.toContain("<b>");
    }
  });

  it("sets html lang, aria-current and canonical per locale", () => {
    const en = render("en");
    const es = render("es");
    expect(en).toContain(`<html lang="${LOCALES.en.htmlLang}">`);
    expect(es).toContain(`<html lang="${LOCALES.es.htmlLang}">`);
    expect(en).toContain('<a href="/en/x" aria-current="page">EN</a>');
    expect(en).toContain('<a href="/es/x">ES</a>');
    expect(es).toContain('<a href="/es/x" aria-current="page">ES</a>');
    expect(es).toContain('<a href="/en/x">EN</a>');
    expect(en.match(/aria-current/g)).toHaveLength(1);
    expect(es.match(/aria-current/g)).toHaveLength(1);
    expect(en).toContain('<link rel="canonical" href="/en/x">');
    expect(es).toContain('<link rel="canonical" href="/es/x">');
  });

  it("emits reciprocal hreflang en, es and x-default in both locales", () => {
    for (const code of ["en", "es"] as const) {
      const markup = render(code);
      expect(markup).toContain('hreflang="en" href="/en/x"');
      expect(markup).toContain('hreflang="es" href="/es/x"');
      expect(markup).toContain('hreflang="x-default" href="/en/x"');
    }
  });

  it("renders the analysis nav in the page locale", () => {
    const en = render("en");
    expect(en).toContain('<nav class="analysis-nav" aria-label="Analysis and data">');
    expect(en).toContain('<a href="/en/compare">Compare output per 90</a>');
    expect(en).toContain(`<a href="/en/players/compare">${LOCALES.en.strings.playerRangeLink}</a>`);
    expect(en).toContain('<a href="/en/seasons/explore">Explore season splits</a>');
    expect(en).toContain('<a href="/en/season/2025-26#team-seasons">Compare league seasons</a>');
    expect(en).toContain('<a href="/en/data">Data and sources</a>');
    const es = render("es");
    expect(es).toContain('<nav class="analysis-nav" aria-label="Análisis y datos">');
    expect(es).toContain('<a href="/es/compare">Comparar por 90 minutos</a>');
    expect(es).toContain(`<a href="/es/players/compare">${LOCALES.es.strings.playerRangeLink}</a>`);
    expect(es).toContain('<a href="/es/seasons/explore">Explorar desgloses</a>');
    expect(es).toContain('<a href="/es/season/2025-26#team-seasons">Comparar temporadas</a>');
    expect(es).toContain('<a href="/es/data">Datos y fuentes</a>');
  });

  it("wraps the body in main and renders disclaimer and results attribution per locale", () => {
    for (const code of ["en", "es"] as const) {
      const s = LOCALES[code].strings;
      const markup = render(code);
      expect(markup).toContain("<main>\n<p>BODY</p>\n</main>");
      expect(markup).toContain(`<p class="disclaimer">${esc(s.disclaimer)}</p>`);
      expect(markup).toContain(`<p>${esc(s.resultsAttribution)}</p>`);
      expect(markup.indexOf("</main>")).toBeLessThan(markup.indexOf('<p class="disclaimer">'));
    }
  });

  it("filters empty credits, dedupes and escapes them", () => {
    for (const code of ["en", "es"] as const) {
      const markup = render(code, {
        attribution: ["Data <A>", null, undefined, "", "Data <A>", "B & C"],
      });
      expect(markup.match(/<p>Data &lt;A&gt;<\/p>/g)).toHaveLength(1);
      expect(markup).toContain("<p>B &amp; C</p>");
      expect(markup).not.toContain("Data <A>");
      expect(markup).not.toContain("<p></p>");
    }
  });

  it("renders credits after the disclaimer and before the results attribution", () => {
    for (const code of ["en", "es"] as const) {
      const markup = render(code, { attribution: ["Credit One", "Credit Two"] });
      const results = markup.indexOf(`<p>${esc(LOCALES[code].strings.resultsAttribution)}</p>`);
      const one = markup.indexOf("<p>Credit One</p>");
      const two = markup.indexOf("<p>Credit Two</p>");
      expect(markup.indexOf('<p class="disclaimer">')).toBeLessThan(one);
      expect(one).toBeLessThan(two);
      expect(two).toBeLessThan(results);
    }
  });

  it("renders no credit paragraphs when attribution is absent or all empty", () => {
    for (const code of ["en", "es"] as const) {
      // Footer holds only the disclaimer and the results attribution.
      for (const extra of [{}, { attribution: [] }, { attribution: [null, undefined, ""] }]) {
        const markup = render(code, extra);
        const footer = markup.slice(markup.indexOf("<footer>"), markup.indexOf("</footer>"));
        expect(footer.match(/<p/g)).toHaveLength(2);
      }
    }
  });

  it("truncates the snapshot id to 12 characters and omits the note when absent", () => {
    const id = "0123456789abcdefghij";
    for (const code of ["en", "es"] as const) {
      const note = LOCALES[code].strings.snapshotNote("0123456789ab");
      const withId = render(code, { snapshotId: id });
      expect(withId).toContain(`<p>${esc(note)}</p>`);
      expect(withId).not.toContain("0123456789abc");
      for (const snapshotId of [undefined, null, ""]) {
        const markup = render(code, { snapshotId });
        expect(markup).not.toContain(esc(note));
        expect(markup).not.toContain("0123456789ab");
        // Footer holds only the disclaimer and the results attribution.
        const footer = markup.slice(markup.indexOf("<footer>"), markup.indexOf("</footer>"));
        expect(footer.match(/<p/g)).toHaveLength(2);
        expect(footer).not.toContain(esc(LOCALES[code].strings.snapshotNote("")));
      }
    }
  });

  it("ships no script elements or inline handlers", () => {
    for (const code of ["en", "es"] as const) {
      const markup = render(code, { attribution: ["x"], snapshotId: "abcdef123456789" });
      expect(markup).not.toMatch(/<script/i);
      expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
      expect(markup).not.toMatch(/javascript:/i);
    }
  });
});

describe("html", () => {
  it("defaults to status 200 with an HTML content-type", async () => {
    const res = html("<p>x</p>");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<p>x</p>");
  });

  it("honours an explicit status", () => {
    const res = html("nope", 404);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});
