"""``agenthorizon`` command-line interface. Every command maps onto the same library used by the API."""

from __future__ import annotations

import json
import os
from pathlib import Path

import typer

from agenthorizon.config import PROJECT_ROOT, get_settings

app = typer.Typer(no_args_is_help=True, add_completion=False, help="AgentHorizon research core and workbench")
sources_app = typer.Typer(no_args_is_help=True, help="Source discovery, pinning, and locking")
app.add_typer(sources_app, name="sources")

EVIDENCE_DIR = PROJECT_ROOT / "evidence"
REPORT_HELP = "Report path (default: evidence/<name> in a writable checkout, else <var>/reports/<name>)"


def _report_path(output: Path | None, name: str) -> Path:
    """evidence/ in a development checkout; <var>/reports where evidence/ is read-only (container images). The API
    prefers <var>/reports, so a report regenerated in a deployment replaces the committed copy there."""
    if output is not None:
        return output
    if os.access(EVIDENCE_DIR, os.W_OK):
        return EVIDENCE_DIR / name
    d = get_settings().reports_dir
    d.mkdir(parents=True, exist_ok=True)
    return d / name


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
def evidence_reference(output: Path | None = typer.Option(None, help=REPORT_HELP)) -> None:
    """Capture author-reported aggregates with provenance, plus consistency analyses over them."""
    output = _report_path(output, "REFERENCE_DATA.json")
    from agenthorizon.reference.analysis import (
        REVISED_CHECK_TABLE,
        check_table_identities,
        legacy_composition_inference,
        mt_definition_analysis,
    )
    from agenthorizon.reference.tables import (
        check_construction_arithmetic,
        construction_accounting,
        supplementary_tables,
    )
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
def evidence_availability(output: Path | None = typer.Option(None, help=REPORT_HELP)) -> None:
    """Classify every referenced artifact as acquired / published-but-unavailable / not-located / not-applicable."""
    output = _report_path(output, "DATA_AVAILABILITY.json")
    from agenthorizon.sources.availability import availability_report
    from agenthorizon.sources.cache import load_lock
    from agenthorizon.util.io import atomic_write_json

    rep = availability_report(load_lock(), get_settings().var_dir)
    atomic_write_json(output, rep)
    typer.echo(f"wrote {output}: {rep['counts']}")


@evidence_app.command("inventory")
def evidence_inventory(output: Path | None = typer.Option(None, help=REPORT_HELP)) -> None:
    """Models, judge configurations, and every experiment row evidenced by accessible tables."""
    output = _report_path(output, "EXPERIMENT_INVENTORY.json")
    from agenthorizon.reference.inventory import inventory
    from agenthorizon.reference.tables import supplementary_tables
    from agenthorizon.util.io import atomic_write_json

    inv = inventory(supplementary_tables())
    atomic_write_json(output, inv)
    unmatched = [e for e in inv["experiments_from_reference_tables"] if not e["config_id"]]
    typer.echo(f"wrote {output}: {len(inv['configurations'])} configs, "
               f"{len(inv['experiments_from_reference_tables'])} table-row experiments ({len(unmatched)} unmatched)")


@evidence_app.command("spec")
def evidence_spec(output: Path | None = typer.Option(None, help=REPORT_HELP)) -> None:
    """The executable paper specification, assembled from the constants the code runs with."""
    output = _report_path(output, "PAPER_SPEC.json")
    from agenthorizon.evidence.spec import paper_spec
    from agenthorizon.util.io import atomic_write_json

    spec = paper_spec()
    atomic_write_json(output, spec)
    typer.echo(f"wrote {output}: {len(spec['judge_configurations'])} configurations, {len(spec['unresolved'])} unresolved items")


@evidence_app.command("traceability")
def evidence_traceability(output: Path | None = typer.Option(None, help=REPORT_HELP)) -> None:
    """Requirement -> source, implementation, verification, status; fails if any reference does not resolve."""
    output = _report_path(output, "TRACEABILITY.csv")
    from agenthorizon.evidence.traceability import REQUIREMENTS, check, render_csv

    output.write_text(render_csv())
    problems = check()
    for p in problems:
        typer.echo(f"unresolved reference: {p}", err=True)
    typer.echo(f"wrote {output}: {len(REQUIREMENTS)} requirements, {len(problems)} unresolved references")
    if problems:
        raise typer.Exit(1)


