"""Loading prediction sets for scoring.

Supported inputs:

* ``authors-results-dir`` — one ``<trajectory_id>.json`` per item as written by the authors' runners
  (``scripts/evaluate_trajectories.py`` / ``llm_judges/evaluate.py``): the parsed verdict object, or
  ``{"raw_response": ...}`` when parsing failed. Files that are not valid JSON are invalid verdicts.
* ``submission-jsonl`` — the authors' submission template rows; an all-null row means "not scored" (missing).
* run predictions produced by this system (see ``runs``), which already carry parsed ``Verdict`` records.

Every loaded set is bound to a dataset version, and unknown ids are rejected by the scorer.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from agenthorizon.judging.parsing import Verdict, validate_object
from agenthorizon.scoring.protocol import PredictionSet, ScoringError, SelectedPrediction
from agenthorizon.util.hashing import sha256_file, tree_digest

IMPORT_PARSER = "author-result-object"


def _verdict_from_object(obj: object) -> Verdict:
    if isinstance(obj, dict) and "success" not in obj and "raw_response" in obj:
        return validate_object(None, parser=IMPORT_PARSER)
    return validate_object(obj if isinstance(obj, dict) else None, parser=IMPORT_PARSER)


def load_authors_results_dir(results_dir: Path, dataset_version_id: str, known_ids: frozenset[str]) -> PredictionSet:
    records = []
    digests = []
    for p in sorted(Path(results_dir).glob("*.json")):
        if p.name.startswith("_"):
            continue
        tid = p.stem
        try:
            uuid.UUID(tid)
        except ValueError:
            continue
        digests.append((p.name, sha256_file(p)))
        try:
            obj = json.loads(p.read_text())
        except (json.JSONDecodeError, UnicodeDecodeError):
            records.append(SelectedPrediction(tid, None, record_ref=str(p)))
            continue
        records.append(SelectedPrediction(tid, _verdict_from_object(obj), record_ref=str(p)))
    return PredictionSet(f"authors-dir:{tree_digest(digests)[:16]}", dataset_version_id, known_ids, records)


def load_submission_jsonl(path: Path, dataset_version_id: str, known_ids: frozenset[str]) -> PredictionSet:
    records = []
    seen: set[str] = set()
    for n, line in enumerate(Path(path).read_text().splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        tid = row.get("trajectory_id")
        if not isinstance(tid, str):
            raise ScoringError(f"{path}:{n}: row without trajectory_id")
        if tid in seen:
            raise ScoringError(f"{path}:{n}: duplicate trajectory_id {tid}")
        seen.add(tid)
        payload = {k: v for k, v in row.items() if k != "trajectory_id"}
        if all(v is None for v in payload.values()):
            continue  # template placeholder: not scored -> missing
        records.append(SelectedPrediction(tid, validate_object(payload, parser="submission-row"), record_ref=f"{path}:{n}"))
    return PredictionSet(f"submission:{sha256_file(path)[:16]}", dataset_version_id, known_ids, records)
