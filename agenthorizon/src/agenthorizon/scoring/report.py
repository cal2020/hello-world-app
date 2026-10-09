"""Human-readable rendering of score reports (Markdown), alongside the canonical JSON."""

from __future__ import annotations

from agenthorizon.scoring.categories import DISPLAY, Category


def _cell(f: dict) -> str:
    if f.get("value") is None:
        return "n/a"
    return f"{f['display_pct']}% ({f['numerator']}/{f['denominator']})"


def render_markdown(report: dict, *, title: str = "AgentHorizon score report") -> str:
    m = report["manifest"]
    met = report["metrics"]
    c = report["confusion"]
    lines = [f"# {title}", ""]
    if report.get("warning"):
        lines += [f"> **{report['warning']}**", ""]
    if not m.get("official"):
        lines += [f"> Manifest `{m['id']}` is **not an official benchmark manifest** (partition: {m['partition']}, role: {m['role']}).", ""]
    if m["partition"] == "legacy-submitted":
        lines += ["> LEGACY submitted partition (605/768). Not the revised paper partition.", ""]
    lines += [
        f"- Manifest: `{m['id']}` (digest `{m['digest'][:16]}`), dataset version `{m['dataset_version_id']}`",
        f"- Items: {m['n_items']} (P={m['P']}, N={m['N']}; typed negatives {m['typed_negatives']}, untyped {m['untyped_negatives']})",
        f"- Predictions: `{report['predictions']['id']}`; coverage {report['coverage']['evaluated_with_valid_verdict']}/{report['coverage']['of']}"
        f"{'' if report['coverage']['complete'] else ' — INCOMPLETE: missing items count as errors'}",
        f"- Scorer: `{report['scorer']['id']}`, categories `{report['scorer']['category_map']}`",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Balanced accuracy | {_cell(met['balanced_accuracy']) if met['balanced_accuracy'].get('value') is not None else 'n/a'} |",
        f"| Positive accuracy | {_cell(met['positive_accuracy'])} |",
        f"| Negative accuracy | {_cell(met['negative_accuracy'])} |",
        f"| Raw accuracy (secondary) | {_cell(met['raw_accuracy_secondary'])} |",
        "",
        "## Confusion (valid verdicts) with adjacent invalid/missing counts",
        "",
        "| Gold \\ outcome | valid true | valid false | invalid | missing | total |",
        "|---|---:|---:|---:|---:|---:|",
        f"| positive | {c['TP']} | {c['FN_valid']} | {sum(c['invalid_positive'].values())} | {c['missing_positive']} | {m['P']} |",
        f"| negative | {c['FP_valid']} | {c['TN']} | {sum(c['invalid_negative'].values())} | {c['missing_negative']} | {m['N']} |",
        "",
    ]
    inv = {**{f"positive/{k}": v for k, v in c["invalid_positive"].items()}, **{f"negative/{k}": v for k, v in c["invalid_negative"].items()}}
    if inv:
        lines += ["Invalid verdict breakdown: " + ", ".join(f"{k}={v}" for k, v in sorted(inv.items())), ""]
    lines += ["## Exact failure-type recall", "", "| Category | Recall |", "|---|---|"]
    for cat in Category:
        lines.append(f"| {DISPLAY[cat]} | {_cell(report['mistake_type_recall'][cat.value])} |")
    lines.append(f"| Aggregate (typed negatives, micro) | {_cell(report['mistake_type_recall']['aggregate_typed_micro'])} |")
    lines.append("")
    return "\n".join(lines)