@evidence_app.command("tests")
def evidence_tests(
    pytest_junit: Path = typer.Option(..., "--pytest-junit", help="JUnit XML of the host pytest run"),
    image_junit: Path | None = typer.Option(None, "--image-junit", help="JUnit XML of the suite run inside the test image"),
    playwright_junit: Path | None = typer.Option(None, "--playwright-junit", help="Playwright JUnit XML"),
    output: Path | None = typer.Option(None, help=REPORT_HELP),
) -> None:
    """TEST_REPORT.md from recorded results: suites, MP §13 check coverage, skips, failures, smoke run, performance."""
    import platform
    import subprocess

    from agenthorizon.app.pgcluster import pg_bindir
    from agenthorizon.evidence.testreport import read_junit, render

    output = _report_path(output, "TEST_REPORT.md")
    b = pg_bindir()
    pg = subprocess.run([str(b / "postgres"), "--version"], capture_output=True, text=True, check=False).stdout.strip() if b else "?"
    suites = {"host pytest": (f"{platform.system()} {platform.release()}, Python {platform.python_version()}, {pg}",
                              read_junit(pytest_junit))}
    if image_junit:
        suites["pytest in the test image"] = ("agenthorizon-test image (Ubuntu 24.04, Python 3.12, PostgreSQL 16) as uid "
                                              "10001 with the judge worker's restrictions: cap_drop ALL, judge seccomp "
                                              "profile, systempaths=unconfined, no-new-privileges", read_junit(image_junit))
    if playwright_junit:
        suites["Playwright (UI)"] = ("Chromium, desktop 1440x900 and Pixel 7 projects, against the e2e server "
                                     "(synthetic fixture, fake endpoint, real supplemental imports)", read_junit(playwright_junit))

    def _load(name: str) -> dict | None:
        p = EVIDENCE_DIR / name
        return json.loads(p.read_text()) if p.is_file() else None

    timing = {k: v for k in ("desktop", "mobile") if (v := _load(f"timing-{k}.json"))}
    output.write_text(render(suites, _load("STACK_SMOKE.json"), _load("PERFORMANCE.json"), timing))
    typer.echo(f"wrote {output}")


@evidence_app.command("reproduction")
def evidence_reproduction(output: Path | None = typer.Option(None, help=REPORT_HELP)) -> None:
    """REPRODUCTION_REPORT.md: verdict, comparison scope, data, conflicts, models, experiments, blocks to lift."""
    output = _report_path(output, "REPRODUCTION_REPORT.md")
    from agenthorizon.evidence.reproduction import reproduction_report

    output.write_text(reproduction_report(get_settings()))
    typer.echo(f"wrote {output}")


@evidence_app.command("validation")
def evidence_validation(output: Path | None = typer.Option(None, help=REPORT_HELP)) -> None:
    """Validation outcomes: the official release (pending access), the synthetic fixture, supplemental imports."""
    output = _report_path(output, "DATA_VALIDATION.json")
    from agenthorizon.evidence.validation import data_validation_report
    from agenthorizon.util.io import atomic_write_json

    rep = data_validation_report(get_settings())
    atomic_write_json(output, rep)
    fx = rep["synthetic_fixture"]["validation"]
    typer.echo(f"wrote {output}: official release {rep['official_release']['status']}; fixture errors={fx['error_count']} "
               f"warnings={fx['warning_count']}; supplemental stores={len(rep['supplemental_sources'])}")


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
    benchmark: str = typer.Option("agenthorizon", help="Benchmark name (supplemental exports: agentrewardbench, osworld)"),
) -> None:
    """Discover, pin, download, validate, normalize, index, and reconcile a release."""
    from agenthorizon.data.ingest import IngestOptions, ingest
    from agenthorizon.sources.hf import HFError

    opts = IngestOptions(source="local" if source == "local" else "hf", revision=revision, local_dir=local_dir, media=media,
                         benchmark=benchmark)
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


def _run_scoring(s, dv, manifest_id: str, ps, selection: list[str] | None):
    from agenthorizon.data.dataset import PrivateStore
    from agenthorizon.scoring.protocol import score, score_with_selection

    sm = PrivateStore(s.private_dir, dv.id).scoring_manifest(dv.manifest(manifest_id))
    if selection is not None and set(selection) != {i.example_id for i in sm.items}:
        both = score_with_selection(sm, ps, set(selection) & {i.example_id for i in sm.items})
        rep = both["canonical_full_manifest"]
        rep["selection_subset"] = {k: v for k, v in both["selection_subset"].items() if k != "_per_item_outcome"}
    else:
        rep = score(sm, ps)
    if dv.synthetic:
        rep["warning"] = "SYNTHETIC FIXTURE dataset — not a benchmark result"
    return rep


