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


data_app = typer.Typer(no_args_is_help=True, help="Ingest, validate, and inspect dataset versions")
app.add_typer(data_app, name="data")
media_app = typer.Typer(no_args_is_help=True, help="Media materialization and coverage")
app.add_typer(media_app, name="media")
fixture_app = typer.Typer(no_args_is_help=True, help="Synthetic TEST fixture (never benchmark content)")
app.add_typer(fixture_app, name="fixture")


def _dataset(dataset_version: str):
    from agenthorizon.data.dataset import DatasetVersion

    return DatasetVersion(get_settings().datasets_dir / dataset_version)


@data_app.command("ingest")
def data_ingest(
    source: str = typer.Option("agenthorizon", help="Registered source id (agenthorizon) or 'local'"),
    revision: str = typer.Option("main", help="Dataset revision (branch, tag, or commit sha) to pin"),
    local_dir: Path | None = typer.Option(None, help="Directory mirroring the released layout (with --source local)"),
    media: str = typer.Option("none", help="none: index metadata only (lazy media); all: materialize every screenshot"),
) -> None:
    """Discover, pin, download, validate, normalize, index, and reconcile a release."""
    from agenthorizon.data.ingest import IngestOptions, ingest
    from agenthorizon.sources.hf import HFError

    opts = IngestOptions(source="local" if source == "local" else "hf", revision=revision, local_dir=local_dir, media=media)
    try:
        r = ingest(get_settings(), opts, log=typer.echo)
    except HFError as exc:
        typer.echo(f"BLOCKED ({exc.kind}): {exc}", err=True)
        raise typer.Exit(2) from exc
    typer.echo(json.dumps({"dataset_version_id": r.dataset_version_id, "status": r.status, "summary": r.summary}, indent=2))


@data_app.command("list")
def data_list() -> None:
    """List ingested dataset versions."""
    root = get_settings().datasets_dir
    for p in sorted(root.glob("*/version.json")) if root.is_dir() else []:
        v = json.loads(p.read_text())
        tag = " [SYNTHETIC FIXTURE]" if v.get("synthetic") else ""
        typer.echo(f"{v['dataset_version_id']}{tag}  examples={v['summary']['examples']}  created={v['created_at']}")


@data_app.command("validate")
def data_validate(dataset_version: str = typer.Option(..., "--dataset-version")) -> None:
    """Print the validation and reconciliation reports of a dataset version."""
    dv = _dataset(dataset_version)
    val = dv.report("validation") or {}
    for c in val.get("checks", []):
        typer.echo(f"{c['status']:<14} {c['check']:<48} {c['count'] if c['count'] is not None else ''}")
    rec = dv.report("reconciliation") or {}
    for c in rec.get("checks", []):
        typer.echo(f"reconcile {c['status']:<15} {c['check']}")
    typer.echo(f"errors={val.get('error_count')} warnings={val.get('warning_count')} reconciliation_failures={rec.get('failures')}")


@media_app.command("materialize")
def media_materialize(
    dataset_version: str = typer.Option(..., "--dataset-version"),
    recording: str | None = typer.Option(None, help="Only this recording id"),
    limit: int | None = typer.Option(None, help="At most this many files"),
) -> None:
    """Fetch, verify, and store screenshots for a dataset version (resumable)."""
    from agenthorizon.data.materialize import materialize_media, media_coverage

    dv = _dataset(dataset_version)
    out = materialize_media(get_settings(), dv, recording_id=recording, limit=limit)
    typer.echo(json.dumps({"result": out, "coverage": media_coverage(dv)}, indent=2))


@media_app.command("coverage")
def media_cov(dataset_version: str = typer.Option(..., "--dataset-version")) -> None:
    from agenthorizon.data.materialize import media_coverage

    typer.echo(json.dumps(media_coverage(_dataset(dataset_version)), indent=2))


@fixture_app.command("build")
def fixture_build(out: Path = typer.Option(..., help="Output directory for the synthetic fixture")) -> None:
    """Write the synthetic TEST fixture in the released layout (stamped SYNTHETIC; not benchmark content)."""
    from agenthorizon.testing.fixture import build_fixture

    s = build_fixture(out)
    typer.echo(json.dumps({k: v for k, v in s.items() if k != "gold"}, indent=2))


@app.command("score")
def score_cmd(
    dataset_version: str = typer.Option(..., "--dataset-version"),
    manifest: str = typer.Option(..., help="Manifest id (see manifests/ in the dataset version)"),
    results_dir: Path | None = typer.Option(None, help="Authors'-format results directory (<trajectory_id>.json)"),
    submission: Path | None = typer.Option(None, help="Authors' submission-template JSONL"),
    run: str | None = typer.Option(None, help="Run id produced by this system"),
    output: Path | None = typer.Option(None, help="Write the JSON score report here"),
    markdown: Path | None = typer.Option(None, help="Write a Markdown rendering here"),
) -> None:
    """Score predictions against a locked manifest with fixed denominators."""
    from agenthorizon.data.dataset import PrivateStore
    from agenthorizon.scoring.predictions import load_authors_results_dir, load_submission_jsonl
    from agenthorizon.scoring.protocol import score
    from agenthorizon.scoring.report import render_markdown
    from agenthorizon.util.io import atomic_write_json, atomic_write_text

    s = get_settings()
    dv = _dataset(dataset_version)
    m = dv.manifest(manifest)
    sm = PrivateStore(s.private_dir, dv.id).scoring_manifest(m)
    if sum(x is not None for x in (results_dir, submission, run)) != 1:
        raise typer.BadParameter("give exactly one of --results-dir, --submission, --run")
    if results_dir:
        ps = load_authors_results_dir(results_dir, dv.id, dv.example_ids())
    elif submission:
        ps = load_submission_jsonl(submission, dv.id, dv.example_ids())
    else:
        from agenthorizon.runs.store import RunStore

        ps = RunStore(s.runs_dir / run).prediction_set(dv)
    rep = score(sm, ps)
    rep.pop("_per_item_outcome", None)
    if dv.synthetic:
        rep["warning"] = "SYNTHETIC FIXTURE dataset — not a benchmark result"
    if output:
        atomic_write_json(output, rep)
    if markdown:
        atomic_write_text(markdown, render_markdown(rep))
    typer.echo(render_markdown(rep))


def main() -> None:  # pragma: no cover
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
