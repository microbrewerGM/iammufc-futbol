from __future__ import annotations

import io

import pandas as pd
import pytest

from pipeline.sources import run


def csv_bytes(rows: list[dict]) -> bytes:
    return pd.DataFrame(rows).to_csv(index=False).encode()


def players() -> bytes:
    return csv_bytes(
        [
            {
                "id": 1,
                "code": 101,
                "team": 10,
                "team_code": 1,
                "element_type": 3,
                "web_name": "Pure",
                "first_name": "Pat",
                "second_name": "Pure",
                "goals_scored": 1,
                "assists": 1,
                "minutes": 180,
                "total_points": 12,
            },
            {
                "id": 2,
                "code": 202,
                "team": 20,
                "team_code": 20,
                "element_type": 4,
                "web_name": "Moved",
                "first_name": "Morgan",
                "second_name": "Moved",
                "goals_scored": 3,
                "assists": 1,
                "minutes": 180,
                "total_points": 18,
            },
        ]
    )


def fixtures() -> bytes:
    return csv_bytes(
        [
            {"id": 100, "team_h": 10, "team_a": 20},
            {"id": 101, "team_h": 30, "team_a": 10},
            {"id": 102, "team_h": 20, "team_a": 30},
        ]
    )


def gameweeks(*, include_team: bool = True, include_xg: bool = False) -> bytes:
    rows = [
        {
            "element": 1,
            "fixture": 100,
            "GW": 1,
            "was_home": True,
            "goals_scored": 1,
            "assists": 0,
            "minutes": 90,
            "total_points": 7,
        },
        {
            "element": 1,
            "fixture": 101,
            "GW": 2,
            "was_home": False,
            "goals_scored": 0,
            "assists": 1,
            "minutes": 90,
            "total_points": 5,
        },
        {
            "element": 2,
            "fixture": 100,
            "GW": 1,
            "was_home": True,
            "goals_scored": 1,
            "assists": 0,
            "minutes": 90,
            "total_points": 6,
        },
        {
            "element": 2,
            "fixture": 102,
            "GW": 2,
            "was_home": True,
            "goals_scored": 2,
            "assists": 1,
            "minutes": 90,
            "total_points": 12,
        },
    ]
    if include_team:
        for row in rows:
            row["team"] = "Man Utd" if row["fixture"] in {100, 101} else "Other"
    if include_xg:
        for row, value in zip(rows, [0.6, 0.1, 0.3, 1.2], strict=True):
            row["expected_goals"] = value
    return csv_bytes(rows)


def test_fixture_attribution_keeps_only_united_output_and_includes_departure():
    result = run.player_frame_from_payloads(
        "2021-22", players(), gameweeks(), fixtures()
    ).set_index("fpl_element")

    assert set(result.index) == {1, 2}
    assert result.loc[1, ["goals", "assists", "minutes", "points"]].tolist() == [1, 1, 180, 12]
    assert result.loc[2, ["goals", "assists", "minutes", "points"]].tolist() == [1, 0, 90, 6]
    assert result.loc[2, "web_name"] == "Moved"
    assert result.loc[1, "person_id"] == "fpl:code:101"
    assert result.loc[2, "source_person_code"] == 202
    assert result["team"].eq("Manchester United").all()
    assert result["xg"].isna().all()


def test_missing_or_nonpositive_stable_person_code_fails_closed():
    missing = pd.read_csv(io.BytesIO(players())).drop(columns=["code"])
    with pytest.raises(run.IngestError, match="missing .*code"):
        run.player_frame_from_payloads(
            "2021-22", csv_bytes(missing.to_dict("records")), gameweeks(), fixtures()
        )

    invalid = pd.read_csv(io.BytesIO(players()))
    invalid.loc[0, "code"] = 0
    with pytest.raises(run.IngestError, match="code must contain positive integers"):
        run.player_frame_from_payloads(
            "2021-22", csv_bytes(invalid.to_dict("records")), gameweeks(), fixtures()
        )


def test_fixture_attribution_supports_legacy_rows_without_explicit_team():
    result = run.player_frame_from_payloads(
        "2019-20", players(), gameweeks(include_team=False), fixtures()
    )
    assert len(result) == 2


def test_exact_duplicate_rows_collapse_but_conflicting_fixture_rows_fail():
    rows = pd.read_csv(io.BytesIO(gameweeks())).to_dict("records")
    exact = csv_bytes(rows + [rows[0]])
    assert len(run.player_frame_from_payloads("2021-22", players(), exact, fixtures())) == 2

    conflict = dict(rows[0])
    conflict["goals_scored"] = 2
    with pytest.raises(run.IngestError, match="conflicting fixture rows"):
        run.player_frame_from_payloads(
            "2021-22", players(), csv_bytes(rows + [conflict]), fixtures()
        )