@app.command("score")
def score_cmd(
    dataset_version: str | None = typer.Option(None, "--dataset-version", help="Required unless --run is given"),
    manifest: str | None = typer.Option(None, help="Manifest id; defaults to the run's scoring manifest"),
    results_dir: Path | None = typer.Option(None, help="Authors'-format results directory (<trajectory_id>.json)"),
    submission: Path | None = typer.Option(None, help="Authors' submission-template JSONL"),
    run: str | None = typer.Option(None, help="Run id produced by this system"),
    output: Path | None = typer.Option(None, help="Write the JSON score report here"),
    markdown: Path | None = typer.Option(None, help="Write a Markdown rendering here"),
) -> None:
    """Score predictions against a locked manifest with fixed denominators (missing items count as errors)."""
    from agenthorizon.scoring.predictions import load_authors_results_dir, load_submission_jsonl
    from agenthorizon.scoring.report import render_markdown
    from agenthorizon.util.io import atomic_write_json, atomic_write_text

    s = get_settings()
    if sum(x is not None for x in (results_dir, submission, run)) != 1:
        raise typer.BadParameter("give exactly one of --results-dir, --submission, --run")
    selection = None
    if run:
        from agenthorizon.runs.store import FileRunStore

        store = FileRunStore(s.runs_dir / run)
        if not store.exists():
            raise typer.BadParameter(f"no run {run}")
        d = store.definition()
        if dataset_version and dataset_version != d.dataset_version_id:
            raise typer.BadParameter(f"run {run} is on {d.dataset_version_id}, not {dataset_version}")
        dataset_version = d.dataset_version_id
        manifest = manifest or d.scoring_manifest_id or d.selection.get("manifest_id")
        selection = d.example_ids
    if not dataset_version or not manifest:
        raise typer.BadParameter("--dataset-version and --manifest are required")
    dv = _dataset(dataset_version)
    if results_dir:
        ps = load_authors_results_dir(results_dir, dv.id, dv.example_ids())
    elif submission:
        ps = load_submission_jsonl(submission, dv.id, dv.example_ids())
    else:
        ps = store.prediction_set(dv.example_ids())
    rep = _run_scoring(s, dv, manifest, ps, selection)
    rep.pop("_per_item_outcome", None)
    if run:
        rep["run_id"] = run
        rep["result_kind"] = d.classification.get("result_kind")
    if output:
        atomic_write_json(output, rep)
    if markdown:
        atomic_write_text(markdown, render_markdown(rep))
    typer.echo(render_markdown(rep))


# ---- judges -------------------------------------------------------------------------------------------
judges_app = typer.Typer(no_args_is_help=True, help="Judge configuration registry and capability diagnostics")
app.add_typer(judges_app, name="judges")


@judges_app.command("list")
def judges_list() -> None:
    """Every registered paper configuration with its evidence class and identifier status."""
    from agenthorizon.judging.registry import CONFIGS

    for c in CONFIGS:
        typer.echo(f"{c.config_id:<52} {c.evidence_class:<17} route={c.route or '?':<21} id={c.provider_model_id or 'UNKNOWN'}")


@judges_app.command("doctor")
def judges_doctor(
    output: Path | None = typer.Option(None, help=REPORT_HELP),
    live: bool = typer.Option(False, "--live", help="Send one tiny multimodal probe per runnable direct config (costs tokens)"),
    network: bool = typer.Option(True, "--network/--no-network", help="Probe route reachability (no credentials sent)"),
) -> None:
    """Report installation, credentials (names only), identifiers, routes, egress, isolation, multimodality."""
    from agenthorizon.judging.doctor import doctor
    from agenthorizon.util.io import atomic_write_json

    rep = doctor(probe_network=network, live=live)
    output = _report_path(output, "MODEL_CAPABILITIES.json")
    atomic_write_json(output, rep)
    for r in rep["configurations"]:
        typer.echo(f"{r['status']:<12} {r['config_id']:<52} {'; '.join(r['reasons'])[:150]}")
    typer.echo(f"{rep['counts']}  wrote {output}")


# ---- runs ---------------------------------------------------------------------------------------------
runs_app = typer.Typer(no_args_is_help=True, help="Inspect and control runs")
app.add_typer(runs_app, name="runs")


def _price_override(price_input: float | None, price_output: float | None, price_source: str | None) -> dict | None:
    if price_input is None and price_output is None:
        return None
    if price_input is None or price_output is None or not price_source:
        raise typer.BadParameter("--price-input, --price-output and --price-source must be given together")
    return {"input_per_mtok": price_input, "output_per_mtok": price_output, "source": price_source}


