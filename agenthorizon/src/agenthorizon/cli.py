"""``agenthorizon`` command-line interface. Every command maps onto the same library used by the API."""

from __future__ import annotations

import json
from pathlib import Path

import typer

from agenthorizon.config import PROJECT_ROOT, get_settings

app = typer.Typer(no_args_is_help=True, add_completion=False, help="AgentHorizon research core and workbench")
sources_app = typer.Typer(no_args_is_help=True, help="Source discovery, pinning, and locking")
app.add_typer(sources_app, name="sources")

EVIDENCE_DIR = PROJECT_ROOT / "evidence"


@sources_app.command("lock")
def sources_lock(
    output: Path = typer.Option(EVIDENCE_DIR / "SOURCE_LOCK.json", help="Where to write the lock"),
    master_prompt: Path | None = typer.Option(None, help="Path to the implementation brief, to record its digest"),
) -> None:
    """Probe, pin, retrieve, and digest every registered source; write SOURCE_LOCK.json."""
    from agenthorizon.sources.lock import build_lock
    from agenthorizon.util.io import atomic_write_json

    settings = get_settings()
    lock = build_lock(settings, master_prompt_path=master_prompt)
    atomic_write_json(output, lock)
    for s in lock["sources"]:
        rev = s.get("resolved_revision") or "-"
        typer.echo(f"{s['citation']:<22} {s['source_id']:<28} {s['status']:<14} {rev[:12]}")
    typer.echo(f"wrote {output}")


@sources_app.command("probe")
def sources_probe() -> None:
    """Classify reachability of every registered source URL (egress denial vs. HTTP error vs. ok)."""
    from agenthorizon.sources.probe import probe_url
    from agenthorizon.sources.registry import SOURCES

    for spec in SOURCES:
        for url in spec.probe_urls or spec.urls:
            r = probe_url(url)
            typer.echo(f"{spec.source_id:<28} {r.outcome:<16} {r.status_code or '':<4} {url}")


@sources_app.command("checkout")
def sources_checkout(source_id: str, revision: str | None = typer.Option(None)) -> None:
    """Materialize a pinned checkout of a git source into the source cache and print its path."""
    from agenthorizon.sources.gitsource import ensure_checkout, resolve_revision
    from agenthorizon.sources.lock import KNOWN_PINS, SHALLOW_SOURCES
    from agenthorizon.sources.registry import get_source

    spec = get_source(source_id)
    if spec.kind != "git":
        raise typer.BadParameter(f"{source_id} is not a git source")
    commit = revision or KNOWN_PINS.get(source_id) or resolve_revision(spec.urls[0], spec.requested_revision)[0]
    co = ensure_checkout(spec.urls[0], commit, get_settings().sources_dir, shallow=source_id in SHALLOW_SOURCES)
    typer.echo(json.dumps({"source_id": source_id, "commit": co.commit, "path": str(co.path)}))


evidence_app = typer.Typer(no_args_is_help=True, help="Generate machine-readable evidence files under evidence/")
app.add_typer(evidence_app, name="evidence")


@evidence_app.command("reference")
def evidence_reference(output: Path = typer.Option(EVIDENCE_DIR / "REFERENCE_DATA.json")) -> None:
    """Capture author-reported aggregates with provenance, plus consistency analyses over them."""
    from agenthorizon.reference.analysis import (
        REVISED_CHECK_TABLE,
        check_table_identities,
        legacy_composition_inference,
        mt_definition_analysis,
    )
    from agenthorizon.reference.tables import check_construction_arithmetic, construction_accounting, supplementary_tables
    from agenthorizon.util.io import atomic_write_json, utcnow_iso

    tables = supplementary_tables()
    acc = construction_accounting()
    mt = mt_definition_analysis(tables)
    data = {
        "generated_at": utcnow_iso(),
        "warning": "Reference observations only. Generated results live in separate score reports.",
        "supplementary_tables": tables,
        "construction_accounting": acc,
        "construction_arithmetic_checks": check_construction_arithmetic(acc),
        "revised_check_table": REVISED_CHECK_TABLE,
        "revised_check_table_identities": check_table_identities(),
        "analysis_aggregate_mt_definition": mt,
        "analysis_legacy_composition": legacy_composition_inference(tables, mt),
    }
    atomic_write_json(output, data)
    typer.echo(f"wrote {output}: {len(tables)} tables; MT conclusion: {mt['supported_hypotheses']}")


@evidence_app.command("availability")
def evidence_availability(output: Path = typer.Option(EVIDENCE_DIR / "DATA_AVAILABILITY.json")) -> None:
    """Classify every referenced artifact as acquired / published-but-unavailable / not-located / not-applicable."""
    from agenthorizon.sources.availability import availability_report
    from agenthorizon.sources.cache import load_lock
    from agenthorizon.util.io import atomic_write_json

    rep = availability_report(load_lock(), get_settings().var_dir)
    atomic_write_json(output, rep)
    typer.echo(f"wrote {output}: {rep['counts']}")


@evidence_app.command("inventory")
def evidence_inventory(output: Path = typer.Option(EVIDENCE_DIR / "EXPERIMENT_INVENTORY.json")) -> None:
    """Models, judge configurations, and every experiment row evidenced by accessible tables."""
    from agenthorizon.reference.inventory import inventory
    from agenthorizon.reference.tables import supplementary_tables
    from agenthorizon.util.io import atomic_write_json

    inv = inventory(supplementary_tables())
    atomic_write_json(output, inv)
    unmatched = [e for e in inv["experiments_from_reference_tables"] if not e["config_id"]]
    typer.echo(f"wrote {output}: {len(inv['configurations'])} configs, "
               f"{len(inv['experiments_from_reference_tables'])} table-row experiments ({len(unmatched)} unmatched)")


def main() -> None:  # pragma: no cover
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
