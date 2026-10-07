"""SQLite persistence for imports, runs, normalized calls, findings and comparisons.

The schema is versioned with ``PRAGMA user_version``. Each import is written in
one transaction, so an interrupted import leaves nothing behind. Money is stored
as exact decimal text, never as SQLite REAL.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from functools import cached_property
from pathlib import Path
from typing import Any, Literal, cast

from . import ids
from .analysis.kora import AnalysisResult
from .ingest.issues import Issue
from .ingest.normalize import CallRecord, decimal_str

SCHEMA_VERSION = 1

# Fixed subqueries for targeted loads. Only these constants are ever spliced into SQL;
# every value is bound as parameter ?1.
_TOUCHING_RUN = (  # findings flagging at least one call in run ?1
    "SELECT fc.finding_id FROM finding_calls fc JOIN calls c ON c.id = fc.call_id "
    "WHERE c.run_pk = ?1"
)
_FINDING_SCOPES = {
    "import": "SELECT id FROM findings WHERE import_id = ?1",
    # Findings touching run ?1, plus findings that share a call with them.
    "near_run": (
        "SELECT finding_id FROM finding_calls WHERE call_id IN ("  # noqa: S608 (constants only)
        f"SELECT call_id FROM finding_calls WHERE finding_id IN ({_TOUCHING_RUN}))"
    ),
    # Finding ?1 plus every finding that flags at least one of its calls.
    "near_finding": (
        "SELECT ?1 UNION SELECT finding_id FROM finding_calls WHERE call_id IN ("
        "SELECT call_id FROM finding_calls WHERE finding_id = ?1)"
    ),
}

_SCHEMA_V1 = """
CREATE TABLE imports (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('upload', 'demo')),
    synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1)),
    demo_key TEXT,
    format TEXT NOT NULL,
    file_sha256 TEXT NOT NULL UNIQUE,
    byte_size INTEGER NOT NULL,
    record_count INTEGER NOT NULL,
    accepted_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL,
    analyzed_at TEXT NOT NULL,
    analyzer_json TEXT NOT NULL,
    notes_json TEXT NOT NULL,
    analysis_json TEXT NOT NULL
);

CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    UNIQUE (import_id, run_id)
);
CREATE INDEX runs_import ON runs (import_id, ordinal);

CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    run_pk TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    record_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    line INTEGER NOT NULL,
    item INTEGER NOT NULL,
    spec_version TEXT NOT NULL,
    emitter_component TEXT NOT NULL,
    emitter_name TEXT NOT NULL,
    emitter_version TEXT NOT NULL,
    event_time TEXT NOT NULL,
    event_ms INTEGER NOT NULL,
    received_time TEXT,
    duration_ms INTEGER,
    provider TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    modality TEXT,
    region TEXT,
    deployment TEXT,
    run_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent_span_id TEXT,
    step INTEGER,
    run_name TEXT,
    run_type TEXT,
    outcome TEXT,
    error_code TEXT,
    error_reason TEXT,
    environment TEXT,
    labels_json TEXT NOT NULL,
    usage_kind TEXT NOT NULL CHECK (usage_kind IN ('llm', 'tool')),
    usage_json TEXT NOT NULL,
    cost_total TEXT,
    cost_currency TEXT,
    cost_detail_json TEXT,
    corrects TEXT,
    content_sha256 TEXT NOT NULL,
    UNIQUE (import_id, record_id)
);
CREATE INDEX calls_run ON calls (run_pk, ordinal);
CREATE INDEX calls_import ON calls (import_id, ordinal);

CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    confidence TEXT NOT NULL,
    saving_ratio TEXT NOT NULL,
    record_ids_json TEXT NOT NULL,
    run_ids_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    evidence_status TEXT NOT NULL,
    dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1)),
    dismissal_note TEXT,
    dismissed_at TEXT
);
CREATE INDEX findings_import ON findings (import_id, ordinal);

CREATE TABLE finding_calls (
    finding_id TEXT NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
    call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (finding_id, call_id)
);
CREATE INDEX finding_calls_call ON finding_calls (call_id);