@app.command("run")
def run_cmd(
    config: Path | None = typer.Option(None, "--config", help="Run configuration JSON (schema ah-run-config/1)"),
    dataset_version: str | None = typer.Option(None, "--dataset-version"),
    judge: str | None = typer.Option(None, "--judge", help="Registered configuration id (see `judges list`)"),
    manifest: str | None = typer.Option(None, "--manifest"),
    smoke: int | None = typer.Option(None, "--smoke", help="Deterministic engineering-smoke subset of N items"),
    model_id: str | None = typer.Option(None, "--model-id", help="Verified provider model id (operator input)"),
    route: str | None = typer.Option(None, "--route"),
    base_url: str | None = typer.Option(None, "--base-url", help="Self-hosted endpoint (vLLM)"),
    instructions: str | None = typer.Option(None, "--instructions",
                                            help="rubric-extension | none | path to the official AGENTS.md"),
    trial: int = typer.Option(1, "--trial", help="Repeated-trial index (a separate run identity)"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Resolve, check, and forecast only; nothing is executed"),
    budget_usd: float | None = typer.Option(None, "--budget-usd", help="Explicit paid-run budget (required for live runs)"),
    concurrency: int = typer.Option(2, "--concurrency"),
    max_tasks: int | None = typer.Option(None, "--max-tasks", help="Pilot: start at most N unfinished tasks"),
    price_input: float | None = typer.Option(None, "--price-input", help="USD per million input tokens (operator)"),
    price_output: float | None = typer.Option(None, "--price-output", help="USD per million output tokens (operator)"),
    price_source: str | None = typer.Option(None, "--price-source", help="Where the operator price comes from"),
) -> None:
    """Plan (always) and execute (unless --dry-run) a judge run with a canonical identity."""
    from agenthorizon.runs.plan import RunConfig

    s = get_settings()
    if config:
        cfg = RunConfig.load(config)
    else:
        if not (dataset_version and judge):
            raise typer.BadParameter("give --config, or --dataset-version and --judge")
        cfg = RunConfig(dataset_version=dataset_version, judge_config=judge, manifest=manifest, smoke_n=smoke)
    for k, v in (("provider_model_id", model_id), ("route", route), ("base_url", base_url), ("instructions", instructions)):
        if v is not None:
            setattr(cfg, k, v)
    if trial != 1:
        cfg.trial = trial
    override = _price_override(price_input, price_output, price_source)
    _plan_and_execute(s, cfg, dry_run=dry_run, budget_usd=budget_usd, concurrency=concurrency, max_tasks=max_tasks,
                      override=override)


def _plan_and_execute(s, cfg, *, dry_run: bool, budget_usd: float | None, concurrency: int, max_tasks: int | None,
                      override: dict | None) -> dict | None:
    """Always plan; execute only when the plan is ready (credentials, binaries, media, explicit budget)."""
    from agenthorizon.data.media import LocalMediaStore
    from agenthorizon.runs.judges import build_judge, estimate_items, load_secrets, required_secret_names
    from agenthorizon.runs.orchestrator import Orchestrator, RunControls
    from agenthorizon.runs.plan import preflight, resolve, write_plan
    from agenthorizon.runs.policy import POLICIES
    from agenthorizon.runs.pricing import price_for, route_cost_basis
    from agenthorizon.runs.store import FileRunStore

    definition, info = resolve(s, cfg)
    plan = preflight(s, definition, info["dataset_version"], info["problems"], budget_usd=budget_usd, price_override=override)
    path = write_plan(s, plan)
    typer.echo(json.dumps({k: plan[k] for k in ("run_id", "n_tasks", "classification", "blocked", "problems",
                                                "ready_for_live_run")}, indent=2))
    f = plan["forecast"]
    typer.echo(f"forecast: {f['basis']}; total ${f['total_cost_usd']} over {f['n_items']} items "
               f"({f['items_with_cost']} priced)  plan: {path}")
    if dry_run:
        return None
    if not plan["ready_for_live_run"]:
        typer.echo("NOT EXECUTED: resolve the blocks above (no live results were produced).", err=True)
        raise typer.Exit(3)
    dv = info["dataset_version"]
    j = definition.judge
    secrets, _ = load_secrets(required_secret_names(j["interface"], j["route"]))
    price = price_for(j["route"], j["provider_model_id"], override)
    metered = route_cost_basis(j["route"], price).get("metered", True)
    est = estimate_items(definition, dv, override)
    store, created = FileRunStore.create_or_open(s.runs_dir, definition, {"budget_usd": budget_usd, "concurrency": concurrency})
    typer.echo(f"{'created' if created else 'resuming'} {store.run_id}")
    orch = Orchestrator(store, build_judge(definition, dv, LocalMediaStore(s.media_dir), secrets),
                        POLICIES[definition.attempt_policy["policy_id"]],
                        controls=RunControls(concurrency=concurrency, budget_usd=budget_usd, metered=metered,
                                             max_new_tasks=max_tasks),
                        item_cost={i["example_id"]: i["cost_usd"] for i in est["items"]}, price=price)
    summary = orch.run()
    typer.echo(json.dumps(summary, indent=2))
    return summary


@runs_app.command("list")
def runs_list() -> None:
    from agenthorizon.runs.store import list_runs

    for r in list_runs(get_settings().runs_dir):
        typer.echo(f"{r['run_id']}  {r['status']:<10} {r['judge']:<48} n={r['n_tasks']:<5} {r['result_kind']}  {r['created_at']}")


@runs_app.command("show")
def runs_show(run_id: str) -> None:
    from agenthorizon.runs.orchestrator import run_summary
    from agenthorizon.runs.store import FileRunStore

    typer.echo(json.dumps(run_summary(FileRunStore(get_settings().runs_dir / run_id)), indent=2))


@runs_app.command("events")
def runs_events(run_id: str, after: int = typer.Option(0, "--after")) -> None:
    from agenthorizon.runs.store import FileRunStore

    for e in FileRunStore(get_settings().runs_dir / run_id).events(after=after):
        typer.echo(json.dumps(e))


@runs_app.command("cancel")
def runs_cancel(run_id: str, reason: str | None = typer.Option(None)) -> None:
    """Stop dispatching and cancel running attempts (history is kept; resume continues the same run)."""
    from agenthorizon.runs.store import FileRunStore

    FileRunStore(get_settings().runs_dir / run_id).request("cancel", by="cli", reason=reason)
    typer.echo("cancel requested")


@runs_app.command("pause")
def runs_pause(run_id: str, reason: str | None = typer.Option(None)) -> None:
    """Stop dispatching; running attempts finish normally."""
    from agenthorizon.runs.store import FileRunStore

    FileRunStore(get_settings().runs_dir / run_id).request("pause", by="cli", reason=reason)
    typer.echo("pause requested")


@runs_app.command("retry-errors")
def runs_retry_errors(run_id: str, reason: str = typer.Option(..., help="Why (recorded in the audit log)")) -> None:
    """Re-open tasks that ended WITHOUT a response after execution errors (one audited pass, as the reference resume)."""
    from agenthorizon.runs.orchestrator import retry_errors
    from agenthorizon.runs.policy import POLICIES
    from agenthorizon.runs.store import FileRunStore

    store = FileRunStore(get_settings().runs_dir / run_id)
    ids = retry_errors(store, POLICIES[store.definition().attempt_policy["policy_id"]], by="cli", reason=reason)
    typer.echo(f"re-opened {len(ids)} tasks; run `agenthorizon run` with the same configuration to execute them")


@app.command("export")
def export_cmd(
    run: str = typer.Option(..., "--run"),
    output: Path = typer.Option(..., "--output", help="Bundle path (.tar.gz)"),
    manifest: str | None = typer.Option(None, help="Include a score report against this manifest (label-derived)"),
    with_score: bool = typer.Option(False, "--with-score", help="Score against the run's scoring manifest"),
    include_artifacts: bool = typer.Option(False, "--include-artifacts", help="Add redacted stdout/stderr/transcripts"),
) -> None:
    """Write a deterministic, credential-free research bundle for a run."""
    from agenthorizon.runs.export import build_bundle, write_tar_gz
    from agenthorizon.runs.store import FileRunStore
    from agenthorizon.scoring.report import render_markdown

    s = get_settings()
    store = FileRunStore(s.runs_dir / run)
    d = store.definition()
    rep = md = None
    mid = manifest or ((d.scoring_manifest_id or d.selection.get("manifest_id")) if with_score else None)
    if mid:
        dv = _dataset(d.dataset_version_id)
        rep = _run_scoring(s, dv, mid, store.prediction_set(dv.example_ids()), d.example_ids)
        md = render_markdown(rep)
    files, man = build_bundle(s, run, score_report=rep, score_markdown=md, include_artifacts=include_artifacts)
    digest = write_tar_gz(files, output)
    typer.echo(json.dumps({"output": str(output), "sha256": digest, "files": len(man["files"]),
                           "redactions_applied": man["redactions_applied"]}, indent=2))


# ---- experiments ------------------------------------------------------------------------------------------------
experiments_app = typer.Typer(no_args_is_help=True, help="Registered paper experiments: status, plans, runs, reports")
app.add_typer(experiments_app, name="experiments")


def _experiment_status_context(dataset_version: str | None):
    avail = {a["artifact_id"]: a["status"] for a in json.loads((EVIDENCE_DIR / "DATA_AVAILABILITY.json").read_text())["artifacts"]}
    capp = EVIDENCE_DIR / "MODEL_CAPABILITIES.json"
    caps = {c["config_id"]: c for c in json.loads(capp.read_text())["configurations"]} if capp.is_file() else {}
    ctx = {}
    if dataset_version:
        dv = _dataset(dataset_version)
        ctx = {"dataset_manifests": {m.manifest_id for m in dv.manifests()}, "dataset_version_id": dv.id,
               "dataset_synthetic": dv.synthetic}
    return avail, caps, ctx


@experiments_app.command("list")
def experiments_list(dataset_version: str | None = typer.Option(None, "--dataset-version")) -> None:
    """Every registered experiment with its runnable/blocked status and first blockers."""
    from agenthorizon.experiments.registry import experiments, status

    avail, caps, ctx = _experiment_status_context(dataset_version)
    for e in experiments():
        st = status(e, avail, caps, **ctx)
        typer.echo(f"{st.status:<9} {e.experiment_id:<56} {'; '.join(st.blockers[:2])[:140]}")


@experiments_app.command("show")
def experiments_show(experiment_id: str, dataset_version: str | None = typer.Option(None, "--dataset-version")) -> None:
    from agenthorizon.experiments.registry import get, status

    e = get(experiment_id)
    avail, caps, ctx = _experiment_status_context(dataset_version)
    typer.echo(json.dumps({"experiment": e.to_dict(), "status": status(e, avail, caps, **ctx).to_dict()}, indent=2))


def _experiment_configs(experiment_id, dataset_version, model_id, route, base_url, instructions):
    from agenthorizon.experiments.registry import get, run_configs

    e = get(experiment_id)
    dv = _dataset(dataset_version)
    op = {k: v for k, v in (("provider_model_id", model_id), ("route", route), ("base_url", base_url),
                            ("instructions", instructions)) if v is not None}
    try:
        return e, run_configs(e, dv.id, {m.manifest_id for m in dv.manifests()}, operator=op)
    except ValueError as exc:
        raise typer.BadParameter(str(exc)) from exc


@experiments_app.command("plan")
def experiments_plan(experiment_id: str, dataset_version: str = typer.Option(..., "--dataset-version"),
                     model_id: str | None = typer.Option(None, "--model-id"), route: str | None = typer.Option(None, "--route"),
                     base_url: str | None = typer.Option(None, "--base-url"),
                     instructions: str | None = typer.Option(None, "--instructions"),
                     budget_usd: float | None = typer.Option(None, "--budget-usd")) -> None:
    """Dry-run plan for every trial of an experiment (nothing is executed)."""
    e, cfgs = _experiment_configs(experiment_id, dataset_version, model_id, route, base_url, instructions)
    for cfg in cfgs:
        _plan_and_execute(get_settings(), cfg, dry_run=True, budget_usd=budget_usd, concurrency=1, max_tasks=None, override=None)


@experiments_app.command("run")
def experiments_run(experiment_id: str, dataset_version: str = typer.Option(..., "--dataset-version"),
                    budget_usd: float | None = typer.Option(None, "--budget-usd", help="Explicit budget per trial"),
                    concurrency: int = typer.Option(2, "--concurrency"),
                    model_id: str | None = typer.Option(None, "--model-id"), route: str | None = typer.Option(None, "--route"),
                    base_url: str | None = typer.Option(None, "--base-url"),
                    instructions: str | None = typer.Option(None, "--instructions")) -> None:
    """Execute every trial of an experiment (each a separate run identity), refusing anything not ready."""
    e, cfgs = _experiment_configs(experiment_id, dataset_version, model_id, route, base_url, instructions)
    for cfg in cfgs:
        _plan_and_execute(get_settings(), cfg, dry_run=False, budget_usd=budget_usd, concurrency=concurrency,
                          max_tasks=None, override=None)


@experiments_app.command("report")
def experiments_report(experiment_id: str, runs: str = typer.Option(..., "--runs", help="Comma-separated run ids (one per trial)"),
                       output: Path | None = typer.Option(None, "--output", help="JSON report path"),
                       markdown: Path | None = typer.Option(None, "--markdown")) -> None:
    """Scores per report manifest, slices, resources, caveated paper comparison, partition reconstruction."""
    from agenthorizon.experiments.registry import get
    from agenthorizon.experiments.report import experiment_report, render_markdown
    from agenthorizon.runs.store import FileRunStore
    from agenthorizon.util.io import atomic_write_json, atomic_write_text

    s = get_settings()
    stores = [FileRunStore(s.runs_dir / r) for r in runs.split(",") if r]
    rep = experiment_report(s, get(experiment_id), stores)
    if output:
        atomic_write_json(output, rep)
    md = render_markdown(rep)
    if markdown:
        atomic_write_text(markdown, md)
    typer.echo(md)


@evidence_app.command("experiments")
def evidence_experiments(output: Path | None = typer.Option(None, help=REPORT_HELP),
                         dataset_version: str | None = typer.Option(None, "--dataset-version")) -> None:
    """Every registered experiment with its status and blockers in this environment."""
    output = _report_path(output, "EXPERIMENT_REGISTRY.json")
    from agenthorizon.experiments.registry import experiments, status
    from agenthorizon.util.io import atomic_write_json, utcnow_iso

    avail, caps, ctx = _experiment_status_context(dataset_version)
    rows = [{**e.to_dict(), "status": status(e, avail, caps, **ctx).to_dict()} for e in experiments()]
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]["status"]] = counts.get(r["status"]["status"], 0) + 1
    atomic_write_json(output, {"generated_at": utcnow_iso(), "dataset_version": dataset_version, "counts": counts,
                               "experiments": rows})
    typer.echo(f"{counts}  wrote {output}")


