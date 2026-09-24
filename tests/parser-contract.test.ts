import { describe, expect, it } from "vitest";

import compiled from "../worker/src/generated/catalog.json";
import { Catalog, type CompiledCatalog } from "../worker/src/core/feasibility";
import {
  hasAmbiguousPlayerReference,
  parseRuleBased,
} from "../worker/src/core/parser";

const catalog = new Catalog(compiled as unknown as CompiledCatalog);

describe("rule proposal contract", () => {
  it("preserves a requested Champions League competition", () => {
    expect(parseRuleBased("Top goals 2024-25 Champions League", catalog).intent.competition)
      .toBe("CL");
    expect(parseRuleBased("Top goals 2024-25 Premier League", catalog).intent.competition)
      .toBe("PL");
  });

  it("detects an overlapping short player alias without rejecting unique names", () => {
    const names = ["Rashford", "Fernandes", "Bruno Fernandes"];
    expect(hasAmbiguousPlayerReference("Fernandes goals 2024-25", names)).toBe(true);
    expect(hasAmbiguousPlayerReference("Bruno Fernandes goals 2024-25", names)).toBe(false);
    expect(hasAmbiguousPlayerReference('"Bruno Fernandes" goals 2024-25', [
      "Fernandes",
      "B.Fernandes",
      "Borges Fernandes",
    ])).toBe(false);
    expect(hasAmbiguousPlayerReference("Rashford goals 2024-25", names)).toBe(false);
  });
});
