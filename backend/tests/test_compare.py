"""Run comparison: measured change only for complete, comparable, equivalent runs."""

from __future__ import annotations

from conftest import FIXTURES, jsonl, record, upload, upload_file, with_cost


def run_id(detail: dict, index: int = 0) -> str:
    return str(detail["runs"][index]["id"])


def compare(client, baseline: str, candidate: str, equivalence: str = "equivalent") -> dict:
    response = client.get(
        "/api/compare",
        params={"baseline": baseline, "candidate": candidate, "equivalence": equivalence},
    )
    assert response.status_code == 200, response.text
    return dict(response.json())


def seeded(client) -> tuple[str, str]:
    hint = client.post("/api/demo").json()["suggested_comparison"]
    return hint["baseline_run_id"], hint["candidate_run_id"]


def test_demo_before_after_is_a_measured_change(client) -> None:
    before, after = seeded(client)
    result = compare(client, before, after)
    assert result["kind"] == "measured_change" and result["headline_scope"] == "all_calls"
    all_calls, model_calls = result["scopes"]
    assert all_calls["rows"] == [
        {
            "currency": "USD",
            "baseline": "0.09912",
            "candidate": "0.07272",
            "delta": "-0.0264",
            "percent": "-26.63",
            "percent_note": None,
        }
    ]
    assert model_calls["rows"][0]["delta"] == "-0.0264"
    assert model_calls["rows"][0]["percent"] == "-27.47"
    assert result["usage"]["calls"] == {"baseline": 11, "candidate": 8, "delta": -3}
    assert result["usage"]["model_calls"] == {"baseline": 8, "candidate": 4, "delta": -4}
    assert result["outcomes"] == {"baseline": "resolved", "candidate": "resolved"}
    assert result["quality"]["measured"] is False
    assert any("Synthetic" in note for note in result["notes"])


def test_equivalence_is_required(client) -> None:
    before, after = seeded(client)
    response = client.get("/api/compare", params={"baseline": before, "candidate": after})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "equivalence_required"
    response = client.get(
        "/api/compare", params={"baseline": before, "candidate": after, "equivalence": "maybe"}
    )
    assert response.status_code == 400


def test_not_equivalent_runs_are_an_observed_difference(client) -> None:
    before, after = seeded(client)
    for equivalence in ("not_equivalent", "unsure"):
        result = compare(client, before, after, equivalence)
        assert result["kind"] == "observed_difference"
        assert result["scopes"][0]["rows"][0]["delta"] == "-0.0264"
        assert any("not marked as equivalent" in n for n in result["notes"])


def test_zero_baseline_has_no_percentage(client) -> None:
    zero = upload_file(client, FIXTURES / "zero_cost_run.jsonl")
    paid = upload(
        client, jsonl([with_cost(record(1), "0.25"), with_cost(record(2), "0.5")]), "paid.jsonl"
    ).json()
    result = compare(client, run_id(zero), run_id(paid))
    (row,) = result["scopes"][0]["rows"]
    assert row["delta"] == "0.75" and row["percent"] is None
    assert "undefined" in row["percent_note"]
    assert result["kind"] == "measured_change"


def test_unknown_baseline_cost_is_not_comparable(client) -> None:
    partial = upload(client, jsonl([with_cost(record(1), "0.25"), record(2)]), "p.jsonl").json()
    paid = upload(client, jsonl([with_cost(record(3), "0.5")]), "q.jsonl").json()
    result = compare(client, run_id(partial), run_id(paid))
    assert result["kind"] == "not_comparable"
    for scope in result["scopes"]:
        assert scope["comparable"] is False
        assert any("baseline has 1 call(s) without a reported cost" in r for r in scope["reasons"])
        assert all(row["delta"] is None and row["percent"] is None for row in scope["rows"])


def test_unknown_tool_cost_still_allows_model_scope(client) -> None:
    tool = record(9)
    tool["resource"] = {
        "provider": "self-hosted",
        "type": "tool",
        "name": "search",
        "operation": "tool_execution",
    }
    tool["usage"] = {"tool": {"call_count": 1}}
    base = upload(client, jsonl([with_cost(record(1), "0.4"), tool]), "a.jsonl").json()
    cand = upload(client, jsonl([with_cost(record(2), "0.1")]), "b.jsonl").json()
    result = compare(client, run_id(base), run_id(cand))
    assert result["scopes"][0]["comparable"] is False
    assert result["scopes"][1]["comparable"] is True
    assert result["headline_scope"] == "model_calls" and result["kind"] == "measured_change"
    assert (
        result["scopes"][1]["rows"][0]["percent"] == "-75.00"
        or result["scopes"][1]["rows"][0]["percent"] == "-75"
    )


def test_currencies_are_compared_separately(client) -> None:
    base = upload(client, jsonl([with_cost(record(1), "1", "USD")]), "usd.jsonl").json()
    cand = upload(client, jsonl([with_cost(record(2), "1", "EUR")]), "eur.jsonl").json()
    scope = compare(client, run_id(base), run_id(cand))["scopes"][0]
    assert [(r["currency"], r["delta"], r["percent"]) for r in scope["rows"]] == [
        ("EUR", "1", None),
        ("USD", "-1", "-100"),
    ]
    assert any("different currencies" in n for n in scope["notes"])


def test_same_run_is_rejected(client) -> None:
    before, _ = seeded(client)
    response = client.get(
        "/api/compare", params={"baseline": before, "candidate": before, "equivalence": "unsure"}
    )
    assert response.status_code == 400


def test_saved_comparison_round_trip_and_report(client) -> None:
    before, after = seeded(client)
    response = client.post(
        "/api/comparisons",
        json={
            "baseline_run_id": before,
            "candidate_run_id": after,
            "equivalence": "equivalent",
            "note": "Deduplicated classification; moved format validation to code.",
        },
    )
    assert response.status_code == 201
    saved = response.json()
    listed = client.get("/api/comparisons").json()["comparisons"]
    assert [c["id"] for c in listed] == [saved["id"]]
    assert listed[0]["result"]["scopes"][0]["rows"][0]["delta"] == "-0.0264"
    html = client.get(f"/api/comparisons/{saved['id']}/report?format=html").text
    assert "Measured change" in html and "Deduplicated classification" in html
    report = client.get(f"/api/comparisons/{saved['id']}/report").json()
    assert report["comparison"]["equivalence"] == "equivalent"
    assert len(report["calls"]["baseline"]) == 11
    assert client.delete(f"/api/comparisons/{saved['id']}").status_code == 200
    assert client.get("/api/comparisons").json()["comparisons"] == []
