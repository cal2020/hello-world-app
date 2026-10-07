"""Import orchestration: bytes → validated records → normalized calls → analysis → store."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass

from . import ids
from .analysis.kora import AnalysisResult, run_analysis
from .config import Settings
from .ingest.issues import Issue, IssueList
from .ingest.normalize import CallRecord, normalize_items
from .ingest.parse import parse_document
from .ingest.sink import apply_sink_rules
from .ingest.validate import validate_items
from .store import DuplicateImportError, ImportMeta, Store
from .summaries import summarize_runs

MAX_FILENAME = 200


class ImportRejectedError(Exception):
    """The file cannot be imported; ``issues`` say where and how to fix it."""

    def __init__(self, message: str, issues: IssueList, *, records_seen: int = 0) -> None:
        super().__init__(message)
        self.message = message
        self.issues = issues
        self.records_seen = records_seen


@dataclass(frozen=True)
class ImportSummary:
    import_id: str
    record_count: int
    accepted_count: int
    notes: list[Issue]


def clean_filename(name: str | None) -> str:
    """Display-safe filename: no directories, control characters or excess length."""
    raw = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    raw = "".join(ch for ch in raw if unicodedata.category(ch)[0] != "C")
    raw = re.sub(r"\s+", " ", raw).strip()
    if len(raw) > MAX_FILENAME:
        raw = raw[: MAX_FILENAME - 1] + "…"
    return raw or "untitled.jsonl"


def analyze_import(
    data: bytes, settings: Settings, import_id: str
) -> tuple[str, int, list[CallRecord], list[Issue], AnalysisResult]:
    """Run every stage that can reject a file. Raises :class:`ImportRejectedError`."""
    parsed = parse_document(
        data, max_records=settings.max_records, max_issues=settings.max_reported_issues
    )
    errors = parsed.issues
    record_count = parsed.record_count
    if parsed.format is None or (errors and not parsed.items):
        raise ImportRejectedError(_reject_message(errors), errors, records_seen=record_count)

    # Sink rules run on the schema-valid records even when others failed, so one
    # rejection lists every problem in the file.
    valid = validate_items(parsed.items, errors)
    sink = apply_sink_rules(valid, errors)
    if errors:
        raise ImportRejectedError(_reject_message(errors), errors, records_seen=record_count)

    calls = normalize_items(sink.accepted, errors, import_id)
    if errors:
        raise ImportRejectedError(_reject_message(errors), errors, records_seen=record_count)
    if not calls:
        errors.add(
            Issue(
                code="nothing_to_analyze",
                message="No records remain to analyze: every record was voided by a correction.",
                hint="Import the file that contains the records the corrections refer to.",
            )
        )
        raise ImportRejectedError(_reject_message(errors), errors, records_seen=record_count)

    analysis = run_analysis(calls)
    notes = list(sink.notes)
    return parsed.format.value, record_count, calls, notes, analysis


def _reject_message(errors: IssueList) -> str:
    if errors.total == 1:
        return "The file was not imported: 1 problem needs fixing."
    return f"The file was not imported: {errors.total} problems need fixing."


def import_bytes(
    store: Store,
    settings: Settings,
    data: bytes,
    filename: str | None,
    *,
    source: str = "upload",
    synthetic: bool = False,
    demo_key: str | None = None,
) -> ImportSummary:
    """Validate, analyze and store one file. Nothing is stored if any stage fails."""
    sha256 = hashlib.sha256(data).hexdigest()
    existing = store.find_import_by_sha(sha256)
    if existing:
        raise DuplicateImportError(existing)

    import_id = ids.new_import_id()
    file_format, record_count, calls, notes, analysis = analyze_import(data, settings, import_id)
    meta = ImportMeta(
        id=import_id,
        filename=clean_filename(filename),
        source=source,
        synthetic=synthetic,
        demo_key=demo_key,
        format=file_format,
        file_sha256=sha256,
        byte_size=len(data),
        record_count=record_count,
        notes=notes,
    )
    store.insert_import(meta, calls, analysis, summarize_runs(calls))
    return ImportSummary(import_id, record_count, len(calls), notes)


def delete_run(store: Store, run_pk: str) -> dict[str, object] | None:
    """Delete one run. The import's remaining runs are re-analyzed, because some
    findings (cache/reuse) span runs. Deleting an import's only run deletes the import."""
    run = store.get_run(run_pk)
    if run is None:
        return None
    all_calls = store.load_calls(run.import_id)
    remaining = [c for c in all_calls if c.run_pk != run_pk]
    if not remaining:
        counts = store.delete_import(run.import_id) or {}
        return {"deleted": "import", "import_id": run.import_id, **counts}
    analysis = run_analysis(remaining)
    counts = store.replace_after_run_delete(
        run.import_id, run_pk, remaining, analysis, summarize_runs(remaining)
    )
    return {"deleted": "run", "import_id": run.import_id, "reanalyzed": True, **counts}
