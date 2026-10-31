import { describe, expect, it } from "vitest";
import { LOCALES } from "../worker/src/core/locale";
import { seasonSplitsBody, type SeasonSplitView } from "../worker/src/views/season-splits";

const view = (seasons: string[]): SeasonSplitView => ({
  selection: { seasons, group_by: "opponent", venue: "", opponent_id: "" },
  seasons: ["2023-24", "2024-25", "2025-26"], opponents: [], credits: {},
});

describe("season picker selected count", () => {
  it.each([
    ["en", ["2024-25"], "Seasons (1 selected; choose 1–16)"],
    ["en", ["2023-24", "2025-26"], "Seasons (2 selected; choose 1–16)"],
    ["es", ["2024-25"], "Temporadas (1 seleccionadas; elige 1–16)"],
    ["es", ["2023-24", "2024-25", "2025-26"], "Temporadas (3 seleccionadas; elige 1–16)"],
  ] as const)("renders an accessible localized legend for %s selection", (code, selected, legend) => {
    const body = seasonSplitsBody(view([...selected]), LOCALES[code]);
    expect(body).toContain(`<legend>${legend}</legend>`);
    const checked = [...body.matchAll(/<input id="splits-season-\d+" type="checkbox" name="seasons" value="([^"]+)" checked>/g)].map(match => match[1]);
    expect(checked).toEqual(selected);
  });
});