def test_zero_only_reschedule_row_collapses_but_contributing_repeat_fails():
    rows = pd.read_csv(io.BytesIO(gameweeks())).to_dict("records")
    actual = dict(rows[0])
    actual["GW"] = 3
    for column in ["goals_scored", "assists", "minutes", "total_points"]:
        rows[0][column] = 0
    assert len(
        run.player_frame_from_payloads(
            "2021-22", players(), csv_bytes(rows + [actual]), fixtures()
        )
    ) == 2

    rows[0]["minutes"] = 1
    with pytest.raises(run.IngestError, match="earlier contributions"):
        run.player_frame_from_payloads(
            "2021-22", players(), csv_bytes(rows + [actual]), fixtures()
        )


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda rows: rows.__setitem__(0, {**rows[0], "fixture": 999}), "missing fixtures"),
        (lambda rows: rows.__setitem__(0, {**rows[0], "team": "Other"}), "attribution disagree"),
    ],
)
def test_attribution_inconsistency_fails_closed(mutate, message):
    rows = pd.read_csv(io.BytesIO(gameweeks())).to_dict("records")
    mutate(rows)
    with pytest.raises(run.IngestError, match=message):
        run.player_frame_from_payloads(
            "2021-22", players(), csv_bytes(rows), fixtures()
        )


def test_united_only_snapshot_totals_must_reconcile():
    raw = pd.read_csv(io.BytesIO(players()))
    raw.loc[raw["id"] == 1, "minutes"] = 181
    with pytest.raises(run.IngestError, match="archive-wide minutes aggregate"):
        run.player_frame_from_payloads(
            "2021-22", raw.to_csv(index=False).encode(), gameweeks(), fixtures()
        )


def test_missing_transfer_history_fails_all_club_reconciliation():
    rows = pd.read_csv(io.BytesIO(gameweeks())).to_dict("records")
    rows = [row for row in rows if not (row["element"] == 2 and row["fixture"] == 100)]
    with pytest.raises(run.IngestError, match="archive-wide goals_scored"):
        run.player_frame_from_payloads(
            "2021-22", players(), csv_bytes(rows), fixtures()
        )


def test_missing_non_scoring_departure_fails_archive_aggregate():
    raw = pd.read_csv(io.BytesIO(players()))
    raw.loc[raw["id"] == 2, "goals_scored"] = 2
    rows = pd.read_csv(io.BytesIO(gameweeks())).to_dict("records")
    rows = [row for row in rows if not (row["element"] == 2 and row["fixture"] == 100)]
    with pytest.raises(run.IngestError, match="archive-wide minutes aggregate"):
        run.player_frame_from_payloads(
            "2021-22", raw.to_csv(index=False).encode(), csv_bytes(rows), fixtures()
        )


def test_xg_is_aggregated_for_united_rows_and_must_be_finite():
    result = run.player_frame_from_payloads(
        "2022-23", players(), gameweeks(include_xg=True), fixtures()
    ).set_index("fpl_element")
    assert result.loc[1, "xg"] == pytest.approx(0.7)
    assert result.loc[2, "xg"] == pytest.approx(0.3)

    rows = pd.read_csv(io.BytesIO(gameweeks(include_xg=True))).to_dict("records")
    rows[0]["expected_goals"] = float("inf")
    with pytest.raises(run.IngestError, match="finite and non-negative"):
        run.player_frame_from_payloads(
            "2022-23", players(), csv_bytes(rows), fixtures()
        )

    rows = pd.read_csv(io.BytesIO(gameweeks(include_xg=True))).to_dict("records")
    actual = dict(rows[0])
    actual["GW"] = 3
    for column in ["goals_scored", "assists", "minutes", "total_points"]:
        rows[0][column] = 0
    rows[0]["expected_goals"] = 0.1
    with pytest.raises(run.IngestError, match="earlier contributions"):
        run.player_frame_from_payloads(
            "2022-23", players(), csv_bytes(rows + [actual]), fixtures()
        )


def test_load_players_hashes_every_consumed_payload(monkeypatch):
    payloads = {
        "players_raw.csv": players(),
        "gws/merged_gw.csv": gameweeks(),
        "fixtures.csv": fixtures(),
    }
    monkeypatch.setattr(
        run,
        "fetch",
        lambda url: next(payload for suffix, payload in payloads.items() if url.endswith(suffix)),
    )
    _, hashes = run.load_players("2021-22")
    assert hashes == {
        "fpl_players:2021-22": run.sha256(players()),
        "fpl_gameweeks:2021-22": run.sha256(gameweeks()),
        "fpl_fixtures:2021-22": run.sha256(fixtures()),
    }
