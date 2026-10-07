"""End-to-end API workflow, persistence, export, deletion, security and privacy."""

from __future__ import annotations

import json

from conftest import FIXTURES, KORA_SAMPLES, jsonl, record, upload, upload_file, with_cost

from cost_inspector import ids


def test_full_workflow_survives_reload(make_client, settings) -> None:
    with make_client() as client:
        detail = upload_file(client, KORA_SAMPLES / "inefficient_agent.jsonl")
        import_id = detail["id"]
        run_pk = detail["runs"][0]["id"]
        target = detail["findings"][0]
        response = client.patch(
            f"/api/findings/{target['id']}",
            json={"dismissed": True, "note": "  Intentional retry.\x00  "},
        )
        assert response.status_code == 200
        assert response.json()["dismissal_note"] == "Intentional retry."

    # A fresh app on the same database file: everything is still there.
    with make_client() as client:
        listed = client.get("/api/imports").json()["imports"]
        assert [i["id"] for i in listed] == [import_id]
        assert listed[0]["dismissed_findings"] == 1
        reloaded = client.get(f"/api/imports/{import_id}").json()
        finding = next(f for f in reloaded["findings"] if f["id"] == target["id"])
        assert finding["dismissed"] is True and finding["dismissal_note"] == "Intentional retry."
        assert (
            reloaded["scenario"]["open"]["flagged_calls"]
            <= reloaded["scenario"]["all"]["flagged_calls"]
        )

        run = client.get(f"/api/runs/{run_pk}").json()
        assert run["run"]["run_id"] == "run-inefficient-001"
        assert run["run"]["model_calls"] == 9

        restored = client.patch(f"/api/findings/{target['id']}", json={"dismissed": False})
        assert restored.json()["dismissed"] is False and restored.json()["dismissal_note"] is None

        assert client.delete(f"/api/imports/{import_id}").status_code == 200
        assert client.get(f"/api/imports/{import_id}").status_code == 404
        assert client.get(f"/api/runs/{run_pk}").status_code == 404
        assert client.get("/api/imports").json()["imports"] == []


def test_invalid_file_is_rejected_with_line_specific_errors(client) -> None:
    good = json.dumps(record(1))
    bad = record(3, usage__llm={"input_tokens": -1})
    data = (good + "\nnot json\n" + json.dumps(bad) + "\n").encode()
    response = upload(client, data, "broken.jsonl")
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "invalid_file" and error["issue_count"] == 2
    assert [(i["line"], i["code"]) for i in error["issues"]] == [(2, "json_syntax"), (3, "schema")]
    assert error["issues"][1]["path"] == "usage.llm.input_tokens"
    assert client.get("/api/imports").json()["imports"] == []  # nothing partial stored


def test_duplicate_upload_is_refused(client) -> None:
    first = upload_file(client, KORA_SAMPLES / "simple.jsonl")
    response = upload(client, (KORA_SAMPLES / "simple.jsonl").read_bytes(), "again.jsonl")
    assert response.status_code == 409
    assert response.json()["error"]["import_id"] == first["id"]


def test_upload_limits(make_client) -> None:
    with make_client(max_upload_bytes=2048) as client:
        response = upload(client, b"x" * 4096)
        assert response.status_code == 413 and response.json()["error"]["code"] == "too_large"
        assert upload(client, b"").status_code == 400
    with make_client(max_records=2) as client:
        data = jsonl([record(1), record(2), record(3)])
        response = upload(client, data)
        assert response.status_code == 422
        assert response.json()["error"]["issues"][0]["code"] == "too_many_records"


def test_json_report_is_self_explanatory(client) -> None:
    detail = upload_file(client, KORA_SAMPLES / "inefficient_agent.jsonl")
    target = detail["findings"][1]
    client.patch(f"/api/findings/{target['id']}", json={"dismissed": True, "note": "Known loop"})
    response = client.get(f"/api/imports/{detail['id']}/report?format=json")
    assert response.status_code == 200
    assert "inefficient_agent-cost-report.json" in response.headers["content-disposition"]
    report = response.json()
    assert report["report"]["format"] == "ai-cost-inspector/report"
    assert report["report"]["analyzer"]["revision"].startswith("7c54af8")
    assert set(report["glossary"]) >= {
        "observed",
        "candidate",
        "scenario_estimate",
        "measured_change",
        "unknown_cost",
    }
    assert report["observed"]["spend"]["by_currency"] == [{"currency": "USD", "amount": "0.105"}]
    assert len(report["calls"]) == 11
    finding = next(f for f in report["findings"] if f["id"] == target["id"])
    assert finding["dismissed"] and finding["dismissal_note"] == "Known loop"
    for f in report["findings"]:
        assert f["rule"]["summary"] and f["limitations"] and f["evidence"]["kind"]
        assert f["affected"] and all(a["record_id"] for a in f["affected"])


