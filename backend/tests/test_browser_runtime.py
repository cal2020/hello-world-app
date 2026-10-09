"""The browser build's request shim, exercised under CPython the way the worker calls it."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from conftest import CLIENT_HEADERS, jsonl, record, with_cost

from cost_inspector import browser_runtime


def call(
    method: str, target: str, body: bytes | None = None, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, str], bytes]:
    meta_json, data = asyncio.run(
        browser_runtime.handle(method, target, json.dumps(headers or {}), body)
    )
    meta = json.loads(meta_json)
    return meta["status"], {k.lower(): v for k, v in meta["headers"]}, data


def as_json(data: bytes) -> Any:
    return json.loads(data)


def test_the_shim_serves_the_real_api(tmp_path: Path) -> None:
    browser_runtime.boot(str(tmp_path / "browser" / "inspector.sqlite3"))

    status, headers, data = call("GET", "/api/meta")
    assert status == 200 and headers["content-type"].startswith("application/json")
    assert as_json(data)["app"]["name"] == "AI Cost Inspector"

    # The same security checks run: a change without the client header is refused.
    assert call("POST", "/api/demo")[0] == 403
    assert call("POST", "/api/demo", headers=CLIENT_HEADERS)[0] == 201
    imports = as_json(call("GET", "/api/imports")[2])["imports"]
    assert {i["demo_key"] for i in imports} == {
        "support-before",
        "support-after",
        "partial-telemetry",
    }

    # Uploads pass the body and the percent-encoded file name through unchanged.
    upload = jsonl([with_cost(record(1), "0.25"), with_cost(record(2), "0.5")])
    status, _, data = call(
        "POST", "/api/imports?filename=my%20trace.jsonl", upload, {**CLIENT_HEADERS}
    )
    assert status == 201, data
    detail = as_json(data)
    assert detail["filename"] == "my trace.jsonl"
    assert detail["spend"]["by_currency"] == [{"currency": "USD", "amount": "0.75"}]

    status, _, data = call(
        "POST", "/api/imports?filename=bad.jsonl", b"{}\nnot json\n", CLIENT_HEADERS
    )
    assert status == 422
    assert {issue["line"] for issue in as_json(data)["error"]["issues"]} >= {1, 2}

    status, headers, data = call("GET", f"/api/imports/{detail['id']}/report?format=html")
    assert status == 200 and "attachment" in headers["content-disposition"]
    assert b"my trace.jsonl" in data

    status, _, data = call("GET", "/api/runs/run_missing")
    assert status == 404 and as_json(data)["error"]["code"] == "not_found"


def test_data_persists_in_the_database_file(tmp_path: Path) -> None:
    db = tmp_path / "inspector.sqlite3"
    browser_runtime.boot(str(db))
    assert call("POST", "/api/demo", headers=CLIENT_HEADERS)[0] == 201
    # A new boot on the same file (what the worker does after restoring it) sees the data.
    browser_runtime.boot(str(db))
    assert len(as_json(call("GET", "/api/imports")[2])["imports"]) == 3