# ---- supplemental sources -----------------------------------------------------------------------------------------
supp_app = typer.Typer(no_args_is_help=True, help="Supplemental sources (AgentRewardBench, OSWorld): import, audit, export")
app.add_typer(supp_app, name="supplemental")


@supp_app.command("import")
def supplemental_import(
    source: str = typer.Argument(..., help="agentrewardbench | osworld"),
    trajectories: Path | None = typer.Option(None, help="ARB: local snapshot of the Hugging Face dataset's cleaned/ directory"),
    traces: Path | None = typer.Option(None, help="OSWorld: root of a harness results directory (offline trace export)"),
    run_label: str = typer.Option("operator-run", help="OSWorld: label for the imported trace collection"),
) -> None:
    """Import a supplemental source into its own store (never into AgentHorizon datasets or denominators)."""
    from agenthorizon.supplemental.pipeline import import_arb, import_osworld

    s = get_settings()
    if source == "agentrewardbench":
        out = import_arb(s, trajectories)
    elif source == "osworld":
        out = import_osworld(s, traces, run_label)
    else:
        raise typer.BadParameter("source must be agentrewardbench or osworld")
    typer.echo(json.dumps(out, indent=2, default=str)[:4000])


@supp_app.command("audit")
def supplemental_audit(output: Path | None = typer.Option(None, help=REPORT_HELP)) -> None:
    """Exact/possible duplicates, aliases, intentional sharing, and AgentHorizon-overlap flags across all sources."""
    output = _report_path(output, "DEDUP_AUDIT.json")
    from agenthorizon.supplemental.pipeline import run_audit

    rep = run_audit(get_settings(), output)
    typer.echo(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in rep.items()
                           if k not in ("method", "limitations")}, indent=2))


