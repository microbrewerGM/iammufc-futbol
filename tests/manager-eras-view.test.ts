import { describe, expect, it } from "vitest";
import { managerErasBody, type ManagerEraViewRow } from "../worker/src/views/manager-eras";

const full: ManagerEraViewRow = { manager: "Ole <Gunnar> Solskjær", played: 168, won: 91, drawn: 37, lost: 40, points: 310, start_date: "2018-12-19", end_date: "2021-11-21" };

describe("manager eras view", () => {
  it.each(["en", "es"] as const)("renders a table row per era in %s", locale => {
    const html = managerErasBody({ eras: [full, { ...full, manager: "Ralf", role: "caretaker" }] }, locale);
    expect(html).toContain("<caption>"); expect(html).toContain('scope="col"'); expect(html).toContain('scope="row"');
    expect(html.match(/<tbody>[\s\S]*<\/tbody>/)![0].match(/<tr>/g)).toHaveLength(2);
    expect(html).toContain("Ole &lt;Gunnar&gt; Solskjær");
    expect(html).not.toContain("<Gunnar>");
    expect(html).toContain("91-37-40"); expect(html).toContain("2018-12-19 – 2021-11-21");
    expect(html).toContain(locale === "en" ? "(caretaker)" : "(interino)");
    expect(html).not.toContain("<script");
  });

  it.each([["en", "No manager era data"], ["es", "No hay datos de etapas"]] as const)("renders a no-data marker in %s", (locale, text) => {
    const html = managerErasBody({ eras: [] }, locale);
    expect(html).toContain(text); expect(html).not.toContain("<table");
  });

  it("renders null fields as a dash, never 0", () => {
    const html = managerErasBody({ eras: [{ manager: "X", played: null, won: null, drawn: 1, lost: 2, points: null }] }, "en");
    const row = html.match(/<tbody><tr>([\s\S]*)<\/tr><\/tbody>/)![1]!;
    expect(row).toBe('<th scope="row">X</th><td>—</td><td>—</td><td>—</td><td>—</td>');
  });

  it("keeps a real zero as 0", () => {
    const html = managerErasBody({ eras: [{ manager: "X", played: 1, won: 0, drawn: 0, lost: 1, points: 0 }] }, "en");
    expect(html).toContain("<td>0-0-1</td>"); expect(html).toContain("<td>0</td>");
  });
});
