"""Reachability probes that classify *why* a source could not be retrieved.

A policy denial from an egress proxy is recorded differently from a 404 or a timeout, so the source lock
and availability report can say precisely which artifact is blocked and by what.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Literal
from urllib.parse import urlparse

import httpx

from agenthorizon.util.io import utcnow_iso

Outcome = Literal[
    "ok",
    "http_error",
    "egress_denied",
    "dns_error",
    "timeout",
    "tls_error",
    "connection_error",
]


@dataclass
class ProbeResult:
    url: str
    at: str
    outcome: Outcome
    status_code: int | None
    detail: str

    def to_dict(self) -> dict:
        return asdict(self)


def _proxy_status_failures(host: str) -> list[dict]:
    """If routed through a local agent proxy that exposes a status endpoint, return its failures for host."""
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    if not proxy or not proxy.startswith("http://127.0.0.1"):
        return []
    try:
        r = httpx.get(proxy.rstrip("/") + "/__agentproxy/status", timeout=5, trust_env=False)
        data = r.json()
    except Exception:
        return []
    return [f for f in data.get("recentRelayFailures", []) if f.get("host", "").split(":")[0] == host]


def probe_url(url: str, timeout: float = 15.0) -> ProbeResult:
    at = utcnow_iso()
    host = urlparse(url).hostname or ""
    try:
        r = httpx.get(url, timeout=timeout, follow_redirects=False)
    except httpx.ProxyError as exc:
        msg = str(exc)
        failures = _proxy_status_failures(host)
        detail = f"proxy refused CONNECT: {msg}"
        if failures:
            detail += f"; proxy status: {failures[-1].get('detail')}"
        outcome: Outcome = "egress_denied" if "403" in msg or "407" in msg else "connection_error"
        return ProbeResult(url, at, outcome, None, detail)
    except httpx.ConnectTimeout as exc:
        return ProbeResult(url, at, "timeout", None, f"connect timeout: {exc}")
    except httpx.ReadTimeout as exc:
        return ProbeResult(url, at, "timeout", None, f"read timeout: {exc}")
    except httpx.ConnectError as exc:
        msg = str(exc)
        kind: Outcome = "dns_error" if "Name or service" in msg or "nodename" in msg else "connection_error"
        if "CERTIFICATE" in msg.upper():
            kind = "tls_error"
        return ProbeResult(url, at, kind, None, msg[:300])
    except httpx.HTTPError as exc:
        return ProbeResult(url, at, "connection_error", None, f"{type(exc).__name__}: {exc}"[:300])
    if 200 <= r.status_code < 400:
        return ProbeResult(url, at, "ok", r.status_code, "")
    return ProbeResult(url, at, "http_error", r.status_code, r.text[:300])
