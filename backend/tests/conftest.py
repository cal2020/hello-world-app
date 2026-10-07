from __future__ import annotations

import copy
import json
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from cost_inspector.app import create_app
from cost_inspector.config import Settings
from cost_inspector.store import Store

FIXTURES = Path(__file__).parent / "fixtures"
KORA_SAMPLES = FIXTURES / "kora-doctor"
AUDR_FIXTURES = FIXTURES / "audr"
DEMO_DIR = Path(__file__).parents[1] / "src" / "cost_inspector" / "demo"
CLIENT_HEADERS = {"X-Requested-With": "cost-inspector"}

BASE_RECORD: dict[str, Any] = {
    "spec_version": "1.0.0",
    "record_id": "01KTEST0000000000000000001",
    "emitter": {"component": "router", "name": "test", "version": "1.0.0"},
    "timing": {"event_time": "2026-10-07T12:00:00.000Z", "duration_ms": 500},
    "resource": {
        "provider": "anthropic",
        "type": "model",
        "name": "claude-sonnet-4-5",
        "operation": "generation",
        "modality": "text",
    },
    "run": {"run_id": "run-test-0001", "span_id": "span-1", "step": 1},
    "attribution": {"environment": "test"},
    "usage": {"llm": {"input_tokens": 100, "output_tokens": 20, "requests": 1}},
}


class Raw(str):
    """A JSON number written verbatim (exact decimal text) by :func:`jsonl`."""


DELETE = object()


def record(index: int = 1, **overrides: Any) -> dict[str, Any]:
    """A valid AUDR model record; dotted keys override nested fields."""
    rec = copy.deepcopy(BASE_RECORD)
    rec["record_id"] = f"01KTEST{index:019d}"
    rec["run"]["span_id"] = f"span-{index}"
    rec["run"]["step"] = index
    rec["timing"]["event_time"] = f"2026-10-07T12:00:{index % 60:02d}.000Z"
    for key, value in overrides.items():
        target = rec
        parts = key.split("__")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        if value is DELETE:
            target.pop(parts[-1], None)
        else:
            target[parts[-1]] = value
    return rec


def tool_record(index: int, **overrides: Any) -> dict[str, Any]:
    rec = record(index, **overrides)
    rec["resource"] = {
        "provider": "self-hosted",
        "type": "tool",
        "name": "search",
        "operation": "tool_execution",
    }
    rec["usage"] = {"tool": {"type": "invocation", "call_count": 1}}
    for key, value in overrides.items():
        if key.startswith(("resource__", "usage__")):
            target = rec
            parts = key.split("__")
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = value
    return rec


def with_cost(rec: dict[str, Any], amount: str, currency: str = "USD") -> dict[str, Any]:
    rec = copy.deepcopy(rec)
    rec["cost"] = {"total_cost": Raw(amount), "currency": currency}
    return rec


def jsonl(records: list[dict[str, Any]]) -> bytes:
    """JSONL where Raw values become unquoted JSON numbers with their exact text."""
    marker = "__raw_number__"

    def mark(value: Any) -> Any:
        if isinstance(value, Raw):
            return f"{marker}{value}{marker}"
        if isinstance(value, dict):
            return {k: mark(v) for k, v in value.items()}
        if isinstance(value, list):
            return [mark(v) for v in value]
        return value

    lines = [json.dumps(mark(r), separators=(",", ":")) for r in records]
    text = "\n".join(lines) + "\n"
    return re.sub(rf'"{marker}(.*?){marker}"', r"\1", text).encode("utf-8")


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    # "testserver" is the Host header Starlette's TestClient sends.
    return Settings(
        db_path=tmp_path / "test.sqlite3", static_dir=None, extra_allowed_hosts=("testserver",)
    )


@pytest.fixture
def store(settings: Settings) -> Store:
    return Store(settings.db_path)


@pytest.fixture
def make_client(settings: Settings) -> Callable[..., TestClient]:
    def factory(**overrides: Any) -> TestClient:
        params = {**settings.__dict__, **overrides}
        client = TestClient(create_app(Settings(**params)))
        client.headers.update(CLIENT_HEADERS)
        return client

    return factory


@pytest.fixture
def client(make_client: Callable[..., TestClient]) -> Iterator[TestClient]:
    with make_client() as c:
        yield c


def upload(client: TestClient, data: bytes, filename: str = "trace.jsonl") -> Any:
    return client.post(f"/api/imports?filename={filename}", content=data)


def upload_file(client: TestClient, path: Path) -> dict[str, Any]:
    response = upload(client, path.read_bytes(), path.name)
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def full_findings(client: TestClient, detail: dict[str, Any]) -> list[dict[str, Any]]:
    """Lists carry finding summaries; fetch each finding's full evidence and limits."""
    out = []
    for summary in detail["findings"]:
        response = client.get(f"/api/findings/{summary['id']}")
        assert response.status_code == 200, response.text
        out.append(response.json())
    return out
