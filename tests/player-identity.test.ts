import { describe, expect, it, vi } from "vitest";

import {
  playerCareerRows,
  resolvePlayerIdentity,
  type Env,
} from "../worker/src/core/db";

type Candidate = { person_id: string; web_name: string; exact_match: number };

function identityEnv(candidates: Candidate[]): Env {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ all: vi.fn(async () => ({ results: candidates })) })),
      })),
    },
  } as unknown as Env;
}

describe("stable player identity", () => {
  it("collapses historical display-name drift onto one source person", async () => {
    const env = identityEnv([
      { person_id: "fpl:code:101", web_name: "B.Fernandes", exact_match: 0 },
      { person_id: "fpl:code:101", web_name: "Fernandes", exact_match: 1 },
    ]);
    await expect(resolvePlayerIdentity(env, "Fernandes")).resolves.toEqual({
      person_id: "fpl:code:101",
      web_name: "B.Fernandes",
    });
  });

  it("refuses exact or loose aliases shared by multiple people", async () => {
    const shared = [
      { person_id: "fpl:code:101", web_name: "Fletcher", exact_match: 1 },
      { person_id: "fpl:code:202", web_name: "Fletcher", exact_match: 1 },
    ];
    await expect(resolvePlayerIdentity(identityEnv(shared), "Fletcher")).resolves.toBeNull();
    await expect(
      resolvePlayerIdentity(
        identityEnv(shared.map((candidate) => ({ ...candidate, exact_match: 0 }))),
        "Fletch",
      ),
    ).resolves.toBeNull();
  });

  it("lets one unique exact alias win over unrelated loose matches", async () => {
    const env = identityEnv([
      { person_id: "fpl:code:101", web_name: "Fernandes", exact_match: 1 },
      { person_id: "fpl:code:202", web_name: "Other Fernandes", exact_match: 0 },
    ]);
    await expect(resolvePlayerIdentity(env, "Fernandes")).resolves.toEqual({
      person_id: "fpl:code:101",
      web_name: "Fernandes",
    });
  });

  it("joins career rows through person_id and fails closed without mappings", async () => {
    const career = [
      { season: "2023-24", goals: 1, assists: 2, minutes: 900, points: 50, xg: 1.2, position: "MF" },
      { season: "2024-25", goals: 2, assists: 3, minutes: 1000, points: 60, xg: 2.1, position: "MF" },
    ];
    const binds: unknown[][] = [];
    const prepare = vi.fn((query: string) => ({
      bind: (...args: unknown[]) => {
        binds.push(args);
        return {
          all: async () => ({
            results: query.includes("SELECT i.person_id")
              ? [{ person_id: "fpl:code:101", web_name: "Latest", exact_match: 1 }]
              : career,
          }),
        };
      },
    }));
    const env = { DB: { prepare } } as unknown as Env;
    await expect(playerCareerRows(env, "fpl:code:101")).resolves.toEqual(career);
    expect(prepare.mock.calls[1]![0]).toContain("JOIN player_identities");
    expect(binds[1]).toEqual(["PL", "fpl:code:101"]);

    await expect(playerCareerRows(identityEnv([]), "Unknown")).resolves.toEqual([]);
  });
});