@supp_app.command("export")
def supplemental_export(store: Path = typer.Argument(..., help="Supplemental store directory (var/supplemental/<source>@<rev>)"),
                        out: Path = typer.Option(..., "--out"), media_root: Path | None = typer.Option(None, "--media-root"),
                        include_machine_labels: bool = typer.Option(False, "--include-machine-labels")) -> None:
    """Write trajectories in the release layout for `data ingest --source local --benchmark <source>` (a separate dataset)."""
    from agenthorizon.supplemental.pipeline import export_for_judging

    typer.echo(json.dumps(export_for_judging(get_settings(), store, out, media_root=media_root,
                                             include_machine_labels=include_machine_labels), indent=2))


# ---- application: bootstrap, database, users, workers, servers -----------------------------------------------
db_app = typer.Typer(no_args_is_help=True, help="Application database")
app.add_typer(db_app, name="db")
users_app = typer.Typer(no_args_is_help=True, help="Application users and API tokens")
app.add_typer(users_app, name="users")


def _local_cluster():
    from agenthorizon.app.pgcluster import LocalCluster

    s = get_settings()
    return LocalCluster(s.var_dir / "pg", port=s.local_pg_port)


def _uses_local_cluster() -> bool:
    s = get_settings()
    return s.mode == "local" and str(s.var_dir / "pg" / "socket") in s.database_url


