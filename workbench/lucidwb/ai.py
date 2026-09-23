"""Proposal adapters.

* fixture: returns hand-authored "model" outputs from fixtures/model_outputs. They exercise the
  validation pipeline (including deliberate faults). They say NOTHING about real model quality.
* live: calls Claude through the official `anthropic` SDK when it is installed and credentials
  are configured. Failures are recorded on the run and surfaced; there is no silent fallback.
"""
import json
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
PROMPT_VERSION = "link_proposal_v1"
PROMPT = (HERE / "prompts" / "link_proposal_v1.md").read_text()
FIXTURE_DIR = HERE.parent / "fixtures" / "model_outputs"
DEFAULT_MODEL = os.environ.get("LWB_MODEL", "claude-opus-5")

OUTPUT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["proposals"],
    "properties": {"proposals": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["record_id", "element_id", "predicate", "evidence", "contradictions", "confidence"],
        "properties": {
            "record_id": {"type": "string"},
            "element_id": {"type": ["string", "null"]},
            "predicate": {"type": "string"},
            "evidence": {"type": "array", "items": {
                "type": "object", "additionalProperties": False, "required": ["record_id", "quote"],
                "properties": {"record_id": {"type": "string"}, "quote": {"type": "string"}}}},
            "contradictions": {"type": "array", "items": {"type": "string"}},
            "confidence": {"type": "number"}}}}},
}


class AdapterError(Exception):
    pass


def fixture_propose(record_source, context):
    path = FIXTURE_DIR / f"{record_source}.json"
    if not path.exists():
        raise AdapterError(f"No fixture outputs for record source '{record_source}'.")
    data = json.loads(path.read_text())
    allowed = {r["id"] for r in context["records"]}
    # A fixture can only "see" the permitted records it was given.
    return {"proposals": [p for p in data["proposals"] if p.get("record_id") in allowed]}, {
        "provider": "fixture", "model": f"fixture:{path.name}", "sampling": {}}


def live_propose(record_source, context):
    try:
        import anthropic  # optional dependency: pip install -r requirements-live.txt
    except ImportError:
        raise AdapterError("Live mode requested but the 'anthropic' package is not installed.")
    client = anthropic.Anthropic()
    user = "RECORDS:\n" + json.dumps(context["records"], indent=1) + "\n\nELEMENTS:\n" + json.dumps(
        context["elements"], indent=1)
    sampling = {"max_tokens": 16000, "thinking": {"type": "adaptive"}, "effort": "high"}
    try:
        resp = client.messages.create(
            model=DEFAULT_MODEL, max_tokens=16000, system=PROMPT,
            thinking={"type": "adaptive"},
            output_config={"effort": "high", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
            messages=[{"role": "user", "content": user}])
    except anthropic.APIConnectionError as e:
        raise AdapterError(f"Model API unreachable: {e}")
    except anthropic.AuthenticationError:
        raise AdapterError("Model API credentials missing or rejected.")
    except anthropic.RateLimitError:
        raise AdapterError("Model API rate limited; retry later.")
    except anthropic.APIStatusError as e:
        raise AdapterError(f"Model API error {e.status_code}.")
    if resp.stop_reason == "refusal":
        raise AdapterError("Model declined the request (stop_reason=refusal).")
    if resp.stop_reason == "max_tokens":
        raise AdapterError("Model output truncated (max_tokens).")
    text = next((b.text for b in resp.content if b.type == "text"), None)
    if text is None:
        raise AdapterError("Model returned no text block.")
    try:
        out = json.loads(text)
    except ValueError:
        raise AdapterError("Model returned invalid JSON.")
    return out, {"provider": "anthropic", "model": resp.model, "sampling": sampling,
                 "usage": {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens}}
