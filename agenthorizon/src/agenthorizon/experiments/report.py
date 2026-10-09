"""Experiment reports: score each run against every report manifest, slice, summarize resources, compare with
the author-reported rows (caveated), and for splitter experiments reconstruct and compare the partition."""

from __future__ import annotations

from agenthorizon.analysis.bootstrap import grouped_bootstrap, groups_from_private
from agenthorizon.analysis.partition import legacy_reconstruction, verdict_matrix
from agenthorizon.analysis.reference_compare import compare
from agenthorizon.analysis.resources import compare_with_reference, resource_summary
from agenthorizon.analysis.slices import example_meta, slice_scores
from agenthorizon.data.dataset import DatasetVersion, PrivateStore
from agenthorizon.experiments.registry import Experiment, manifest_id_for
from agenthorizon.judging.registry import INTERFACE_LABELS, MODELS_BY_KEY, get_config
from agenthorizon.scoring.protocol import score
from agenthorizon.util.io import utcnow_iso


def _ref_tables() -> dict[str, dict]:
    try:
        from agenthorizon.reference.tables import supplementary_tables
        return {t["table_id"]: t for t in supplementary_tables()}
    except Exception:  # noqa: BLE001
        return {}


def _row(table: dict, line: int | None) -> dict | None:
    return next((r for r in table.get("rows", []) if r.get("line") == line), None) if line else None


def experiment_report(settings, e: Experiment, stores: list, *, bootstrap_B: int = 1000) -> dict:
    if not stores:
        raise ValueError("no runs given for this experiment")
    d0 = stores[0].definition()
    for st in stores:
        d = st.definition()
        if d.dataset_version_id != d0.dataset_version_id or d.judge["config_id"] != e.judge_config:
            raise ValueError(f"{st.run_id} does not belong to {e.experiment_id} on {d0.dataset_version_id}")
    dv = DatasetVersion(settings.datasets_dir / d0.dataset_version_id)
    private = PrivateStore(settings.private_dir, dv.id)
    available = {m.manifest_id for m in dv.manifests()}
    meta = example_meta(dv)
    tables = _ref_tables()
    cfg = get_config(e.judge_config) if e.judge_config else None
    out = {"generated_at": utcnow_iso(), "experiment": e.to_dict(), "dataset_version_id": dv.id, "synthetic": dv.synthetic,
           "judge": {"config_id": e.judge_config, "model": MODELS_BY_KEY[cfg.model_key].display_name if cfg else None,
                     "interface": INTERFACE_LABELS[cfg.interface] if cfg else None},
           "trials": [], "warnings": []}
    if dv.synthetic:
        out["warnings"].append("SYNTHETIC FIXTURE dataset — pipeline exercise only, not a benchmark result")
    for st in stores:
        d = st.definition()
        ps = st.prediction_set(dv.example_ids())
        trial = {"run_id": st.run_id, "trial": d.trial, "result_kind": d.classification.get("result_kind"),
                 "classification_reasons": d.classification.get("reasons", []), "reports": [],
                 "resources": resource_summary(st)}
        for spec in e.reports:
            mid = manifest_id_for(spec.manifest_kind, dv.id, available)
            if mid is None:
                trial["reports"].append({"report_id": spec.report_id, "manifest_kind": spec.manifest_kind,
                                         "status": "unavailable", "reason": "manifest not present in this dataset version"})
                continue
            sm = private.scoring_manifest(dv.manifest(mid))
            rep = score(sm, ps)
            ids = {i.example_id for i in sm.items}
            rep.pop("_per_item_outcome", None)
            entry = {"report_id": spec.report_id, "manifest_kind": spec.manifest_kind, "manifest_id": mid, "score": rep}
            if "slices" in e.analyses:
                entry["slices"] = slice_scores(sm, ps, meta)
            entry["bootstrap_extension"] = grouped_bootstrap(sm, ps, groups_from_private(private, ids), B=bootstrap_B)
            if spec.reference and spec.reference.get("table_id") in tables:
                t = tables[spec.reference["table_id"]]
                row = _row(t, spec.reference.get("line"))
                if row:
                    entry["paper_reference"] = compare(rep, t, row, d.to_dict(), spec.manifest_kind)
                    if spec.report_id == "S8.T1":
                        trial["resources_vs_paper"] = compare_with_reference(trial["resources"], row)
            trial["reports"].append(entry)
        out["trials"].append(trial)
    if e.kind == "splitter_legacy":
        released = {}
        for kind, bucket in (("legacy-AH", "AH"), ("legacy-AH-S", "AH-S")):
            mid = manifest_id_for(kind, dv.id, available)
            if mid:
                released.update({x: bucket for x in dv.manifest(mid).example_ids})
        ids = sorted(dv.example_ids())
        out["legacy_partition_reconstruction"] = legacy_reconstruction(verdict_matrix(stores, ids), private.gold, released,
                                                                       k=e.trials)
        if len(stores) < e.trials:
            out["warnings"].append(f"only {len(stores)} of {e.trials} trials supplied: items are incomplete")
    return out