@app.command("bootstrap")
def bootstrap(
    operator: str = typer.Option("operator", help="Initial operator user id"),
    no_token: bool = typer.Option(False, "--no-token", help="Do not create a new operator token"),
) -> None:
    """Create var/ directories, start the local PostgreSQL cluster, migrate, and create the first operator token."""
    from sqlalchemy import select

    from agenthorizon.app.api.auth import create_user
    from agenthorizon.app.db import engine, migrate
    from agenthorizon.app.schema import users

    s = get_settings()
    for d in (s.datasets_dir, s.media_dir, s.runs_dir, s.exports_dir, s.private_dir, s.sources_dir):
        d.mkdir(parents=True, exist_ok=True)
    s.private_dir.chmod(0o700)
    if _uses_local_cluster():
        c = _local_cluster().ensure()
        typer.echo(f"postgres: local cluster at {c.data} (socket {c.socket}, port {c.port})")
    head = migrate(s)
    typer.echo(f"migrations: at {head}")
    with engine("owner", s).connect() as conn:
        has_op = conn.execute(select(users.c.user_id).where(users.c.role == "operator")).first() is not None
    if not no_token and (not has_op or operator):
        tok = create_user(engine("owner", s), operator, "operator", label="bootstrap")
        typer.echo(f"operator token for {operator!r} (shown once; store it securely):\n  {tok}")
        typer.echo(f"local login link: http://{s.api_host}:{s.api_port}/#login={tok}")