CREATE TABLE comparisons (
    id TEXT PRIMARY KEY,
    baseline_run_pk TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    candidate_run_pk TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    equivalence TEXT NOT NULL
        CHECK (equivalence IN ('equivalent', 'not_equivalent', 'unsure')),
    note TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX comparisons_baseline ON comparisons (baseline_run_pk);
CREATE INDEX comparisons_candidate ON comparisons (candidate_run_pk);
"""

MIGRATIONS: dict[int, str] = {1: _SCHEMA_V1}


class StoreError(RuntimeError):
    pass


class DuplicateImportError(StoreError):
    def __init__(self, existing_id: str) -> None:
        super().__init__(f"file already imported as {existing_id}")
        self.existing_id = existing_id


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _default(value: Any) -> Any:
    if isinstance(value, Decimal):
        return {"$decimal": decimal_str(value)}
    raise TypeError(f"cannot store {type(value).__name__}")


def _hook(obj: dict[str, Any]) -> Any:
    if len(obj) == 1 and "$decimal" in obj:
        return Decimal(obj["$decimal"])
    return obj


def dumps(value: Any) -> str:
    return json.dumps(value, default=_default, ensure_ascii=False, separators=(",", ":"))


_DECODER = json.JSONDecoder(object_hook=_hook)


def loads(text: str) -> Any:
    return _DECODER.decode(text)


@dataclass(frozen=True)
class ImportMeta:
    id: str
    filename: str
    source: str
    synthetic: bool
    demo_key: str | None
    format: str
    file_sha256: str
    byte_size: int
    record_count: int
    notes: list[Issue]


@dataclass(frozen=True)
class ImportRow:
    id: str
    filename: str
    source: str
    synthetic: bool
    demo_key: str | None
    format: str
    file_sha256: str
    byte_size: int
    record_count: int
    accepted_count: int
    imported_at: str
    analyzed_at: str
    analyzer: dict[str, str]
    notes: list[Issue]
    analysis: dict[str, Any]


@dataclass(frozen=True)
class RunRow:
    id: str
    import_id: str
    run_id: str
    ordinal: int
    summary: dict[str, Any]


@dataclass(frozen=True)
class FindingRow:
    id: str
    import_id: str
    ordinal: int
    category: str
    title: str
    reason: str
    confidence: str
    saving_ratio: Decimal
    call_ids: list[str]
    evidence_status: str
    dismissed: bool
    dismissal_note: str | None
    dismissed_at: str | None
    # Stored JSON, decoded on first use: list views read only a little of it.
    record_ids_json: str = field(repr=False)
    run_ids_json: str = field(repr=False)
    evidence_json: str = field(repr=False)

    @cached_property
    def record_ids(self) -> list[str]:
        return cast(list[str], loads(self.record_ids_json))

    @cached_property
    def run_ids(self) -> list[str]:
        return cast(list[str], loads(self.run_ids_json))

    @cached_property
    def evidence(self) -> dict[str, Any]:
        return cast(dict[str, Any], loads(self.evidence_json))


@dataclass(frozen=True)
class ComparisonRow:
    id: str
    baseline_run_pk: str
    candidate_run_pk: str
    equivalence: str
    note: str | None
    created_at: str


_CALL_COLUMNS = (
    "id",
    "import_id",
    "run_pk",
    "record_id",
    "ordinal",
    "line",
    "item",
    "spec_version",
    "emitter_component",
    "emitter_name",
    "emitter_version",
    "event_time",
    "event_ms",
    "received_time",
    "duration_ms",
    "provider",
    "resource_type",
    "resource_name",
    "operation",
    "modality",
    "region",
    "deployment",
    "run_id",
    "span_id",
    "parent_span_id",
    "step",
    "run_name",
    "run_type",
    "outcome",
    "error_code",
    "error_reason",
    "environment",
    "labels_json",
    "usage_kind",
    "usage_json",
    "cost_total",
    "cost_currency",
    "cost_detail_json",
    "corrects",
    "content_sha256",
)


def _call_values(call: CallRecord) -> tuple[Any, ...]:
    return (
        call.id,
        call.import_id,
        call.run_pk,
        call.record_id,
        call.ordinal,
        call.line,
        call.item,
        call.spec_version,
        call.emitter_component,
        call.emitter_name,
        call.emitter_version,
        call.event_time,
        call.event_ms,
        call.received_time,
        call.duration_ms,
        call.provider,
        call.resource_type,
        call.resource_name,
        call.operation,
        call.modality,
        call.region,
        call.deployment,
        call.run_id,
        call.span_id,
        call.parent_span_id,
        call.step,
        call.run_name,
        call.run_type,
        call.outcome,
        call.error_code,
        call.error_reason,
        call.environment,
        dumps(call.labels),
        call.usage_kind,
        dumps(call.usage),
        decimal_str(call.cost_total) if call.cost_total is not None else None,
        call.cost_currency,
        dumps(call.cost_detail) if call.cost_detail is not None else None,
        call.corrects,
        call.content_sha256,
    )


def _row_to_call(row: sqlite3.Row) -> CallRecord:
    return CallRecord(
        import_id=row["import_id"],
        id=row["id"],
        run_pk=row["run_pk"],
        record_id=row["record_id"],
        ordinal=row["ordinal"],
        line=row["line"],
        item=row["item"],
        spec_version=row["spec_version"],
        emitter_component=row["emitter_component"],
        emitter_name=row["emitter_name"],
        emitter_version=row["emitter_version"],
        event_time=row["event_time"],
        event_ms=row["event_ms"],
        received_time=row["received_time"],
        duration_ms=row["duration_ms"],
        provider=row["provider"],
        resource_type=row["resource_type"],
        resource_name=row["resource_name"],
        operation=row["operation"],
        modality=row["modality"],
        region=row["region"],
        deployment=row["deployment"],
        run_id=row["run_id"],
        span_id=row["span_id"],
        parent_span_id=row["parent_span_id"],
        step=row["step"],
        run_name=row["run_name"],
        run_type=row["run_type"],
        outcome=row["outcome"],
        error_code=row["error_code"],
        error_reason=row["error_reason"],
        environment=row["environment"],
        labels=loads(row["labels_json"]),
        usage_kind=row["usage_kind"],
        usage=loads(row["usage_json"]),
        cost_total=Decimal(row["cost_total"]) if row["cost_total"] is not None else None,
        cost_currency=row["cost_currency"],
        cost_detail=loads(row["cost_detail_json"]) if row["cost_detail_json"] else None,
        corrects=row["corrects"],
        content_sha256=row["content_sha256"],
    )


def _row_to_import(row: sqlite3.Row) -> ImportRow:
    return ImportRow(
        id=row["id"],
        filename=row["filename"],
        source=row["source"],
        synthetic=bool(row["synthetic"]),
        demo_key=row["demo_key"],
        format=row["format"],
        file_sha256=row["file_sha256"],
        byte_size=row["byte_size"],
        record_count=row["record_count"],
        accepted_count=row["accepted_count"],
        imported_at=row["imported_at"],
        analyzed_at=row["analyzed_at"],
        analyzer=loads(row["analyzer_json"]),
        notes=[Issue.from_json(n) for n in loads(row["notes_json"])],
        analysis=loads(row["analysis_json"]),
    )


def _row_to_finding(row: sqlite3.Row, call_ids: list[str]) -> FindingRow:
    return FindingRow(
        id=row["id"],
        import_id=row["import_id"],
        ordinal=row["ordinal"],
        category=row["category"],
        title=row["title"],
        reason=row["reason"],
        confidence=row["confidence"],
        saving_ratio=Decimal(row["saving_ratio"]),
        call_ids=call_ids,
        evidence_status=row["evidence_status"],
        dismissed=bool(row["dismissed"]),
        dismissal_note=row["dismissal_note"],
        dismissed_at=row["dismissed_at"],
        record_ids_json=row["record_ids_json"],
        run_ids_json=row["run_ids_json"],
        evidence_json=row["evidence_json"],
    )


def _row_to_comparison(row: sqlite3.Row) -> ComparisonRow:
    return ComparisonRow(
        id=row["id"],
        baseline_run_pk=row["baseline_run_pk"],
        candidate_run_pk=row["candidate_run_pk"],
        equivalence=row["equivalence"],
        note=row["note"],
        created_at=row["created_at"],
    )


def analysis_json(analysis: AnalysisResult) -> dict[str, Any]:
    """Analyzer outputs kept for transparency (the inspector's money uses Decimal)."""
    return {
        "category_counts": analysis.category_counts,
        "warnings": analysis.warnings,
        "kora_observed_costs": analysis.kora_observed_costs,
        "kora_potential_savings": analysis.kora_potential_savings,
        "records": analysis.records,
        "model_calls": analysis.model_calls,
        "tool_calls": analysis.tool_calls,
        "runs": analysis.runs,
    }


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            self._migrate(conn)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        try:
            yield conn
        finally:
            conn.close()

    def _migrate(self, conn: sqlite3.Connection) -> None:
        current = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if current > SCHEMA_VERSION:
            raise StoreError(
                f"The database at {self.path} uses schema version {current}, newer than this "
                f"app supports ({SCHEMA_VERSION}). Upgrade the app or use another ACI_DB_PATH."
            )
        for version in range(current + 1, SCHEMA_VERSION + 1):
            with conn:
                conn.executescript(MIGRATIONS[version])
                conn.execute(f"PRAGMA user_version = {version}")

    # ---------------------------------------------------------------- imports

    def find_import_by_sha(self, sha256: str) -> str | None:
        with self.connect() as conn:
            row = conn.execute("SELECT id FROM imports WHERE file_sha256 = ?", (sha256,)).fetchone()
        return str(row["id"]) if row else None

    def insert_import(
        self,
        meta: ImportMeta,
        calls: Sequence[CallRecord],
        analysis: AnalysisResult,
        run_summaries: dict[str, dict[str, Any]],
    ) -> None:
        stamp = now_iso()
        with self.connect() as conn, conn:
            existing = conn.execute(
                "SELECT id FROM imports WHERE file_sha256 = ?", (meta.file_sha256,)
            ).fetchone()
            if existing:
                raise DuplicateImportError(existing["id"])
            conn.execute(
                "INSERT INTO imports (id, filename, source, synthetic, demo_key, format, "
                "file_sha256, byte_size, record_count, accepted_count, imported_at, analyzed_at, "
                "analyzer_json, notes_json, analysis_json) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    meta.id,
                    meta.filename,
                    meta.source,
                    int(meta.synthetic),
                    meta.demo_key,
                    meta.format,
                    meta.file_sha256,
                    meta.byte_size,
                    meta.record_count,
                    len(calls),
                    stamp,
                    stamp,
                    dumps(analysis.analyzer.to_json()),
                    dumps([n.to_json() for n in meta.notes]),
                    dumps(analysis_json(analysis)),
                ),
            )
            self._insert_runs(conn, meta.id, calls, run_summaries)
            placeholders = ", ".join("?" for _ in _CALL_COLUMNS)
            conn.executemany(
                f"INSERT INTO calls ({', '.join(_CALL_COLUMNS)}) VALUES ({placeholders})",  # noqa: S608
                [_call_values(c) for c in calls],
            )
            self._write_findings(conn, meta.id, calls, analysis, previous={})

    def _insert_runs(
        self,
        conn: sqlite3.Connection,
        import_id: str,
        calls: Sequence[CallRecord],
        run_summaries: dict[str, dict[str, Any]],
    ) -> None:
        seen: dict[str, str] = {}
        for call in sorted(calls, key=lambda c: c.ordinal):
            if call.run_pk not in seen:
                seen[call.run_pk] = call.run_id
        conn.executemany(
            "INSERT INTO runs (id, import_id, run_id, ordinal, summary_json) "
            "VALUES (?, ?, ?, ?, ?)",
            [
                (pk, import_id, run_id, ordinal, dumps(run_summaries[pk]))
                for ordinal, (pk, run_id) in enumerate(seen.items())
            ],
        )

    def _write_findings(
        self,
        conn: sqlite3.Connection,
        import_id: str,
        calls: Sequence[CallRecord],
        analysis: AnalysisResult,
        previous: dict[str, sqlite3.Row],
    ) -> None:
        call_by_record = {c.record_id: c.id for c in calls}
        for finding in analysis.findings:
            fid = ids.finding_id(import_id, finding.category, finding.record_ids, finding.run_ids)
            prior = previous.get(fid)
            conn.execute(
                "INSERT INTO findings (id, import_id, ordinal, category, title, reason, "
                "confidence, saving_ratio, record_ids_json, run_ids_json, evidence_json, "
                "evidence_status, dismissed, dismissal_note, dismissed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    fid,
                    import_id,
                    finding.ordinal,
                    finding.category,
                    finding.title,
                    finding.reason,
                    finding.confidence,
                    decimal_str(finding.saving_ratio),
                    dumps(finding.record_ids),
                    dumps(finding.run_ids),
                    dumps(finding.evidence),
                    finding.evidence_status,
                    prior["dismissed"] if prior else 0,
                    prior["dismissal_note"] if prior else None,
                    prior["dismissed_at"] if prior else None,
                ),
            )
            conn.executemany(
                "INSERT INTO finding_calls (finding_id, call_id, position) VALUES (?, ?, ?)",
                [(fid, call_by_record[rid], pos) for pos, rid in enumerate(finding.record_ids)],
            )

    def list_imports(self) -> list[ImportRow]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM imports ORDER BY imported_at, id").fetchall()
        return [_row_to_import(r) for r in rows]

    def get_import(self, import_id: str) -> ImportRow | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM imports WHERE id = ?", (import_id,)).fetchone()
        return _row_to_import(row) if row else None

    def delete_import(self, import_id: str) -> dict[str, int] | None:
        with self.connect() as conn, conn:
            if not conn.execute("SELECT 1 FROM imports WHERE id = ?", (import_id,)).fetchone():
                return None
            counts = {
                "runs": self._count(
                    conn, "SELECT COUNT(*) FROM runs WHERE import_id = ?", import_id
                ),
                "calls": self._count(
                    conn, "SELECT COUNT(*) FROM calls WHERE import_id = ?", import_id
                ),
                "findings": self._count(
                    conn, "SELECT COUNT(*) FROM findings WHERE import_id = ?", import_id
                ),
                "comparisons": self._count(
                    conn,
                    "SELECT COUNT(*) FROM comparisons WHERE baseline_run_pk IN "
                    "(SELECT id FROM runs WHERE import_id = ?1) OR candidate_run_pk IN "
                    "(SELECT id FROM runs WHERE import_id = ?1)",
                    import_id,
                ),
            }
            conn.execute("DELETE FROM imports WHERE id = ?", (import_id,))
        return counts

    def replace_after_run_delete(
        self,
        import_id: str,
        run_pk: str,
        remaining: Sequence[CallRecord],
        analysis: AnalysisResult,
        run_summaries: dict[str, dict[str, Any]],
    ) -> dict[str, int]:
        """Delete one run and store the re-analysis of the import's remaining calls.

        Findings whose stable ID survives keep their dismissal state.
        """
        with self.connect() as conn, conn:
            counts = {
                "calls": self._count(conn, "SELECT COUNT(*) FROM calls WHERE run_pk = ?", run_pk),
                "comparisons": self._count(
                    conn,
                    "SELECT COUNT(*) FROM comparisons WHERE baseline_run_pk = ?1 "
                    "OR candidate_run_pk = ?1",
                    run_pk,
                ),
            }
            previous = {
                row["id"]: row
                for row in conn.execute(
                    "SELECT id, dismissed, dismissal_note, dismissed_at FROM findings "
                    "WHERE import_id = ?",
                    (import_id,),
                ).fetchall()
            }
            conn.execute("DELETE FROM findings WHERE import_id = ?", (import_id,))
            conn.execute("DELETE FROM runs WHERE id = ?", (run_pk,))
            for pk, summary in run_summaries.items():
                conn.execute("UPDATE runs SET summary_json = ? WHERE id = ?", (dumps(summary), pk))
            conn.execute(
                "UPDATE imports SET accepted_count = ?, analyzed_at = ?, analysis_json = ? "
                "WHERE id = ?",
                (len(remaining), now_iso(), dumps(analysis_json(analysis)), import_id),
            )
            self._write_findings(conn, import_id, remaining, analysis, previous)
        return counts

    # ------------------------------------------------------------------- runs

    def list_runs(self, import_id: str | None = None) -> list[RunRow]:
        with self.connect() as conn:
            if import_id is None:
                rows = conn.execute("SELECT * FROM runs ORDER BY import_id, ordinal").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM runs WHERE import_id = ? ORDER BY ordinal", (import_id,)
                ).fetchall()
        return [
            RunRow(r["id"], r["import_id"], r["run_id"], r["ordinal"], loads(r["summary_json"]))
            for r in rows
        ]

    def get_run(self, run_pk: str) -> RunRow | None:
        with self.connect() as conn:
            r = conn.execute("SELECT * FROM runs WHERE id = ?", (run_pk,)).fetchone()
        if not r:
            return None
        return RunRow(r["id"], r["import_id"], r["run_id"], r["ordinal"], loads(r["summary_json"]))

    # ------------------------------------------------------------------ calls

    def load_calls(self, import_id: str, run_pk: str | None = None) -> list[CallRecord]:
        with self.connect() as conn:
            if run_pk is None:
                rows = conn.execute(
                    "SELECT * FROM calls WHERE import_id = ? ORDER BY ordinal", (import_id,)
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM calls WHERE run_pk = ? ORDER BY ordinal", (run_pk,)
                ).fetchall()
        return [_row_to_call(r) for r in rows]

    def load_finding_calls(self, finding_id: str) -> list[CallRecord]:
        """The calls one finding flags, in the analyzer's order."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT c.* FROM calls c JOIN finding_calls fc ON fc.call_id = c.id "
                "WHERE fc.finding_id = ? ORDER BY fc.position",
                (finding_id,),
            ).fetchall()
        return [_row_to_call(r) for r in rows]

    def load_calls_flagged_with_run(self, run_pk: str) -> list[CallRecord]:
        """Calls in other runs that share a finding with this run's calls."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM calls WHERE run_pk != ?1 AND id IN ("  # noqa: S608 (constant)
                f"SELECT call_id FROM finding_calls WHERE finding_id IN ({_TOUCHING_RUN})"
                ") ORDER BY ordinal",
                (run_pk,),
            ).fetchall()
        return [_row_to_call(r) for r in rows]

    # --------------------------------------------------------------- findings

    def _load_findings(
        self, scope: Literal["import", "near_run", "near_finding"], key: str
    ) -> list[FindingRow]:
        id_query = _FINDING_SCOPES[scope]
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM findings WHERE id IN ({id_query}) ORDER BY ordinal",  # noqa: S608
                (key,),
            ).fetchall()
            links = conn.execute(
                "SELECT finding_id, call_id FROM finding_calls "  # noqa: S608 (fixed scope)
                f"WHERE finding_id IN ({id_query}) ORDER BY finding_id, position",
                (key,),
            ).fetchall()
        by_finding: dict[str, list[str]] = {}
        for link in links:
            by_finding.setdefault(link["finding_id"], []).append(link["call_id"])
        return [_row_to_finding(r, by_finding.get(r["id"], [])) for r in rows]

    def load_findings(self, import_id: str) -> list[FindingRow]:
        return self._load_findings("import", import_id)

    def load_findings_near_run(self, run_pk: str) -> list[FindingRow]:
        """Findings flagging any call in the run, plus findings that share a call with them."""
        return self._load_findings("near_run", run_pk)

    def load_findings_near_finding(self, finding_id: str) -> list[FindingRow]:
        """The finding plus every finding that flags at least one of its calls."""
        return self._load_findings("near_finding", finding_id)

    def finding_rank_inputs(self, import_id: str) -> list[tuple[str, str, str, int, int]]:
        """(id, confidence, category, ordinal, call count) for every finding in an import."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT f.id, f.confidence, f.category, f.ordinal, COUNT(fc.call_id) AS calls "
                "FROM findings f LEFT JOIN finding_calls fc ON fc.finding_id = f.id "
                "WHERE f.import_id = ? GROUP BY f.id",
                (import_id,),
            ).fetchall()
        return [(r["id"], r["confidence"], r["category"], r["ordinal"], r["calls"]) for r in rows]

    def get_finding(self, finding_id: str) -> FindingRow | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM findings WHERE id = ?", (finding_id,)).fetchone()
            if not row:
                return None
            links = conn.execute(
                "SELECT call_id FROM finding_calls WHERE finding_id = ? ORDER BY position",
                (finding_id,),
            ).fetchall()
        return _row_to_finding(row, [link["call_id"] for link in links])

    def import_finding_counts(self) -> dict[str, dict[str, int]]:
        """Per import: open and dismissed findings (one aggregate query)."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT import_id, SUM(dismissed = 0) AS open, SUM(dismissed = 1) AS dismissed "
                "FROM findings GROUP BY import_id"
            ).fetchall()
        return {r["import_id"]: {"open": r["open"], "dismissed": r["dismissed"]} for r in rows}

    def set_dismissal(self, finding_id: str, dismissed: bool, note: str | None) -> bool:
        with self.connect() as conn, conn:
            cur = conn.execute(
                "UPDATE findings SET dismissed = ?, dismissal_note = ?, dismissed_at = ? "
                "WHERE id = ?",
                (
                    int(dismissed),
                    note if dismissed else None,
                    now_iso() if dismissed else None,
                    finding_id,
                ),
            )
            return cur.rowcount == 1

    def finding_counts(self) -> dict[str, dict[str, int]]:
        """Per run: open and dismissed findings touching it, and flagged calls (open only)."""
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT c.run_pk AS run_pk, "
                "COUNT(DISTINCT CASE WHEN f.dismissed = 0 THEN f.id END) AS open_findings, "
                "COUNT(DISTINCT CASE WHEN f.dismissed = 1 THEN f.id END) AS dismissed_findings, "
                "COUNT(DISTINCT CASE WHEN f.dismissed = 0 THEN c.id END) AS flagged_calls "
                "FROM finding_calls fc JOIN findings f ON f.id = fc.finding_id "
                "JOIN calls c ON c.id = fc.call_id GROUP BY c.run_pk"
            ).fetchall()
        return {
            r["run_pk"]: {
                "open_findings": r["open_findings"],
                "dismissed_findings": r["dismissed_findings"],
                "flagged_calls": r["flagged_calls"],
            }
            for r in rows
        }

    # ------------------------------------------------------------ comparisons

    def insert_comparison(
        self, baseline_run_pk: str, candidate_run_pk: str, equivalence: str, note: str | None
    ) -> ComparisonRow:
        row = ComparisonRow(
            id=ids.new_comparison_id(),
            baseline_run_pk=baseline_run_pk,
            candidate_run_pk=candidate_run_pk,
            equivalence=equivalence,
            note=note,
            created_at=now_iso(),
        )
        with self.connect() as conn, conn:
            conn.execute(
                "INSERT INTO comparisons (id, baseline_run_pk, candidate_run_pk, equivalence, "
                "note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    row.id,
                    row.baseline_run_pk,
                    row.candidate_run_pk,
                    row.equivalence,
                    row.note,
                    row.created_at,
                ),
            )
        return row

    def list_comparisons(self) -> list[ComparisonRow]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM comparisons ORDER BY created_at DESC").fetchall()
        return [_row_to_comparison(r) for r in rows]

    def get_comparison(self, comparison_id: str) -> ComparisonRow | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM comparisons WHERE id = ?", (comparison_id,)
            ).fetchone()
        return _row_to_comparison(row) if row else None

    def delete_comparison(self, comparison_id: str) -> bool:
        with self.connect() as conn, conn:
            cur = conn.execute("DELETE FROM comparisons WHERE id = ?", (comparison_id,))
            return cur.rowcount == 1

    # ------------------------------------------------------------------ admin

    def delete_all(self, *, demo_only: bool = False) -> int:
        with self.connect() as conn, conn:
            if demo_only:
                cur = conn.execute("DELETE FROM imports WHERE source = 'demo'")
            else:
                conn.execute("DELETE FROM comparisons")
                cur = conn.execute("DELETE FROM imports")
            return cur.rowcount

    @staticmethod
    def _count(conn: sqlite3.Connection, sql: str, *params: Any) -> int:
        return int(conn.execute(sql, params).fetchone()[0])