def test_html_report_is_standalone_and_escaped(client) -> None:
    hostile = record(
        1, attribution={"environment": "test", "labels": {"step": "<script>alert(1)</script>"}}
    )
    hostile["run"]["name"] = "<script>alert(1)</script>"
    detail = upload(client, jsonl([with_cost(hostile, "0.5")]), "<i>x.jsonl").json()
    response = client.get(f"/api/imports/{detail['id']}/report?format=html")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "default-src 'none'" in response.headers["content-security-policy"]
    html = response.text
    assert "<script" not in html
    assert "&lt;i&gt;x.jsonl" in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html
    assert "$0.50" in html
    assert "http://" not in html and "https://cdn" not in html  # no external assets
    assert "<link" not in html


def test_delete_run_reanalyzes_and_keeps_surviving_dismissals(client) -> None:
    detail = upload_file(client, KORA_SAMPLES / "inefficient_agent.jsonl")
    runs = {r["run_id"]: r["id"] for r in detail["runs"]}
    keep = next(
        f
        for f in detail["findings"]
        if f["category"] == "duplicate_repeated" and len(f["affected"]) == 2
    )
    client.patch(f"/api/findings/{keep['id']}", json={"dismissed": True, "note": "ok"})
    assert any(f["category"] == "cache_reuse" for f in detail["findings"])

    result = client.delete(f"/api/runs/{runs['run-inefficient-002']}").json()
    assert result["deleted"] == "run" and result["reanalyzed"] is True

    after = client.get(f"/api/imports/{detail['id']}").json()
    assert [r["run_id"] for r in after["runs"]] == ["run-inefficient-001"]
    assert not any(f["category"] == "cache_reuse" for f in after["findings"])  # spanned runs
    survivor = next(f for f in after["findings"] if f["id"] == keep["id"])
    assert survivor["dismissed"] and survivor["dismissal_note"] == "ok"

    last = client.delete(f"/api/runs/{runs['run-inefficient-001']}").json()
    assert last["deleted"] == "import"
    assert client.get(f"/api/imports/{detail['id']}").status_code == 404


def test_deleting_an_import_removes_its_comparisons(client) -> None:
    hint = client.post("/api/demo").json()["suggested_comparison"]
    client.post(
        "/api/comparisons",
        json={
            "baseline_run_id": hint["baseline_run_id"],
            "candidate_run_id": hint["candidate_run_id"],
            "equivalence": "equivalent",
        },
    )
    imports = client.get("/api/imports").json()["imports"]
    before = next(i for i in imports if i["demo_key"] == "support-before")
    result = client.delete(f"/api/imports/{before['id']}").json()
    assert result["comparisons"] == 1
    assert client.get("/api/comparisons").json()["comparisons"] == []


def test_demo_seed_is_idempotent_and_labelled(client) -> None:
    first = client.post("/api/demo").json()
    second = client.post("/api/demo").json()
    assert len(first["created"]) == 3 and second["created"] == []
    imports = client.get("/api/imports").json()["imports"]
    assert all(i["synthetic"] and i["source"] == "demo" for i in imports)
    assert client.get("/api/meta").json()["demo"]["loaded"] is True
    assert client.delete("/api/demo").json()["imports"] == 3


def test_mutations_require_client_header_and_same_origin(client) -> None:
    data = (KORA_SAMPLES / "simple.jsonl").read_bytes()
    bare = {"X-Requested-With": ""}
    assert client.post("/api/imports", content=data, headers=bare).status_code == 403
    evil = {"Origin": "https://evil.example"}
    assert client.post("/api/imports", content=data, headers=evil).status_code == 403
    cross = {"Sec-Fetch-Site": "cross-site"}
    assert client.post("/api/demo", headers=cross).status_code == 403
    ok_origin = {"Origin": "http://127.0.0.1:5173"}
    assert client.post("/api/demo", headers=ok_origin).status_code == 201
    assert client.get("/api/imports", headers={"Host": "rebind.example"}).status_code == 400
    response = client.get("/api/imports")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "access-control-allow-origin" not in response.headers


