"""Capability diagnostics for every registered judge configuration (``agenthorizon judges doctor``).

Installation, credential presence (names only, never values), model identifier evidence, serving route, egress
reachability from this host, multimodal support, and isolation are reported *independently*. A configuration is
``supported`` only after a live probe delivered an image and got a parseable answer; without a live probe the best
status is ``unverified``. Nothing is inferred from an API key merely existing.
"""

from __future__ import annotations

import base64
import importlib.util
import io
from functools import cache

from agenthorizon.judging.contract import CapabilityReport
from agenthorizon.judging.harnesses import ADAPTERS, ROUTE_HOSTS
from agenthorizon.judging.isolation.sandbox import isolation_available
from agenthorizon.judging.registry import CONFIGS, MODELS_BY_KEY, JudgeConfig
from agenthorizon.util.io import utcnow_iso

DIRECT_SDK = {"google": "google.genai", "anthropic": "anthropic", "vllm": "httpx", "openrouter": "httpx"}
PROBE_URLS = {
    "anthropic": "https://api.anthropic.com/",
    "google": "https://generativelanguage.googleapis.com/",
    "openrouter": "https://openrouter.ai/api/v1/models",
    "openai": "https://api.openai.com/v1/models",
    "chatgpt_subscription": "https://chatgpt.com/",
}


@cache
def route_egress(route: str) -> dict:
    """Can this host reach the route's provider at all (no credentials sent)?"""
    url = PROBE_URLS.get(route)
    if url is None:
        return {"ok": None, "detail": "operator-hosted endpoint; probe with the configured base URL"}
    from agenthorizon.sources.probe import probe_url

    r = probe_url(url, timeout=10)
    reachable = r.outcome in ("ok", "http_error")  # any HTTP answer proves the route is reachable
    return {"ok": reachable, "outcome": r.outcome, "status": r.status_code, "url": url, "hosts": sorted(ROUTE_HOSTS.get(route, ())),
            "detail": r.detail}


def _probe_png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (220, 20, 20)).save(buf, "PNG")
    return buf.getvalue()


def live_direct_probe(cfg: JudgeConfig, secrets: dict, base_url: str | None = None, provider=None) -> dict:
    """One minimal multimodal request: a red square, asked for its colour as JSON. Costs a few hundred tokens."""
    from agenthorizon.judging.direct import providers as P
    from agenthorizon.judging.direct.packaging import DirectPayload, PayloadPart

    data = _probe_png()
    msg = [{"role": "system", "content": "Answer with JSON only."},
           {"role": "user", "content": [{"type": "text", "text": 'What colour fills this image? Reply {"colour": "<name>"}.'},
                                        {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(data).decode()}}]}]
    payload = DirectPayload("capability-probe", "probe", {}, msg, [PayloadPart("image", "probe", {})], 1, [64, 64], 200, len(data) * 2)
    try:
        if provider is None:
            if cfg.route == "anthropic":
                provider = P.AnthropicProvider(secrets["ANTHROPIC_API_KEY"])
            elif cfg.route == "google":
                provider = P.GeminiProvider(secrets["GEMINI_API_KEY"])
            elif cfg.route == "vllm":
                provider = P.OpenAICompatibleProvider("vllm", base_url or "", secrets.get("VLLM_API_KEY") or "EMPTY")
            elif cfg.route == "openrouter":
                provider = P.OpenAICompatibleProvider("openrouter", "https://openrouter.ai/api/v1", secrets["OPENROUTER_API_KEY"])
            else:
                return {"ok": None, "detail": f"no live probe for route {cfg.route}"}
        resp = provider.call(payload, cfg.provider_model_id, {"max_output_tokens": 64})
    except P.ProviderError as exc:
        return {"ok": False, "status": exc.status, "detail": str(exc)[:300],
                "model_unavailable": exc.status == 404}
    except (P.TransportError, P.ServingIncompatible) as exc:
        return {"ok": False, "detail": f"{type(exc).__name__}: {str(exc)[:300]}"}
    saw_red = "red" in (resp.text or "").lower()
    return {"ok": True, "image_delivered": saw_red, "model_reported": resp.model_reported, "answer": (resp.text or "")[:200],
            "at": utcnow_iso()}


def _version_of(a, memo: dict | None) -> str | None:
    """``--version`` of an adapter's binary, run at most once per binary within one capability report."""
    if memo is None:
        return a.version()
    key = a.binary_path()
    if key not in memo:
        memo[key] = a.version()
    return memo[key]


