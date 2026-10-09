"""Decimal money: exact totals, explicit unknowns, currencies never combined."""

from __future__ import annotations

from decimal import Decimal

from conftest import FIXTURES, upload_file

from cost_inspector.money import percent_change


def test_known_costs_fixture_produces_exact_total(client) -> None:
    body = upload_file(client, FIXTURES / "known_costs.jsonl")
    assert body["spend"]["by_currency"] == [{"currency": "USD", "amount": "12.645679001234567891"}]
    assert body["spend"]["complete"] is True
    assert body["spend"]["unknown_calls"] == 0
    # The same sum in binary floating point loses digits; the inspector must not.
    assert repr(sum([0.1, 0.2, 1e-7, 12.345678901234567891])) != "12.645679001234567891"
    call_costs = [
        c["cost"]["amount"]
        for c in client.get(f"/api/runs/{body['runs'][0]['id']}").json()["calls"]
    ]
    assert call_costs == ["0.1", "0.2", "0.0000001", "12.345678901234567891"]


def test_missing_costs_and_mixed_currencies_stay_explicit(client) -> None:
    body = upload_file(client, FIXTURES / "mixed_currency_missing.jsonl")
    spend = body["spend"]
    assert spend["by_currency"] == [
        {"currency": "EUR", "amount": "0.02"},
        {"currency": "USD", "amount": "0.01"},
    ]
    assert spend["unknown_calls"] == 1 and spend["known_calls"] == 3
    assert spend["complete"] is False
    run = client.get(f"/api/runs/{body['runs'][0]['id']}").json()
    costs = [c["cost"] for c in run["calls"]]
    assert costs[2]["amount"] is None and costs[2]["currency"] is None  # unknown, not zero
    assert costs[3]["amount"] == "0" and costs[3]["currency"] == "USD"  # known zero


def test_zero_cost_run_is_complete_not_unknown(client) -> None:
    body = upload_file(client, FIXTURES / "zero_cost_run.jsonl")
    assert body["spend"] == {
        "by_currency": [{"currency": "USD", "amount": "0"}],
        "known_calls": 2,
        "unknown_calls": 0,
        "total_calls": 2,
        "complete": True,
        "estimated_calls": 0,
        "basis": "reported",
    }


def test_percent_change_rules() -> None:
    assert percent_change(Decimal("0"), Decimal("5")) is None
    assert percent_change(Decimal("0"), Decimal("0")) is None
    assert percent_change(Decimal("0.09912"), Decimal("0.07272")) == Decimal("-26.63")
    assert percent_change(Decimal("1"), Decimal("1.00125")) == Decimal("0.12")  # half-even
    assert percent_change(Decimal("1"), Decimal("1.00135")) == Decimal("0.14")
    assert percent_change(Decimal("2"), Decimal("4")) == Decimal("100.00")
    assert percent_change(Decimal("1E-20"), Decimal("9007199254740991")) is not None