def test_identity_fields_are_never_stored_or_returned(client, settings) -> None:
    rec = record(
        1,
        attribution={
            "environment": "production",
            "account_id": "acct-SECRET-42",
            "user_id": "user-SECRET-7",
            "subscription_id": "sub-SECRET-9",
        },
    )
    rec["resource"]["key_name"] = "prod-key-SECRET"
    rec["run"]["trace_id"] = "trace-SECRET-abc"
    detail = upload(client, jsonl([with_cost(rec, "0.01")]), "private.jsonl").json()
    outputs = [
        json.dumps(detail),
        client.get(f"/api/runs/{detail['runs'][0]['id']}").text,
        client.get(f"/api/imports/{detail['id']}/report").text,
        client.get(f"/api/imports/{detail['id']}/report?format=html").text,
    ]
    db_bytes = b"".join(p.read_bytes() for p in settings.db_path.parent.glob("test.sqlite3*"))
    for secret in (
        "acct-SECRET-42",
        "user-SECRET-7",
        "sub-SECRET-9",
        "prod-key-SECRET",
        "trace-SECRET-abc",
    ):
        assert all(secret not in out for out in outputs), secret
        assert secret.encode() not in db_bytes, secret


def test_unknown_routes_and_ids_return_json_errors(client) -> None:
    assert client.get("/api/nope").json()["error"]["code"] == "not_found"
    assert client.get("/api/runs/run_missing").status_code == 404
    assert client.patch("/api/findings/fnd_missing", json={"dismissed": True}).status_code == 404
    response = client.patch("/api/findings/x", json={"dismissed": "nope"})
    assert response.status_code == 400 and response.json()["error"]["code"] == "bad_request"


def test_filenames_are_display_safe(client) -> None:
    from cost_inspector.importer import clean_filename

    assert clean_filename("../../etc/passwd") == "passwd"
    assert clean_filename("C:\\traces\\run\x07.jsonl") == "run.jsonl"
    assert clean_filename("") == "untitled.jsonl"
    assert len(clean_filename("a" * 500)) == 200


def test_stable_ids_are_deterministic() -> None:
    assert ids.call_id("imp_a", "r1") == ids.call_id("imp_a", "r1")
    assert ids.call_id("imp_a", "r1") != ids.call_id("imp_b", "r1")
    assert ids.finding_id("i", "c", ["b", "a"], ["r"]) == ids.finding_id(
        "i", "c", ["a", "b"], ["r"]
    )


def test_meta_describes_formats_limits_and_rules(client) -> None:
    meta = client.get("/api/meta").json()
    assert meta["audr_spec_version"] == "1.0.0"
    assert meta["limits"]["max_records"] == 10_000
    assert set(meta["categories"]) == {
        "duplicate_repeated",
        "cache_reuse",
        "deterministic_candidate",
        "smaller_model_candidate",
        "orchestration_overhead",
    }
    assert "attribution.user_id" in meta["dropped_fields"]


def test_mixed_fixture_round_trip_through_report(client) -> None:
    detail = upload_file(client, FIXTURES / "mixed_currency_missing.jsonl")
    report = client.get(f"/api/imports/{detail['id']}/report").json()
    assert report["observed"]["spend"]["unknown_calls"] == 1
    html = client.get(f"/api/imports/{detail['id']}/report?format=html").text
    assert "€0.02" in html and "$0.01" in html and "unknown cost" in html


def test_demo_matches_documented_totals(client) -> None:
    """Numbers stated in src/cost_inspector/demo/README.md."""
    client.post("/api/demo")
    by_key = {i["demo_key"]: i for i in client.get("/api/imports").json()["imports"]}
    assert by_key["support-before"]["spend"]["by_currency"] == [
        {"currency": "USD", "amount": "0.09912"}
    ]
    assert by_key["support-after"]["spend"]["by_currency"] == [
        {"currency": "USD", "amount": "0.07272"}
    ]
    partial = by_key["partial-telemetry"]["spend"]
    assert partial["by_currency"] == [
        {"currency": "EUR", "amount": "0.007"},
        {"currency": "USD", "amount": "0.0014"},
    ]
    assert partial["unknown_calls"] == 3
    assert [
        by_key[k]["open_findings"] for k in ("support-before", "support-after", "partial-telemetry")
    ] == [13, 1, 4]