def diagnose(cfg: JudgeConfig, *, environ: dict | None = None, probe_network: bool = True, live: bool = False,
             base_urls: dict | None = None, versions: dict | None = None) -> CapabilityReport:
    from agenthorizon.runs.judges import load_secrets, required_secret_names

    m = MODELS_BY_KEY[cfg.model_key]
    checks: dict[str, dict] = {}
    reasons: list[str] = []
    status = "unverified"

    checks["model_identifier"] = {"ok": cfg.provider_model_id is not None, "value": cfg.provider_model_id,
                                  "evidence": cfg.id_evidence}
    checks["route"] = {"ok": cfg.route is not None, "value": cfg.route}
    if cfg.interface == "direct":
        if cfg.route == "chatgpt_subscription":
            a = ADAPTERS["codex"]
            v = _version_of(a, versions)
            checks["installation"] = {"ok": bool(a.binary_path()), "binary": a.binary_path(), "version": v,
                                      "verified_version": a.verified_version, "matches_verified": a.version_matches(v)}
        else:
            mod = DIRECT_SDK.get(cfg.route or "", "httpx")
            checks["installation"] = {"ok": importlib.util.find_spec(mod) is not None, "sdk": mod}
    else:
        a = ADAPTERS[cfg.interface]
        v = _version_of(a, versions)
        checks["installation"] = {"ok": bool(a.binary_path() and v), "binary": a.binary_path(), "version": v,
                                  "verified_version": a.verified_version, "matches_verified": a.version_matches(v),
                                  "package": a.package}
        iso_ok, iso_detail = isolation_available()
        checks["isolation"] = {"ok": iso_ok, "detail": iso_detail}
        checks["paper_mode_instructions"] = {"ok": False, "detail": "official AGENTS.md not located in the release; "
                                             "paper-mode runs need an operator-registered file, extension runs stage the "
                                             "public rubric instead"}
    names = required_secret_names(cfg.interface, cfg.route) if cfg.route else []
    secrets, missing = load_secrets(names, environ)
    checks["credentials"] = {"ok": not missing if names else None, "required": names, "missing": missing}
    checks["multimodal"] = {"ok": m.vision_input, "detail": "registry (vendor description); verified only by a live probe"}
    if probe_network and cfg.route:
        checks["route_egress"] = route_egress(cfg.route)

    if cfg.provider_model_id is None:
        reasons.append("no released artifact states the provider model identifier")
    if cfg.route is None:
        reasons.append("serving route not stated by any accessible source")
    if not checks["installation"]["ok"]:
        reasons.append("harness/SDK not installed")
    elif checks["installation"].get("matches_verified") is False:
        reasons.append(f"installed {checks['installation']['version']!r} is not the verified release "
                       f"{checks['installation']['verified_version']} (runs are extension-class)")
    if checks.get("isolation") and not checks["isolation"]["ok"]:
        reasons.append("isolation backend unavailable")
    if missing:
        reasons.append(f"credentials missing: {', '.join(missing)}")
    endpoint_missing = cfg.route == "vllm" and not (base_urls or {}).get(cfg.config_id)
    if endpoint_missing:
        reasons.append("self-hosted endpoint required (operator supplies --base-url and GPU serving)")
    eg = checks.get("route_egress")
    if eg and eg.get("ok") is False:
        reasons.append(f"route host unreachable from this environment ({eg.get('outcome')})")
    hard_block = (cfg.provider_model_id is None or cfg.route is None or not checks["installation"]["ok"] or bool(missing)
                  or (eg is not None and eg.get("ok") is False) or endpoint_missing)
    if hard_block:
        status = "blocked"
    elif live and cfg.interface == "direct":
        lp = live_direct_probe(cfg, secrets, (base_urls or {}).get(cfg.config_id))
        checks["live_probe"] = lp
        if lp.get("model_unavailable"):
            status, reasons = "unavailable", reasons + ["provider reports the model identifier unknown (404)"]
        elif lp.get("ok") and lp.get("image_delivered"):
            status = "supported"
        else:
            reasons.append("live probe did not confirm image understanding")
    else:
        reasons.append("no live probe run (requires credentials and an explicit --live)")
    return CapabilityReport(cfg.config_id, cfg.interface, checks, status, reasons)


def doctor(*, environ: dict | None = None, probe_network: bool = True, live: bool = False,
           base_urls: dict | None = None) -> dict:
    versions: dict = {}  # one --version per binary for the whole report
    reports = [diagnose(c, environ=environ, probe_network=probe_network, live=live, base_urls=base_urls, versions=versions)
               for c in CONFIGS]
    counts: dict[str, int] = {}
    for r in reports:
        counts[r.status] = counts.get(r.status, 0) + 1
    return {"generated_at": utcnow_iso(), "live_probes": live, "counts": counts,
            "note": "Credential checks report variable names only. 'supported' requires a live multimodal probe.",
            "configurations": [r.to_dict() for r in reports]}
