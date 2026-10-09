"""Portable analysis reports: versioned JSON and a self-contained HTML rendering.

A report carries enough data to understand the result without the app: the
glossary of labels, import provenance, observed spend, the rules with their
limits, every finding with its evidence, rationale and dismissal note, the runs
and the normalized calls the findings reference, and any saved comparisons.
Rules and calls are listed once and referenced by category and call_id, so a
large import does not repeat them per finding.
"""

from __future__ import annotations

import functools
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import __version__, views
from .analysis import catalog, kora
from .compare import compare_runs
from .ingest.normalize import decimal_str
from .ingest.validate import AUDR_SPEC_VERSION
from .store import ComparisonRow, Store

REPORT_FORMAT = "ai-cost-inspector/report"
REPORT_VERSION = 1
TEMPLATES = Path(__file__).parent / "templates"
#: Rows per finding table in the HTML rendering; the JSON report lists everything.
HTML_ROWS_PER_FINDING = 25

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
    "Each finding names its calls by call_id (their details are under calls) and its rule and "
    "limits by category (under rules).",
]
ESTIMATE_LINE = (
    "Estimated costs were computed from token counts at Anthropic's published API list prices, "
    "for telemetry that records tokens but no cost (such as Claude Code transcripts). They are "
    "not billed amounts."
)
_COST_WORDS = {"estimated": "Estimated", "mixed": "Observed + estimated"}
PART_LABELS = {
    "cache_read_cost": "Cache reads",
    "cache_write_cost": "Cache writes",
    "output_token_cost": "Output",
    "reasoning_cost": "Thinking (reasoning)",
    "input_token_cost": "Uncached input",
}


def _how_to_read(*spends: dict[str, Any] | None) -> list[str]:
    estimated = any(s and s.get("estimated_calls") for s in spends)
    return [*HOW_TO_READ, ESTIMATE_LINE] if estimated else HOW_TO_READ


def cost_word(*spends: dict[str, Any] | None) -> str:
    """How the report labels costs: Observed, Estimated, or both when they are mixed."""
    bases = {s.get("basis", "reported") for s in spends if s} - {"none"}
    if len(bases) > 1:
        return _COST_WORDS["mixed"]
    return _COST_WORDS.get(next(iter(bases), "reported"), "Observed")


def _header(kind: str) -> dict[str, Any]:
    return {
        "format": REPORT_FORMAT,
        "version": REPORT_VERSION,
        "kind": kind,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "generator": {"name": "AI Cost Inspector", "version": __version__},
        "audr_spec_version": AUDR_SPEC_VERSION,
    }


def rules_json() -> dict[str, Any]:
    """Every rule the analyzer applies, with its limits and scenario ratio, keyed by category."""
    return {
        category: {
            "label": catalog.label_for(category),
            "rule": catalog.rule_for(category),
            "limitations": catalog.limitations_for(category),
            "scenario_ratio": decimal_str(kora.SCENARIO_RATIOS[category]),
            "scenario_percent": decimal_str(kora.SCENARIO_RATIOS[category] * 100),
        }
        for category in catalog.CATEGORY_INFO
    }


def _report_finding(finding: dict[str, Any]) -> dict[str, Any]:
    # Rule and limits live under `rules`, call details under `calls`.
    return {k: v for k, v in finding.items() if k not in ("rule", "limitations", "affected")}


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
    imp = store.get_import(import_id)
    if imp is None:
        return None
    data = views.ImportData(store, imp)
    detail = data.overview(store)
    ctx = data.ctx
    calls = [views.call_json(c, ctx.by_call.get(c.id, ())) for c in data.calls]
    report_findings = sorted(
        (_report_finding(views.finding_json(f, ctx)) for f in data.findings),
        key=lambda f: f["rank"],
    )
    run_pks = {run["id"] for run in detail["runs"]}
    comparisons = []
    for row in store.list_comparisons():
        if row.baseline_run_pk in run_pks or row.candidate_run_pk in run_pks:
            item = comparison_json(store, row)
            if item is not None:
                comparisons.append(item)
    return {
        "report": {**_header("import"), "analyzer": detail["analyzer"]},
        "how_to_read": _how_to_read(detail["spend"]),
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
            "cost_parts": detail["cost_parts"],
        },
        "candidates": {
            "open_findings": detail["open_findings"],
            "dismissed_findings": detail["dismissed_findings"],
            "category_counts": detail["category_counts"],
            "scenario_estimate": detail["scenario"],
        },
        "runs": detail["runs"],
        "rules": rules_json(),
        "findings": report_findings,
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
        "how_to_read": _how_to_read(*(run.get("spend") for run in runs.values())),
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
    env.globals["part_label"] = PART_LABELS.get
    return env


def render_html(report: dict[str, Any]) -> str:
    calls = report.get("calls")
    calls_by_id = {c["id"]: c for c in calls} if isinstance(calls, list) else {}
    if "observed" in report:
        word = cost_word(report["observed"]["spend"])
    else:
        word = cost_word(*(run.get("spend") for run in report.get("runs", {}).values()))
    return (
        _env()
        .get_template("report.html.j2")
        .render(
            r=report,
            calls_by_id=calls_by_id,
            row_limit=HTML_ROWS_PER_FINDING,
            cost_word=word,
        )
    )
