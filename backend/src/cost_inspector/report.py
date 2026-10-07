"""Portable analysis reports: versioned JSON and a self-contained HTML rendering.

A report carries enough data to understand the result without the app: the
glossary of labels, import provenance, observed spend, every finding with its
rule, evidence, rationale, limitations and dismissal note, the runs and the
normalized calls they reference, and any saved comparisons.
"""

from __future__ import annotations

import functools
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import __version__, views
from .analysis import catalog
from .compare import compare_runs
from .ingest.validate import AUDR_SPEC_VERSION
from .store import ComparisonRow, Store

REPORT_FORMAT = "ai-cost-inspector/report"
REPORT_VERSION = 1
TEMPLATES = Path(__file__).parent / "templates"

PRIVACY = (
    "This report contains normalized AUDR telemetry only. AUDR records carry no prompt or "
    "response content. User, account, subscription, credential-label and trace identifiers "
    "were dropped at import."
)
HOW_TO_READ = [
    "Observed values come straight from the imported telemetry.",
    "Findings are candidates for review produced by heuristics; none of them proves waste.",
    "Scenario estimates apply KORA Doctor's fixed assumptions to observed cost; each call is "
    "counted once at its highest ratio.",
    "A measured change requires two runs with complete, comparable costs that the user marked "
    "as equivalent work. Output quality is never measured.",
]


def _header(kind: str) -> dict[str, Any]:
    return {
        "format": REPORT_FORMAT,
        "version": REPORT_VERSION,
        "kind": kind,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "generator": {"name": "AI Cost Inspector", "version": __version__},
        "audr_spec_version": AUDR_SPEC_VERSION,
    }


def comparison_result(store: Store, row: ComparisonRow) -> dict[str, Any] | None:
    base_run = store.get_run(row.baseline_run_pk)
    cand_run = store.get_run(row.candidate_run_pk)
    if base_run is None or cand_run is None:
        return None
    counts = store.finding_counts()
    base_imp = store.get_import(base_run.import_id)
    cand_imp = store.get_import(cand_run.import_id)
    assert base_imp is not None and cand_imp is not None
    return compare_runs(
        views.run_summary_json(base_run, base_imp, counts),
        views.run_summary_json(cand_run, cand_imp, counts),
        store.load_calls(base_run.import_id, base_run.id),
        store.load_calls(cand_run.import_id, cand_run.id),
        row.equivalence,
    )


def comparison_json(store: Store, row: ComparisonRow) -> dict[str, Any] | None:
    result = comparison_result(store, row)
    if result is None:
        return None
    return {
        "id": row.id,
        "created_at": row.created_at,
        "equivalence": row.equivalence,
        "note": row.note,
        "result": result,
    }


def import_report(store: Store, import_id: str) -> dict[str, Any] | None:
    detail = views.import_detail(store, import_id)
    if detail is None:
        return None
    findings = store.load_findings(import_id)
    by_call: dict[str, list[Any]] = {}
    for finding in findings:
        for cid in finding.call_ids:
            by_call.setdefault(cid, []).append(finding)
    calls = [views.call_json(c, by_call.get(c.id, ())) for c in store.load_calls(import_id)]
    run_pks = {run["id"] for run in detail["runs"]}
    comparisons = []
    for row in store.list_comparisons():
        if row.baseline_run_pk in run_pks or row.candidate_run_pk in run_pks:
            item = comparison_json(store, row)
            if item is not None:
                comparisons.append(item)
    imp = store.get_import(import_id)
    assert imp is not None
    return {
        "report": {**_header("import"), "analyzer": detail["analyzer"]},
        "how_to_read": HOW_TO_READ,
        "glossary": catalog.GLOSSARY,
        "privacy": PRIVACY,
        "import": {
            key: detail[key]
            for key in (
                "id",
                "filename",
                "source",
                "synthetic",
                "format",
                "file_sha256",
                "byte_size",
                "record_count",
                "accepted_count",
                "imported_at",
                "analyzed_at",
                "notes",
            )
        },
        "observed": {
            "spend": detail["spend"],
            "runs": len(detail["runs"]),
            "calls": len(calls),
            "by_model": detail["by_model"],
        },
        "candidates": {
            "open_findings": detail["open_findings"],
            "dismissed_findings": detail["dismissed_findings"],
            "category_counts": detail["category_counts"],
            "scenario_estimate": detail["scenario"],
        },
        "runs": detail["runs"],
        "findings": detail["findings"],
        "calls": calls,
        "comparisons": comparisons,
        "analyzer_raw": {
            "float_totals": {
                "observed_costs": imp.analysis.get("kora_observed_costs"),
                "potential_savings": imp.analysis.get("kora_potential_savings"),
            },
            "note": "Totals as computed by the analyzer with binary floating point, included only "
            "for cross-checking. Every amount elsewhere in this report uses exact decimal "
            "arithmetic.",
        },
    }


def comparison_report(store: Store, comparison_id: str) -> dict[str, Any] | None:
    row = store.get_comparison(comparison_id)
    if row is None:
        return None
    item = comparison_json(store, row)
    if item is None:
        return None
    runs = {}
    calls = {}
    counts = store.finding_counts()
    for side, pk in (("baseline", row.baseline_run_pk), ("candidate", row.candidate_run_pk)):
        run = store.get_run(pk)
        assert run is not None
        imp = store.get_import(run.import_id)
        assert imp is not None
        runs[side] = views.run_summary_json(run, imp, counts)
        calls[side] = [views.call_json(c) for c in store.load_calls(run.import_id, run.id)]
    return {
        "report": _header("comparison"),
        "how_to_read": HOW_TO_READ,
        "glossary": catalog.GLOSSARY,
        "privacy": PRIVACY,
        "comparison": item,
        "runs": runs,
        "calls": calls,
    }


_SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£", "JPY": "¥"}


def money(amount: str | None, currency: str | None) -> str:
    """Exact amount with a currency marker; never rounds."""
    if amount is None or currency is None:
        return "unknown"
    negative = amount.startswith("-")
    digits = amount.lstrip("-")
    if "." not in digits:
        digits += ".00"
    elif len(digits.split(".")[1]) < 2:
        digits += "0"
    symbol = _SYMBOLS.get(currency)
    text = f"{symbol}{digits}" if symbol else f"{digits} {currency}"
    return f"−{text}" if negative else text


def spend_text(spend: dict[str, Any]) -> str:
    parts = [money(m["amount"], m["currency"]) for m in spend["by_currency"]]
    text = " + ".join(parts) if parts else "no reported cost"
    if spend["unknown_calls"]:
        text += f" (+{spend['unknown_calls']} call(s) with unknown cost)"
    return text


@functools.cache
def _env() -> Environment:
    env = Environment(
        loader=FileSystemLoader(TEMPLATES),
        autoescape=select_autoescape(["html", "j2"], default=True),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.filters["money"] = lambda m: money(m.get("amount"), m.get("currency"))
    env.filters["spend"] = spend_text
    env.globals["label_for"] = catalog.label_for
    return env


def render_html(report: dict[str, Any]) -> str:
    return _env().get_template("report.html.j2").render(r=report)
