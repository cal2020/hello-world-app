"""Resolve a run configuration into a canonical definition plus preflight diagnostics (the dry run).

A run configuration names a locked dataset version, a selection (a manifest, optionally a deterministic smoke
subset of it, or explicit IDs), a registered judge configuration and any operator inputs it needs (a verified model
identifier, an endpoint), the harness instruction file, and optional policy overrides. Nothing here calls a model.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion
from agenthorizon.data.layout import asset_key_for_ref
from agenthorizon.data.materialize import current_assets
from agenthorizon.data.splits import engineering_smoke_selection
from agenthorizon.judging.direct.limits import check, limits_for
from agenthorizon.judging.harnesses import ADAPTERS
from agenthorizon.judging.isolation.sandbox import isolation_available
from agenthorizon.judging.prompts import (
    harness_instructions,
    official_agentic_prompt,
    official_direct_prompt,
    rubric_extension_instructions,
)
from agenthorizon.judging.registry import MODELS_BY_KEY, get_config
from agenthorizon.runs.identity import RunDefinition, classify_result_kind, code_identity, git_state
from agenthorizon.runs.judges import (
    binary_identity,
    estimate_items,
    harness_model_string,
    load_secrets,
    required_secret_names,
)
from agenthorizon.runs.policy import POLICIES, default_policy
from agenthorizon.runs.pricing import price_for, route_cost_basis
from agenthorizon.util.io import atomic_write_json, utcnow_iso

CONFIG_SCHEMA = "ah-run-config/1"
PAPER_PREPROCESSING = {"native-512x332", "mosaic-2x2-1024x664"}  # protocol S5 modes
RELEASED_PREPROCESSING_PREFIXES = ("released-auto@", "released-1126x730")


class PlanError(ValueError):
    pass


@dataclass
class RunConfig:
    dataset_version: str
    judge_config: str
    manifest: str | None = None
    example_ids: list[str] | None = None
    smoke_n: int | None = None  # deterministic engineering-smoke subset of the manifest
    scoring_manifest: str | None = None
    provider_model_id: str | None = None
    route: str | None = None
    base_url: str | None = None
    effort: str | None = None
    instructions: str = "rubric-extension"  # rubric-extension | none | path to the official AGENTS.md
    preprocessing: str | None = None
    staging_mode: str = "paper-paths"
    attempt_policy: str | None = None
    timeout_s: int | None = None
    isolation: str | None = None
    trial: int = 1
    limit_overrides: dict = field(default_factory=dict)
    label: str | None = None
    schema: str = CONFIG_SCHEMA

    @classmethod
    def load(cls, path: Path) -> RunConfig:
        d = json.loads(Path(path).read_text())
        if d.get("schema") != CONFIG_SCHEMA:
            raise PlanError(f"{path}: expected schema {CONFIG_SCHEMA}")
        unknown = set(d) - set(cls.__dataclass_fields__)
        if unknown:
            raise PlanError(f"{path}: unknown keys {sorted(unknown)}")
        return cls(**d)

    def to_dict(self) -> dict:
        return asdict(self)


def _selection(dv: DatasetVersion, cfg: RunConfig) -> dict:
    if cfg.example_ids:
        unknown = sorted(set(cfg.example_ids) - dv.example_ids())
        if unknown:
            raise PlanError(f"{len(unknown)} example ids are not in {dv.id}: {unknown[:3]}")
        if len(set(cfg.example_ids)) != len(cfg.example_ids):
            raise PlanError("duplicate example ids in the selection")
        return {"source": "explicit", "manifest_id": None, "manifest_digest": None, "official": False,
                "example_ids": sorted(cfg.example_ids)}
    if not cfg.manifest:
        raise PlanError("give a manifest or explicit example ids")
    m = dv.manifest(cfg.manifest)
    if cfg.smoke_n:
        sm = engineering_smoke_selection(m.example_ids, cfg.smoke_n, dv.id, seed_note=f"{m.manifest_id}:{cfg.smoke_n}")
        return {"source": "engineering-smoke", "manifest_id": m.manifest_id, "manifest_digest": m.digest,
                "official": False, "smoke_manifest_id": sm.manifest_id, "procedure": sm.lineage,
                "example_ids": sorted(sm.example_ids), "notes": sm.notes}
    return {"source": "manifest", "manifest_id": m.manifest_id, "manifest_digest": m.digest, "official": m.official,
            "partition": m.partition, "role": m.role, "example_ids": sorted(m.example_ids)}


def resolve(settings: Settings, cfg: RunConfig) -> tuple[RunDefinition, dict]:
    dv = DatasetVersion(settings.datasets_dir / cfg.dataset_version)
    c = get_config(cfg.judge_config)
    interface = c.interface
    problems: list[str] = []
    model_id = cfg.provider_model_id or c.provider_model_id
    id_source = "operator" if cfg.provider_model_id else ("registry" if c.provider_model_id else None)
    if cfg.provider_model_id and c.provider_model_id and cfg.provider_model_id != c.provider_model_id:
        problems.append(f"operator model id {cfg.provider_model_id!r} differs from the evidenced {c.provider_model_id!r}: "
                        "this is a different experiment (substitution), not the paper row")
    route = cfg.route or c.route
    if model_id is None:
        problems.append("BLOCKED: no evidenced provider model identifier; supply a verified --model-id")
    if route is None:
        problems.append("BLOCKED: serving route not stated by any accessible source; supply --route")
    if cfg.base_url and "@" in cfg.base_url.split("//", 1)[-1].split("/", 1)[0]:
        raise PlanError("base URL must not embed credentials")
    if route == "vllm" and not cfg.base_url:
        problems.append("BLOCKED: self-hosted route needs --base-url of the serving endpoint")
    if c.role == "splitter" and c.evidence_class == "brief_only" and c.route is None:
        problems.append("BLOCKED: revised splitter configuration is described only in the brief (identifier/route unknown)")

    harness = None
    harness_model = None
    if interface == "direct":
        prompt = official_direct_prompt()
        instr = None
        pre_id = cfg.preprocessing or c.preprocessing or "native-512x332"
        preprocessing = {"preprocessing_id": pre_id,
                         "paper_mode": pre_id in PAPER_PREPROCESSING,
                         "released_code_mode": pre_id.startswith(RELEASED_PREPROCESSING_PREFIXES) or pre_id == "native-512x332"}
        if route == "chatgpt_subscription":
            a = ADAPTERS["codex"]
            harness = {"interface": "codex", "version": a.version(), **binary_identity(a.binary_path())}
    else:
        prompt = official_agentic_prompt()
        if cfg.instructions == "rubric-extension":
            instr = rubric_extension_instructions()
        elif cfg.instructions == "none":
            instr = None
            problems.append("no harness instruction file staged: the official prompt refers to AGENTS.md (extension run)")
        else:
            instr = harness_instructions(Path(cfg.instructions))
            if instr is None:
                raise PlanError(f"instruction file {cfg.instructions} not readable")
        preprocessing = None
        a = ADAPTERS[interface]
        harness = {"interface": interface, "version": a.version(), **binary_identity(a.binary_path())}
        if model_id:
            harness_model, notes = harness_model_string(interface, route, model_id)
            if notes:
                harness["model_string_notes"] = notes
    policy = POLICIES[cfg.attempt_policy] if cfg.attempt_policy else default_policy(interface)
    selection = _selection(dv, cfg)
    if cfg.scoring_manifest:
        dv.manifest(cfg.scoring_manifest)  # must exist
    m = MODELS_BY_KEY[c.model_key]
    judge = {"config_id": c.config_id, "interface": interface, "model_key": c.model_key, "model_display": m.display_name,
             "route": route, "provider_model_id": model_id, "harness_model": harness_model, "id_source": id_source,
             "id_evidence": c.id_evidence if id_source == "registry" else "operator-supplied",
             "effort": cfg.effort or c.effort, "sampling": dict(c.sampling), "sampling_evidence": dict(c.sampling_evidence),
             "base_url": cfg.base_url, "harness": harness, "role": c.role, "paper_rows": list(c.paper_rows)}
    execution = {"timeout_s": cfg.timeout_s or settings.judge_task_timeout_s,
                 "isolation": cfg.isolation or settings.isolation_backend,
                 "egress": "provider route hosts only (CONNECT allowlist)",
                 "limit_overrides": cfg.limit_overrides or None}
    classification = classify_result_kind(
        prompt_paper_mode=prompt.paper_mode, instructions_paper_mode=(instr.paper_mode if instr else (None if interface == "direct" else False)),
        model_id_evidenced=id_source == "registry", preprocessing_paper_mode=(preprocessing or {}).get("paper_mode"),
        staging_mode=cfg.staging_mode, policy_reference=policy.policy_id.startswith("ah-reference-"),
        synthetic_data=dv.synthetic, official_selection=bool(selection.get("official")))
    if execution["isolation"] != "unshare":
        classification["reasons"].append("judge isolation disabled (development backend)")
        if classification["result_kind"] == "new_paper_compatible":
            classification["result_kind"] = "extension"
    definition = RunDefinition(
        dataset_version_id=dv.id, dataset_input_digest=dv.info["input_digest"],
        normalizer_version=dv.info["normalizer_version"], synthetic_data=dv.synthetic, selection=selection,
        scoring_manifest_id=cfg.scoring_manifest or selection.get("manifest_id"),  # a smoke subset scores against its parent
        judge=judge, prompt={"prompt_id": prompt.prompt_id, "sha256": prompt.sha256},
        instructions=({"prompt_id": instr.prompt_id, "sha256": instr.sha256, "paper_mode": instr.paper_mode,
                       "source": instr.source} if instr else None),
        preprocessing=preprocessing, staging_mode=cfg.staging_mode, attempt_policy=policy.to_dict(),
        execution=execution, code=code_identity(), trial=cfg.trial, classification=classification)
    return definition, {"problems": problems, "dataset_version": dv}


def preflight(settings: Settings, definition: RunDefinition, dv: DatasetVersion, problems: list[str], *,
              budget_usd: float | None, price_override: dict | None = None, environ: dict | None = None) -> dict:
    j = definition.judge
    checks: dict[str, dict] = {}
    blocked = [p for p in problems if p.startswith("BLOCKED")]
    names = required_secret_names(j["interface"], j["route"]) if j["route"] else []
    _, missing = load_secrets(names, environ)
    checks["credentials"] = {"ok": not missing, "required": names, "missing": missing}
    if missing:
        blocked.append(f"BLOCKED: missing credential(s) {missing} (set them in the worker environment)")
    if j.get("harness"):
        ok = bool(j["harness"].get("path") and j["harness"].get("version"))
        checks["harness"] = {"ok": ok, **j["harness"]}
        if not ok:
            blocked.append(f"BLOCKED: harness {j['harness']['interface']} not installed")
    iso_ok, iso_detail = isolation_available() if definition.execution["isolation"] == "unshare" else (True, "disabled")
    checks["isolation"] = {"ok": iso_ok, "backend": definition.execution["isolation"], "detail": iso_detail}
    if not iso_ok:
        blocked.append(f"BLOCKED: isolation backend unavailable ({iso_detail})")
    assets = current_assets(dv)
    missing_media: dict[str, int] = {}
    for eid in definition.example_ids:
        rj = dv.released_json(eid) or {}
        n = 0
        for s in rj.get("steps") or []:
            key = asset_key_for_ref(s.get("screenshot"))
            a = assets.get(key) if key else None
            if s.get("screenshot") and (not a or a.get("status") != "materialized"):
                n += 1
        if n:
            missing_media[eid] = n
    checks["media"] = {"ok": not missing_media, "items_with_missing_screenshots": len(missing_media),
                       "missing_screenshots": sum(missing_media.values())}
    if missing_media:
        blocked.append(f"BLOCKED: {len(missing_media)} selected items lack materialized screenshots; "
                       "run `agenthorizon media materialize` first")
    forecast = estimate_items(definition, dv, price_override)
    if j["interface"] == "direct":
        lim = limits_for(j["route"], j["provider_model_id"], definition.execution.get("limit_overrides"))
        bad = []
        for it in forecast["items"]:
            rj = dv.released_json(it["example_id"]) or {}
            n_img = sum(1 for s in rj.get("steps") or [] if s.get("screenshot"))
            if (definition.preprocessing or {}).get("preprocessing_id") == "mosaic-2x2-1024x664":
                n_img = -(-n_img // 4)
            r = check(n_img, 0, it["input_tokens"], lim)
            if not r["fits"]:
                bad.append({"example_id": it["example_id"], "violations": r["violations"]})
        checks["serving_limits"] = {"ok": not bad, "limits": lim.to_dict(), "items_exceeding": len(bad),
                                    "examples": bad[:10],
                                    "unverified": check(0, 0, 0, lim)["unverified"],
                                    "note": "items exceeding a known limit end as serving_incompatible (never truncated)"}
    price = price_for(j["route"], j["provider_model_id"], price_override)
    basis = route_cost_basis(j["route"], price)
    checks["cost"] = {"basis": basis, "forecast_total_usd": forecast["total_cost_usd"]}
    live_ready = not blocked
    if basis.get("metered", True):
        if budget_usd is None:
            live_ready = False
            checks["budget"] = {"ok": False, "detail": "no paid-run budget set: live execution refused (dry run only)"}
        elif not basis.get("price_known"):
            live_ready = False
            checks["budget"] = {"ok": False, "detail": "price unknown: a USD budget cannot be enforced; supply a price"}
        else:
            checks["budget"] = {"ok": True, "limit_usd": budget_usd,
                                "forecast_fits": forecast["total_cost_usd"] is not None and forecast["total_cost_usd"] <= budget_usd}
    else:
        checks["budget"] = {"ok": True, "detail": basis["note"]}
    return {"run_id": definition.run_id, "generated_at": utcnow_iso(), "dataset_version_id": definition.dataset_version_id,
            "synthetic_data": definition.synthetic_data, "n_tasks": len(definition.example_ids),
            "selection": {k: v for k, v in definition.selection.items() if k != "example_ids"},
            "judge": {k: v for k, v in j.items() if k not in ("sampling_evidence",)},
            "classification": definition.classification, "checks": checks, "problems": problems, "blocked": blocked,
            "ready_for_live_run": live_ready, "forecast": {k: v for k, v in forecast.items() if k != "items"},
            "forecast_items_sample": forecast["items"][:5], "git": git_state(),
            "definition_digest": definition.digest}


def write_plan(settings: Settings, plan: dict) -> Path:
    p = settings.runs_dir / "_plans" / f"{plan['run_id']}.json"
    atomic_write_json(p, plan)
    return p
