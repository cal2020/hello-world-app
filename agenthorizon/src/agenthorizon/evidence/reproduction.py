"""REPRODUCTION_REPORT.md: the fidelity report. Every number is read from an evidence file at generation time, so the
report states what the repository can show and nothing more."""

from __future__ import annotations

import json
from collections import Counter

from agenthorizon.config import PROJECT_ROOT, Settings
from agenthorizon.util.io import utcnow_iso

EVIDENCE = PROJECT_ROOT / "evidence"


def _counts(d: dict) -> str:
    return ", ".join(f"{k}: {n}" for k, n in d.items()) or "none"


def _load(name: str) -> dict:
    p = EVIDENCE / name
    return json.loads(p.read_text()) if p.is_file() else {}


def reproduction_report(settings: Settings) -> str:
    from agenthorizon.evidence.traceability import REQUIREMENTS
    from agenthorizon.supplemental.pipeline import supplemental_stores

    lock, avail, reg = _load("SOURCE_LOCK.json"), _load("DATA_AVAILABILITY.json"), _load("EXPERIMENT_REGISTRY.json")
    caps, ref, spec = _load("MODEL_CAPABILITIES.json"), _load("REFERENCE_DATA.json"), _load("PAPER_SPEC.json")
    audit, smoke = _load("DEDUP_AUDIT.json"), _load("STACK_SMOKE.json")

    src_rows = [f"| {s['source_id']} | {s.get('status')} | {(s.get('resolved_revision') or '—')[:12]} |" for s in lock.get("sources", [])]
    art = Counter(a["status"] for a in avail.get("artifacts", []))
    key_art = [a for a in avail.get("artifacts", []) if a["artifact_id"].startswith("ah-")]
    exp = reg.get("experiments", [])
    by_kind: dict[str, Counter] = {}
    blockers: Counter = Counter()
    for e in exp:
        by_kind.setdefault(e["kind"], Counter())[e["status"]["status"]] += 1
        for b in e["status"].get("blockers", []):
            blockers[b.split(":")[0]] += 1
    cap_counts = caps.get("counts", {})
    cap_reasons: Counter = Counter(r for c in caps.get("configurations", []) for r in c.get("reasons", []))
    tables = ref.get("supplementary_tables", [])
    arith = ref.get("construction_arithmetic_checks", [])
    ident = ref.get("revised_check_table_identities", [])
    trace = Counter((r.classification, r.status.split(":")[0].split(";")[0]) for r in REQUIREMENTS)
    supp = []
    for st in supplemental_stores(settings):
        v = st.version()
        cov = st.coverage()
        supp.append(f"| {v.get('source_id')} | {v.get('revision', '')[:12]} | {v.get('records')} | "
                    f"{', '.join(f'{k}: {n}' for k, n in cov.get('by_kind', {}).items())} | "
                    f"{cov.get('records_with_compatible_binary_label')} | {v.get('license')} |")
    harness = (smoke.get("steps", {}).get("capability_probe") or {}).get("harness", {})

    L = [
        "# Reproduction report", "",
        f"Generated {utcnow_iso()} by `agenthorizon evidence reproduction` from the files in `evidence/`.", "",
        "## Verdict", "",
        "The paper core and the application layer are implemented and tested end to end. **Empirical reproduction of "
        "the paper is blocked in the environment that built this repository**:",
        "",
        "- the official dataset, the paper and several model providers were unreachable;",
        "- there were no provider credentials and no budget;",
        "- the paper's revised AH-D/AH/AH-S membership is not in any artifact that could be read.",
        "",
        "No new model result exists here. No number below is a reproduction of a paper number, and no exact "
        "reproduction is claimed for any table.",
        "",
        "## Result classes and comparison scope", "",
        "| Class | Present | Where |", "| --- | --- | --- |",
        f"| Paper-reported aggregates (reference data, never asserted as results) | {len(tables)} supplementary tables, "
        f"{sum(len(t.get('rows', [])) for t in tables)} rows, with source locations | `REFERENCE_DATA.json` |",
        "| Rescored author predictions | none: no per-item predictions are released | — |",
        "| New paper-compatible runs | none: blocked (data, credentials, budget) | `EXPERIMENT_REGISTRY.json` |",
        "| Extension runs | none | — |",
        "| Test-fixture runs (synthetic, labelled) | yes: unit/integration tests, the UI suite and the Compose smoke run | "
        "`TEST_REPORT.md`, `STACK_SMOKE.json` |", "",
        "Comparisons in the application are protocol-matched by default. A paper-reported aggregate is only ever shown "
        "in a separate reference column.", "",
        "## Sources", "", "| Source | Status | Revision |", "| --- | --- | --- |", *src_rows, "",
        "## Data acquired", "",
        f"Official AgentHorizon artifacts (`DATA_AVAILABILITY.json`): {_counts(art)}.", "",
        "| Artifact | Status | Basis |", "| --- | --- | --- |",
        *[f"| {a['name'][:90]} | {a['status']} | {a.get('basis', '')[:90]} |" for a in key_art], "",
        "Supplemental sources (real data, kept out of every AgentHorizon denominator):", "",
        "| Source | Revision | Records | Kinds | Usable binary labels | Licence |", "| --- | --- | ---: | --- | ---: | --- |",
        *(supp or ["| — | — | — | — | — | — |"]), "",
        f"Separation audit (`DEDUP_AUDIT.json`): {audit.get('items', 0)} records compared; "
        f"{len(audit.get('exact_instruction_duplicates', []))} exact-instruction duplicate groups; "
        f"{len(audit.get('possible_duplicates', []))} possible duplicates flagged for review (never merged); "
        f"{len(audit.get('native_id_aliases', []))} native-ID aliases; "
        f"{len(audit.get('supplemental_overlapping_ah_evaluation', []))} supplemental records overlapping AgentHorizon "
        "evaluation (no AgentHorizon dataset was available to compare against).", "",
        "## Split and ID conflicts", "",
        "Resolved (details in `RELEASE_RECONCILIATION.md`):", "",
        "- the legacy 605/768 partition is registered as its own manifests (`legacy-AH`, `legacy-AH-S`) and never "
        "relabelled as the revised partition;",
        "- the protocol scorer and the released scorer disagree on missing and non-Boolean outputs. The canonical "
        "scorer follows the protocol; a separate compatibility scorer reproduces the released script exactly; both are "
        "cross-checked;",
        "- the native category spellings (singular/plural *Misunderstanding*) go through a versioned map (`ah-categories-v1`);",
        "- record `version` 1.0 vs 1.1: both accepted and the observed value recorded;",
        "- screenshot naming and timing: 0-based step IDs vs 1-based files, and pre-action observations, both "
        "preserved and documented;",
        "- the dataset layout vs the prompt layout: an audited staging adapter maps one onto the other;",
        "- AgentRewardBench primary/secondary annotations follow ARB's own helper functions (cross-checked); OSWorld "
        "Windows tasks reuse Ubuntu task IDs and are recorded as aliases.", "",
        "Unresolved (`PAPER_SPEC.json → unresolved`):", "",
        *[f"- **{u['item']}**: {u['detail']}" for u in spec.get("unresolved", [])], "",
        "## Models and harnesses", "",
        f"Registered judge configurations: {len(caps.get('configurations', []))}; capability status: {_counts(cap_counts)}. "
        "Most frequent reasons:", "",
        *[f"- {r} ({n})" for r, n in cap_reasons.most_common(8)], "",
        "Executed live: **none**. The five harness adapters ran end to end inside the real sandbox with replayed "
        "harness outputs; the direct providers ran against local fake endpoints that capture the exact wire payloads.",
        "",
        "Harness CLIs installed and probed by a judge worker in the Compose stack "
        "(`STACK_SMOKE.json → capability_probe`):", "",
        *([f"- {k}: {v.get('version')} (installed: {v.get('installed')}, sandbox: {v.get('isolation')})" for k, v in harness.items()]
          or ["- (no smoke run recorded)"]), "",
        "## Experiments", "",
        f"{len(exp)} experiments are registered with executable definitions (`agenthorizon experiments list`):", "",
        "| Kind | Status counts |", "| --- | --- |",
        *[f"| {k} | {_counts(c)} |" for k, c in sorted(by_kind.items())], "",
        "Most frequent blockers:", "", *[f"- {b} ({n})" for b, n in blockers.most_common(10)], "",
        "## Deterministic checks on the reference data", "",
        f"- Construction accounting arithmetic: {sum(1 for a in arith if a.get('ok'))}/{len(arith)} identities hold.",
        f"- Revised check table identities: {sum(1 for a in ident if a.get('ok'))}/{len(ident)} hold "
        "(the table itself is the master prompt's quotation of the paper).",
        f"- Aggregate MT definition: {ref.get('analysis_aggregate_mt_definition', {}).get('conclusion', '—')}",
        f"- Legacy composition inference: {ref.get('analysis_legacy_composition', {}).get('status', '—')}.", "",
        "## Requirement coverage", "",
        f"`TRACEABILITY.csv` lists {len(REQUIREMENTS)} requirements, each with resolvable implementation and "
        "verification references. Counts by classification and status:", "",
        *[f"- {c} — {s}: {n}" for (c, s), n in sorted(trace.items())], "",
        "## What would lift each block", "",
        "1. Network access to huggingface.co: pin the dataset revision (`agenthorizon sources lock`), ingest it, "
        "materialize the ~43 GB of advertised media, and run the validation and the legacy reconciliation on real rows.",
        "2. The revised AH-D/AH/AH-S manifests (and, for reconstruction, the 24 splitter verdicts per item) from the "
        "authors. Until then, revised-table reproduction stays blocked and legacy scores stay labelled legacy.",
        "3. The harness instruction file (AGENTS.md / CLAUDE.md / GEMINI.md) used in the paper runs, for paper-mode "
        "agentic runs.",
        "4. Provider credentials per route plus an explicit budget. For the self-hosted rows: GPU serving (vLLM) and "
        "the authors' serving settings, which are unpublished.",
        "5. Provider identifiers for Inkling and Kimi K2.7 Code (revised splitters).",
        "6. Access to arxiv.org, to compare the released prompt with the paper's prompt figure and to read every table "
        "and appendix directly rather than through the master prompt's quotations.", "",
        "## Claims not made", "",
        "No exact reproduction. No legacy score presented as a revised score. No substituted model, altered prompt, "
        "truncated input or leaked answer in any paper-mode path. No invented telemetry: unknown usage stays unknown. "
        "No synthetic data presented as benchmark content.",
    ]
    return "\n".join(L) + "\n"
