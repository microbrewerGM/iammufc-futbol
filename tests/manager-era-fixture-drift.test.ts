import { describe, expect, it } from "vitest";
import { queryManagerEras, type ManagerEraCatalog, type ManagerEraManager, type ManagerEraResult, type ManagerEraRow } from "../worker/src/core/manager-era";
import { managerErasBody } from "../worker/src/views/manager-eras";

const snapshot = "a".repeat(64);
const seasons = ["2024-25"] as const;
const lineage = ["openfootball_cl"];

describe("manager era reader and view stay in sync", () => {
  it("round-trips a typed reader result into the view", () => {
    const result: ManagerEraResult = queryManagerEras(
      snapshot,
      seasons,
      [{ snapshot_id: snapshot, season: seasons[0], tenure_id: "tenure:one", manager_id: "manager:one", role: "manager", played: 3, won: 2, drawn: 1, lost: 0, goals_for: 5, goals_against: 2, lineage } satisfies ManagerEraRow],
      [],
      [{ snapshot_id: snapshot, manager_id: "manager:one", label: "Manager One", lineage } satisfies ManagerEraManager],
      [{ snapshot_id: snapshot, season: seasons[0], coverage: "complete", completed: 3, unfinished: 0, ambiguous: 0, lineage } satisfies ManagerEraCatalog["seasons"][number] & { snapshot_id: string; lineage: string[] }],
    );

    const html = managerErasBody({ eras: result.eras }, "en");

    expect(html).toContain("Manager One");
    expect(html).toContain("<th scope=\"row\">Manager One</th><td>3</td><td>2-1-0</td><td>7</td>");
  });
});