def render_markdown(r: dict) -> str:
    e = r["experiment"]
    lines = [f"# Experiment report: {e['experiment_id']}", "", e["title"], ""]
    for w in r["warnings"]:
        lines += [f"> **{w}**", ""]
    lines += [f"Dataset version `{r['dataset_version_id']}` · judge `{r['judge']['config_id']}` · generated {r['generated_at']}", ""]
    for t in r["trials"]:
        lines += [f"## Run `{t['run_id']}` (trial {t['trial']}, {t['result_kind']})", ""]
        if t["classification_reasons"]:
            lines += ["Not a paper-compatible run: " + "; ".join(t["classification_reasons"]), ""]
        lines += ["| Report | Manifest | Balanced | Positive (TP/P) | Negative (TN/N) | MT aggregate | Missing | Invalid |",
                  "|---|---|---|---|---|---|---|---|"]
        for rep in t["reports"]:
            if "score" not in rep:
                lines.append(f"| {rep['report_id']} | {rep['manifest_kind']} | — | — | — | — | — | {rep.get('reason', '')} |")
                continue
            s = rep["score"]
            m, c = s["metrics"], s["confusion"]

            def f(x):
                return "—" if x.get("value") is None else f"{100 * x['value']:.1f}%"

            pa, na = m["positive_accuracy"], m["negative_accuracy"]
            lines.append(f"| {rep['report_id']} | `{rep['manifest_id']}` | {f(m['balanced_accuracy'])} | {f(pa)} ({pa.get('numerator')}/{pa.get('denominator')}) | "
                         f"{f(na)} ({na.get('numerator')}/{na.get('denominator')}) | {f(s['mistake_type_recall']['aggregate_typed_micro'])} | "
                         f"{c['missing_positive'] + c['missing_negative']} | {sum(c['invalid_positive'].values()) + sum(c['invalid_negative'].values())} |")
        lines.append("")
        for rep in t["reports"]:
            pr = rep.get("paper_reference")
            if pr:
                lines += [f"### {rep['report_id']} vs paper-reported (line {pr['reference']['line']}) — "
                          f"{'comparable' if pr['comparable'] else 'NOT directly comparable'}", ""]
                lines += [f"- {c}" for c in pr["caveats"]] + [""]
                lines += ["| Metric | This run | Paper-reported |", "|---|---|---|"]
                lines += [f"| {x['metric']} | {x['run'] if x['run'] is not None else '—'} | {x['paper_reported']} |" for x in pr["rows"]] + [""]
    if "legacy_partition_reconstruction" in r:
        lp = r["legacy_partition_reconstruction"]
        lines += ["## Legacy partition reconstruction", "", f"- procedure: {lp['procedure']}", f"- buckets: {lp['by_bucket']}",
                  f"- agreement with released membership: {lp['agreement']}", ""]
    return "\n".join(lines) + "\n"
