"""Execute one direct-judge attempt.

Mirrors ``llm_judges/evaluate.py``: a rate limit waits and re-sends inside the same attempt and does not consume a
judgment attempt; the fifth rate-limited call ends the attempt (``while rate_limit_retries < 5``); any other provider/transport failure ends the attempt (the attempt policy
may then start a fresh attempt, as the reference's outer retry loop did). Limit violations end the attempt as
``serving_incompatible`` — the payload is never truncated. Missing credentials or unavailable models are
``blocked``.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from agenthorizon.judging.contract import ArtifactRef, AttemptOutcome, Telemetry
from agenthorizon.judging.direct.limits import ProviderLimits, check
from agenthorizon.judging.direct.packaging import DirectPayload
from agenthorizon.judging.direct.providers import (
    ProviderError,
    RateLimited,
    ServingIncompatible,
    TransportError,
)
from agenthorizon.judging.parsing import DIRECT_PARSER_ID, parse_direct
from agenthorizon.util.hashing import sha256_file


def _store(run_dir: Path, dest: Path, text: str) -> ArtifactRef:
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text)
    return ArtifactRef(str(dest.relative_to(run_dir)), sha256_file(dest), dest.stat().st_size)


def run_direct_attempt(provider, payload: DirectPayload, model: str, sampling: dict, *, run_dir: Path, task_dir: Path,
                       limits: ProviderLimits, max_rate_limit_resends: int = 4, sleep=time.sleep,
                       cancel: threading.Event | None = None) -> AttemptOutcome:
    art = task_dir / "artifacts"
    lim_check = check(payload.n_images, payload.approx_request_bytes, payload.token_estimate, limits)
    lineage = {
        "interface": "direct", "route": getattr(provider, "route", None), "provider": type(provider).__name__,
        "model_requested": model, "sampling": sampling, "seed": None, "seed_supported": False,
        "preprocessing_id": payload.preprocessing_id, "preprocessing_params": payload.params,
        "payload_manifest_digest": payload.manifest_digest, "pillow_version": payload.pillow_version,
        "parser": DIRECT_PARSER_ID, "limits": limits.to_dict(), "limit_check": lim_check,
        "retry_policy": {"rate_limit_resends_per_attempt": max_rate_limit_resends,
                         "other_transport_errors": "end the attempt (attempt policy may start a fresh one)"},
    }
    artifacts = {"payload_manifest": _store(run_dir, art / "payload-manifest.json", json.dumps(payload.manifest(), indent=1))}
    if not lim_check["fits"]:
        return AttemptOutcome("serving_incompatible", error=f"payload exceeds limits: {lim_check['violations']}",
                              artifacts=artifacts, lineage=lineage, telemetry=Telemetry().finalize())
    retries: list[dict] = []
    t0 = time.monotonic()
    while True:
        if cancel is not None and cancel.is_set():
            return AttemptOutcome("cancelled", artifacts=artifacts, transport_retries=retries, lineage=lineage,
                                  telemetry=Telemetry(wall_time_s=time.monotonic() - t0).finalize())
        try:
            resp = provider.call(payload, model, sampling)
            break
        except RateLimited as exc:
            retries.append({"n": len(retries) + 1, "kind": "rate_limit", "status": exc.status, "retry_after_s": exc.retry_after,
                            "error": str(exc)[:300]})
            if sum(1 for r in retries if r["kind"] == "rate_limit") > max_rate_limit_resends:
                return AttemptOutcome("rate_limited", error="rate limited too many times", artifacts=artifacts,
                                      transport_retries=retries, lineage=lineage,
                                      telemetry=Telemetry(wall_time_s=time.monotonic() - t0).finalize())
            sleep(exc.retry_after or 60)
        except TransportError as exc:
            retries.append({"n": len(retries) + 1, "kind": "transport", "status": exc.status, "error": str(exc)[:300]})
            return AttemptOutcome("transport_failed", error=str(exc)[:500], artifacts=artifacts, transport_retries=retries,
                                  lineage=lineage, telemetry=Telemetry(wall_time_s=time.monotonic() - t0).finalize())
        except ServingIncompatible as exc:
            return AttemptOutcome("serving_incompatible", error=str(exc)[:500], artifacts=artifacts, transport_retries=retries,
                                  lineage=lineage, telemetry=Telemetry(wall_time_s=time.monotonic() - t0).finalize())
        except ProviderError as exc:
            status = "blocked" if exc.status in (401, 403, 404) else "transport_failed"
            return AttemptOutcome(status, error=str(exc)[:500], artifacts=artifacts, transport_retries=retries,
                                  lineage=lineage, telemetry=Telemetry(wall_time_s=time.monotonic() - t0).finalize())
    wall = time.monotonic() - t0
    u = resp.usage or {}
    t = Telemetry(
        input_tokens=u.get("prompt_tokens", u.get("input_tokens")),
        output_tokens=u.get("completion_tokens", u.get("output_tokens")),
        cached_input_tokens=u.get("cache_read_input_tokens"),
        reasoning_tokens=u.get("thoughts_tokens"),
        images_viewed=payload.n_images,
        tool_calls=0, turns=1, wall_time_s=wall, model_reported=resp.model_reported,
    )
    t.coverage.update(images_viewed="reported", tool_calls="reported", turns="reported", wall_time_s="reported")
    t.finalize()
    lineage.update(model_reported=resp.model_reported, request_sha256=resp.request_sha256,
                   request_bytes=resp.request_bytes, stop_reason=resp.stop_reason, provider_meta=resp.raw_meta)
    artifacts["response"] = _store(run_dir, art / "response.txt", resp.text)
    if resp.thinking:
        artifacts["thinking"] = _store(run_dir, art / "thinking.txt", resp.thinking)
    return AttemptOutcome("completed", response_text=resp.text, verdict=parse_direct(resp.text), telemetry=t,
                          transport_retries=retries, artifacts=artifacts, lineage=lineage)
