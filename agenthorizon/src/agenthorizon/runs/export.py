"""Deterministic research bundle for one run (``agenthorizon export``).

The bundle holds the run definition, controls/state, the full event log, every attempt record (raw responses,
parsed verdicts, telemetry, lineage), task finalizations, the selected predictions, an optional score report, and
provenance (source-lock digest, code identity, dataset version). It never contains credentials: text is passed
through the redactor and checked against secret values present in the exporting environment. Raw media is never
included (licence unverified). Archive bytes depend only on content (sorted entries, zero timestamps/ownership).

A bundle that includes a score report carries label-derived per-item outcomes: it must never be staged as a judge
workspace.
"""

from __future__ import annotations

import gzip
import io
import json
import os
import tarfile
from pathlib import Path

from agenthorizon.config import PROJECT_ROOT, Settings
from agenthorizon.judging.contract import redact
from agenthorizon.runs.identity import git_state
from agenthorizon.runs.store import FileRunStore
from agenthorizon.util.hashing import sha256_bytes, sha256_file

EXPORT_SCHEMA = "ah-run-bundle/1"
SECRET_ENV_HINTS = ("API_KEY", "TOKEN", "SECRET", "AUTH_JSON", "PASSWORD")

README = """AgentHorizon run bundle ({schema})

run_id: {run_id}
result kind: {kind}
dataset version: {dv}{synthetic}

Contents
  run/definition.json   canonical run definition (its digest is the run id)
  run/state.json        status, run controls, budget ledger
  run/events.jsonl      append-only event log
  run/attempts.jsonl    every attempt (raw response, parsed verdict, telemetry, lineage, cost)
  run/finals.jsonl      task finalizations (selected attempt per the selection rule)
  predictions.jsonl     the selected prediction per finalized task (missing tasks are absent)
  score/                score report (if requested) — CONTAINS LABEL-DERIVED PER-ITEM OUTCOMES
  provenance.json       source-lock digest, code identity, dataset version record
  MANIFEST.json         sha256 of every file in this bundle

Never stage this bundle (or anything derived from score/) as a judge workspace.
Raw screenshots are not included.
"""


def _secret_values() -> list[str]:
    return [v for k, v in os.environ.items() if v and len(v) >= 8 and any(h in k.upper() for h in SECRET_ENV_HINTS)]


def _clean(text: str, secrets: list[str]) -> tuple[str, int]:
    out = redact(text)
    n = 0
    for v in secrets:
        if v in out:
            n += out.count(v)
            out = out.replace(v, "[REDACTED]")
    return out, n + (0 if out == text else 1)


def build_bundle(settings: Settings, run: str | object, *, score_report: dict | None = None,
                 score_markdown: str | None = None, include_artifacts: bool = False) -> tuple[dict[str, bytes], dict]:
    """``run`` is a run id (file store) or any run-store instance (file or PostgreSQL)."""
    store = FileRunStore(settings.runs_dir / run) if isinstance(run, str) else run
    run_id = store.run_id
    if not store.exists():
        raise FileNotFoundError(f"no run {run_id}")
    d = store.definition()
    files: dict[str, bytes] = {}
    secrets = _secret_values()
    redactions = 0

    def put(name: str, text: str) -> None:
        nonlocal redactions
        clean, n = _clean(text, secrets)
        redactions += n
        files[name] = clean.encode()

    put("run/definition.json", json.dumps(d.to_dict(), indent=1, sort_keys=True))
    put("run/state.json", json.dumps(store.state(), indent=1, sort_keys=True))
    put("run/events.jsonl", "".join(json.dumps(e, sort_keys=True) + "\n" for e in store.events()))
    attempts, finals, preds = [], [], []
    for eid in d.example_ids:
        recs = store.attempts(eid)
        attempts += [json.dumps(r.to_dict(), sort_keys=True) for r in recs]
        fin = store.final(eid)
        if fin:
            finals.append(json.dumps({"example_id": eid, **fin}, sort_keys=True))
            if fin.get("has_response"):
                rec = next(r for r in recs if r.attempt_no == fin["selected_attempt"])
                v = rec.verdict
                preds.append(json.dumps({"example_id": eid, "attempt": rec.attempt_no,
                                         "success": v.success if v else None,
                                         "binary_valid": v.binary_valid if v else False,
                                         "mistake_type_native": v.mistake_type_native if v else None,
                                         "confidence": v.confidence if v else None,
                                         "raw_response": rec.outcome.get("response_text")}, sort_keys=True))
    put("run/attempts.jsonl", "".join(a + "\n" for a in attempts))
    put("run/finals.jsonl", "".join(f + "\n" for f in finals))
    put("predictions.jsonl", "".join(p + "\n" for p in preds))
    if score_report is not None:
        put("score/report.json", json.dumps(score_report, indent=1, sort_keys=True))
    if score_markdown:
        put("score/report.md", score_markdown)
    lock = PROJECT_ROOT / "evidence" / "SOURCE_LOCK.json"
    dv_record = settings.datasets_dir / d.dataset_version_id / "version.json"
    put("provenance.json", json.dumps({
        "schema": EXPORT_SCHEMA, "run_id": run_id, "definition_digest": d.digest, "code": d.code, "git": git_state(),
        "source_lock_sha256": sha256_file(lock) if lock.is_file() else None,
        "dataset_version": json.loads(dv_record.read_text()) if dv_record.is_file() else None,
        "media_included": False, "media_note": "screenshots excluded: release licence unverified",
    }, indent=1, sort_keys=True))
    if include_artifacts:
        for p in sorted((store.dir / "tasks").rglob("*")):
            if not p.is_file() or "/workspace/" in str(p) or "/home/" in str(p.relative_to(store.dir)):
                continue
            rel = p.relative_to(store.dir)
            if "artifacts" not in rel.parts:
                continue
            put(f"artifacts/{rel}", p.read_text(errors="replace"))
    put("README.txt", README.format(schema=EXPORT_SCHEMA, run_id=run_id, kind=d.classification.get("result_kind"),
                                    dv=d.dataset_version_id,
                                    synthetic="  [SYNTHETIC TEST FIXTURE — not benchmark content]" if d.synthetic_data else ""))
    manifest = {"schema": EXPORT_SCHEMA, "run_id": run_id, "redactions_applied": redactions,
                "files": [{"path": k, "sha256": sha256_bytes(v), "bytes": len(v)} for k, v in sorted(files.items())]}
    files["MANIFEST.json"] = json.dumps(manifest, indent=1, sort_keys=True).encode()
    return files, manifest


def write_tar_gz(files: dict[str, bytes], output: Path) -> str:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for name in sorted(files):
            data = files[name]
            ti = tarfile.TarInfo(name)
            ti.size, ti.mtime, ti.mode, ti.uid, ti.gid, ti.uname, ti.gname = len(data), 0, 0o644, 0, 0, "", ""
            tar.addfile(ti, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0) as gz:
        gz.write(raw.getvalue())
    output.parent.mkdir(parents=True, exist_ok=True)
    tmp = output.with_suffix(output.suffix + ".partial")
    tmp.write_bytes(out.getvalue())
    os.replace(tmp, output)
    return sha256_bytes(out.getvalue())
