"""Author-reported aggregates captured as reference data with exact source locations.

These are *reference observations*, never generated results: they live in their own records, carry the
source path, pinned revision, file digest, and line range, and are labelled with their scope (the legacy
submitted partition for S8). Nothing here is synthesized into per-item records.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from agenthorizon.sources.cache import pinned_file, provenance

SUPPLEMENTARY = ("agenthorizon-repo", "docs/supplementary-results.md")
CONSTRUCTION = ("agenthorizon-repo", "docs/benchmark-construction.md")

_FRACTION = re.compile(r"^\s*(?P<pct>[0-9.]+)\s*\((?P<num>\d+)\s*/\s*(?P<den>\d+)\)\s*$")


def parse_cell(raw: str):
    s = raw.strip()
    if s in ("—", "-", "–", ""):
        return None
    m = _FRACTION.match(s)
    if m:
        return {"pct": float(m["pct"]), "numerator": int(m["num"]), "denominator": int(m["den"])}
    t = s.replace(",", "").replace("**", "")
    try:
        return int(t) if re.fullmatch(r"-?\d+", t) else float(t)
    except ValueError:
        return s.replace("**", "")


@dataclass
class MarkdownTable:
    heading: str
    header: list[str]
    rows: list[tuple[int, list[str]]]  # (1-based line number, cells)
    start_line: int
    end_line: int
    preamble: list[str] = field(default_factory=list)


def iter_tables(text: str) -> list[MarkdownTable]:
    lines = text.splitlines()
    tables: list[MarkdownTable] = []
    heading = ""
    para: list[str] = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("#"):
            heading = ln.lstrip("#").strip()
            para = []
        elif ln.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            header = [c.strip() for c in ln.strip().strip("|").split("|")]
            rows = []
            j = i + 2
            while j < len(lines) and lines[j].startswith("|"):
                rows.append((j + 1, [c.strip() for c in lines[j].strip().strip("|").split("|")]))
                j += 1
            tables.append(MarkdownTable(heading, header, rows, i + 1, j, list(para)))
            i = j
            para = []
            continue
        elif ln.strip():
            para.append(ln.strip())
        i += 1
    return tables


_COLUMN_KEYS = {
    "Model": "model",
    "Interface": "interface",
    "Bal. acc.": "balanced_accuracy_pct",
    "Pos.": "positive_accuracy_pct",
    "Neg.": "negative_accuracy_pct",
    "MT": "mistake_type_recall_pct",
    "Input tokens": "mean_input_tokens",
    "Output tokens": "mean_output_tokens",
    "Tools": "mean_tool_calls",
    "Images": "mean_images_viewed",
    "Critical": "critical_mistake_recall",
    "Bad Side Effect": "bad_side_effect_recall",
    "Misunderstanding": "misunderstanding_recall",
}


def _split_model(name: str) -> tuple[str, str | None]:
    m = re.match(r"^(.*?)\s*\((.+)\)\s*$", name)
    return (m.group(1), m.group(2)) if m else (name, None)


def supplementary_tables(path: Path | None = None) -> list[dict]:
    p = path or pinned_file(*SUPPLEMENTARY)
    text = p.read_text(encoding="utf-8")
    tables = iter_tables(text)
    ids = {
        "Full model-interface grid: submitted challenging split": ("S8.T1", "legacy-submitted", "AH (legacy, 605 items)"),
        "Full model-interface grid: submitted simple split": ("S8.T2", "legacy-submitted", "AH-S (legacy, 768 items)"),
        "Full-benchmark mistake-type recall": ("S8.T3", "full-release", "all 1,373 items (850 negatives; 844 typed)"),
    }
    out = []
    for t in tables:
        if t.heading not in ids:
            continue
        table_id, partition, subset = ids[t.heading]
        cols = [_COLUMN_KEYS.get(h, h) for h in t.header]
        rows = []
        for line, cells in t.rows:
            rec = {"line": line}
            for key, raw in zip(cols, cells, strict=True):
                rec[key] = parse_cell(raw) if key not in ("model", "interface") else raw
            model, qualifier = _split_model(rec["model"])
            rec["model"] = model
            if qualifier:
                rec["model_qualifier"] = qualifier
            rows.append(rec)
        out.append({
            "table_id": table_id,
            "title": t.heading,
            "kind": "author_reported_aggregate",
            "scope": {"partition": partition, "subset": subset,
                      "note": "Legacy submitted Qwen-defined partition; retained by the authors as a sensitivity analysis, "
                              "not the revised paper leaderboard." if partition == "legacy-submitted" else
                              "Fixed denominators 273 / 232 / 339 over the full release; missing or malformed outputs count as incorrect."},
            "provenance": provenance(*SUPPLEMENTARY, lines=(t.start_line, t.end_line)),
            "preamble": t.preamble,
            "columns": cols,
            "rows": rows,
        })
    return out


def construction_accounting(path: Path | None = None) -> dict:
    p = path or pinned_file(*CONSTRUCTION)
    text = p.read_text(encoding="utf-8")
    tables = iter_tables(text)
    stage = next(t for t in tables if t.heading == "Stage-by-stage counts")
    effort = next(t for t in tables if t.heading == "Contributor effort")
    stages = [
        {"line": ln, "stage": c[0], "positive": parse_cell(c[1]), "negative": parse_cell(c[2]), "total": parse_cell(c[3])}
        for ln, c in stage.rows
    ]
    effort_rows = [
        {"line": ln, "stage": c[0].replace("**", ""), "avg_hours_per_demonstration": parse_cell(c[1].replace(" h", "")),
         "total_hours": parse_cell(c[2])}
        for ln, c in effort.rows
    ]

    def find(pattern: str) -> list[str]:
        return re.findall(pattern, text)

    return {
        "kind": "author_reported_accounting",
        "provenance": provenance(*CONSTRUCTION),
        "stages": stages,
        "positive_review": {
            "direct_agreement": int(find(r"agree directly on (\d+) of")[0]),
            "arbitrated": int(find(r"remaining (\d+) cases are arbitrated")[0]),
            "retained_after_arbitration": int(find(r"Arbitration retains (\d+) cases")[0]),
            "excluded": int(find(r"remaining (\d+) material or unresolved")[0]),
        },
        "negative_review": {"typed": 844, "untyped_legacy": 6, "hours": 212.5},
        "qa": {
            "items_requiring_correction": int(find(r"identified (\d+) items requiring")[0]),
            "dropped_without_replacement": "Twenty-seven",
            "complete_pairs": 425,
            "kappa_all_850": float(find(r"kappa is ([0-9.]+) over all 850")[0]),
            "kappa_typed_844": float(find(r"and ([0-9.]+) over the 844")[0]),
            "residual_model_qa": {"sampled": 156, "flagged_first_pass": 82, "confirmed": 18,
                                  "estimate": "11.5% (Wilson 95%: 7.4%-17.5%)", "is_human_validated": False},
            "inter_annotator_agreement": "not collected (three-reviewer diagnostic on 23/425 pairs used for calibration only)",
        },
        "effort": effort_rows,
    }


def check_construction_arithmetic(acc: dict) -> list[dict]:
    """Recompute the documented identities; each check reports pass/fail rather than asserting."""
    pr = acc["positive_review"]
    stages = {s["stage"]: s for s in acc["stages"]}
    released = stages.get("Released benchmark", {})
    checks = [
        ("agree + arbitrated = candidates", pr["direct_agreement"] + pr["arbitrated"], 850),
        ("agree + retained = released positives", pr["direct_agreement"] + pr["retained_after_arbitration"], released.get("positive")),
        ("retained + excluded = arbitrated", pr["retained_after_arbitration"] + pr["excluded"], pr["arbitrated"]),
        ("typed + untyped negatives = 850", acc["negative_review"]["typed"] + acc["negative_review"]["untyped_legacy"], released.get("negative")),
        ("released total", (released.get("positive") or 0) + (released.get("negative") or 0), released.get("total")),
    ]
    return [{"check": n, "computed": a, "documented": b, "ok": a == b} for n, a, b in checks]
