import { describe, expect, it } from "vitest";
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import { LOCALES } from "../worker/src/core/locale";
import { page } from "../worker/src/views/layout";
import { homeBody } from "../worker/src/views/pages";

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
  it("seeds ask forms from supported catalog seasons in both languages", () => {
    for (const [locale, goals, assists] of [
      [LOCALES.en, "Top goals 2021-22", "Top assists 2021-22"],
      [LOCALES.es, "Máximos goles 2021-22", "Máximas asistencias 2021-22"],
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