@db_app.command("migrate")
def db_migrate() -> None:
    from agenthorizon.app.db import migrate

    if _uses_local_cluster():
        _local_cluster().ensure()
    typer.echo(f"at {migrate(get_settings())}")


@db_app.command("stop")
def db_stop() -> None:
    """Stop the project-local PostgreSQL cluster."""
    _local_cluster().stop()
    typer.echo("stopped")


@users_app.command("add")
def users_add(user_id: str, role: str = typer.Option(..., help="viewer | reviewer | researcher | operator")) -> None:
    from agenthorizon.app.api.auth import create_user
    from agenthorizon.app.db import engine

    tok = create_user(engine("owner", get_settings()), user_id, role, label="cli")
    typer.echo(f"token for {user_id} ({role}), shown once:\n  {tok}")


@app.command("worker")
def worker_cmd(queue: str = typer.Option(..., help="judge | trusted"), poll_s: float = typer.Option(1.0),
               lease_s: float = typer.Option(60.0)) -> None:
    """Run a job worker. judge: executes runs as ah_worker (needs provider credentials, no label access);
    trusted: ingest/index/materialize/score/export as ah_scorer (no provider credentials)."""
    import signal
    import threading

    from agenthorizon.app.db import engine
    from agenthorizon.app.worker import WorkerContext, default_worker_id, run_worker

    if queue not in ("judge", "trusted"):
        raise typer.BadParameter("queue must be judge or trusted")
    s = get_settings()
    ctx = WorkerContext(s, engine("worker" if queue == "judge" else "scorer", s), default_worker_id(queue))
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    run_worker(ctx, queue, stop, poll_s=poll_s, lease_s=lease_s, log=typer.echo)


@app.command("api")
def api_cmd(host: str | None = typer.Option(None), port: int | None = typer.Option(None)) -> None:
    """Serve the API (and the built frontend) with uvicorn."""
    import uvicorn

    from agenthorizon.app.api.main import create_app

    s = get_settings()
    if s.mode == "local" and (host or s.api_host) not in ("127.0.0.1", "localhost", "::1"):
        raise typer.BadParameter("local mode binds to loopback only; use AH_MODE=hosted with authentication for remote access")
    uvicorn.run(create_app(s), host=host or s.api_host, port=port or s.api_port, log_level="info")


@app.command("dev")
def dev_cmd(build_frontend: bool = typer.Option(True, "--build-frontend/--no-build-frontend")) -> None:
    """Local single-user mode: database, migrations, API + built frontend, one judge and one trusted worker."""
    import subprocess
    import sys

    from agenthorizon.app.db import migrate

    s = get_settings()
    if _uses_local_cluster():
        _local_cluster().ensure()
    migrate(s)
    fe = PROJECT_ROOT / "frontend"
    if build_frontend and (fe / "package.json").is_file():
        if not (fe / "node_modules").is_dir():
            subprocess.run(["npm", "ci"], cwd=fe, check=True)
        subprocess.run(["npm", "run", "build"], cwd=fe, check=True)
    procs = [subprocess.Popen([sys.executable, "-m", "agenthorizon.cli", "worker", "--queue", q]) for q in ("judge", "trusted")]
    typer.echo(f"workers: {[p.pid for p in procs]}  ->  http://{s.api_host}:{s.api_port}/  (log in with your operator token)")
    try:
        api_cmd(None, None)
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait(timeout=30)


def main() -> None:  # pragma: no cover
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
