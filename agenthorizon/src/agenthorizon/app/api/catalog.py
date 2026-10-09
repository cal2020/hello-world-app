"""Catalogue routes: sources, dataset versions, coverage, example search, trajectory evidence, media, reference."""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy import and_, func, select

from agenthorizon.app.api.auth import Principal, require
from agenthorizon.app.api.common import dec_cursor, enc_cursor, eng, err
from agenthorizon.app.schema import (
    annotations,
    assets,
    dataset_versions,
    examples,
    manifest_members,
    manifests,
    run_finals,
    steps,
)
from agenthorizon.config import PROJECT_ROOT
from agenthorizon.util.io import atomic_write_bytes

router = APIRouter(prefix="/api")
EVIDENCE = PROJECT_ROOT / "evidence"
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
THUMB_WIDTH = 480


def _evidence(name: str) -> dict | None:
    p = EVIDENCE / name
    return json.loads(p.read_text()) if p.is_file() else None


@router.get("/sources")
def sources(p: Principal = Depends(require("catalog.read"))):
    lock = _evidence("SOURCE_LOCK.json") or {}
    avail = _evidence("DATA_AVAILABILITY.json") or {}
    return {
        "lock_generated_at": lock.get("generated_at"),
        "sources": [{k: s.get(k) for k in ("source_id", "citation", "kind", "status", "resolved_revision", "license",
                                           "access_detail", "urls")} for s in lock.get("sources", [])],
        "availability": avail,
    }


@router.get("/datasets")
def list_datasets(request: Request, p: Principal = Depends(require("catalog.read"))):
    with eng(request).connect() as c:
        rows = c.execute(select(dataset_versions).order_by(dataset_versions.c.indexed_at.desc())).mappings().all()
        out = []
        for r in rows:
            n = c.execute(select(func.count()).select_from(examples)
                          .where(examples.c.dataset_version_id == r["dataset_version_id"])).scalar_one()
            out.append({"dataset_version_id": r["dataset_version_id"], "benchmark": r["benchmark"], "synthetic": r["synthetic"],
                        "examples": n, "created_at": r["info"].get("created_at"), "status": r["info"].get("status_at_creation"),
                        "source": r["info"].get("source")})
    return {"datasets": out}


@router.get("/datasets/{dv}")
def dataset_detail(dv: str, request: Request, p: Principal = Depends(require("catalog.read"))):
    with eng(request).connect() as c:
        r = c.execute(select(dataset_versions).where(dataset_versions.c.dataset_version_id == dv)).mappings().first()
        if r is None:
            raise err(404, "not_found", f"dataset version {dv} is not indexed")
        ms = c.execute(select(manifests).where(manifests.c.dataset_version_id == dv).order_by(manifests.c.partition,
                                                                                               manifests.c.name)).mappings().all()
        media = dict(c.execute(select(assets.c.status, func.count()).where(assets.c.dataset_version_id == dv)
                               .group_by(assets.c.status)).all())
        agg = c.execute(select(func.count(), func.sum(examples.c.n_steps), func.max(examples.c.n_steps),
                               func.sum(examples.c.media_total), func.sum(examples.c.media_materialized))
                        .where(examples.c.dataset_version_id == dv)).first()
    avail = {a["artifact_id"]: a for a in (_evidence("DATA_AVAILABILITY.json") or {}).get("artifacts", [])}
    val = r["validation"] or {}
    return {
        "dataset_version_id": dv, "benchmark": r["benchmark"], "synthetic": r["synthetic"], "info": r["info"],
        "counts": {"examples": agg[0], "steps_total": agg[1], "max_steps": agg[2], "screenshots": agg[3] or 0,
                   "screenshots_materialized": agg[4] or 0},
        "media_by_status": media,
        "validation": {"errors": val.get("error_count"), "warnings": val.get("warning_count"), "checks": val.get("checks", [])},
        "reconciliation": r["reconciliation"],
        "manifests": [{k: m[k] for k in ("manifest_id", "name", "partition", "role", "official", "n_items", "digest", "notes")}
                      for m in ms],
        "membership_status": {
            "revised_paper_partition": {"status": (avail.get("ah-revised-manifests") or {}).get("status", "unknown"),
                                        "detail": (avail.get("ah-revised-manifests") or {}).get("detail"),
                                        "note": "AH / AH-S / AH-D (three-splitter revision) — required for exact reproduction"},
            "legacy_partition": {"present": any(m["partition"] == "legacy-submitted" for m in ms),
                                 "note": "single-splitter legacy membership from the released label files; never relabelled as the paper partition"},
        },
    }


@router.get("/datasets/{dv}/facets")
def facets(dv: str, request: Request, p: Principal = Depends(require("catalog.read"))):
    out = {}
    with eng(request).connect() as c:
        for col in ("os", "application", "domain", "length_bin"):
            rows = c.execute(select(getattr(examples.c, col), func.count()).where(examples.c.dataset_version_id == dv)
                             .group_by(getattr(examples.c, col)).order_by(func.count().desc()).limit(60)).all()
            out[col] = [{"value": v, "count": n} for v, n in rows]
        out["steps"] = c.execute(select(func.min(examples.c.n_steps), func.max(examples.c.n_steps))
                                 .where(examples.c.dataset_version_id == dv)).first()._asdict()
    return out


@router.get("/datasets/{dv}/examples")
def search_examples(dv: str, request: Request, q: str | None = None, os: str | None = None, application: str | None = None,
                    domain: str | None = None, length_bin: str | None = None, min_steps: int | None = None,
                    max_steps: int | None = None, media: str | None = Query(None, pattern="^(complete|partial|none)$"),
                    manifest: str | None = None, run: str | None = None,
                    run_status: str | None = Query(None, pattern="^(finalized|response|missing|unfinished)$"),
                    review: str | None = Query(None, pattern="^(mine|unreviewed_by_me|any|none)$"),
                    cursor: str | None = None, limit: int = Query(50, ge=1, le=200),
                    p: Principal = Depends(require("catalog.read"))):
    conds = [examples.c.dataset_version_id == dv]
    if q:
        conds.append(examples.c.search_text.contains(q.lower(), autoescape=True))
    for col, val in (("os", os), ("application", application), ("domain", domain), ("length_bin", length_bin)):
        if val:
            conds.append(getattr(examples.c, col) == val)
    if min_steps is not None:
        conds.append(examples.c.n_steps >= min_steps)
    if max_steps is not None:
        conds.append(examples.c.n_steps <= max_steps)
    if media == "complete":
        conds.append(and_(examples.c.media_total > 0, examples.c.media_materialized == examples.c.media_total))
    elif media == "partial":
        conds.append(and_(examples.c.media_materialized > 0, examples.c.media_materialized < examples.c.media_total))
    elif media == "none":
        conds.append(examples.c.media_materialized == 0)
    if manifest:
        conds.append(examples.c.example_id.in_(select(manifest_members.c.example_id)
                                               .where(manifest_members.c.manifest_id == manifest)))
    if run and run_status:
        fin = select(run_finals.c.example_id).where(and_(run_finals.c.run_id == run, run_finals.c.final.is_not(None)))
        if run_status == "finalized":
            conds.append(examples.c.example_id.in_(fin))
        elif run_status == "response":
            conds.append(examples.c.example_id.in_(fin.where(run_finals.c.final["has_response"].astext == "true")))
        elif run_status == "missing":
            conds.append(examples.c.example_id.in_(fin.where(run_finals.c.final["has_response"].astext == "false")))
        else:
            conds.append(examples.c.example_id.not_in(fin))
    if review:
        mine = select(annotations.c.example_id).where(and_(annotations.c.dataset_version_id == dv,
                                                          annotations.c.reviewer == p.user_id))
        anyr = select(annotations.c.example_id).where(annotations.c.dataset_version_id == dv)
        conds.append({"mine": examples.c.example_id.in_(mine), "unreviewed_by_me": examples.c.example_id.not_in(mine),
                      "any": examples.c.example_id.in_(anyr), "none": examples.c.example_id.not_in(anyr)}[review])
    total_q = select(func.count()).select_from(examples).where(and_(*conds))
    after = dec_cursor(cursor)
    if after:
        conds.append(examples.c.example_id > after["id"])
    cols = [examples.c.example_id, examples.c.instruction, examples.c.n_steps, examples.c.os, examples.c.application,
            examples.c.domain, examples.c.length_bin, examples.c.media_total, examples.c.media_materialized,
            examples.c.recording_id]
    with eng(request).connect() as c:
        rows = c.execute(select(*cols).where(and_(*conds)).order_by(examples.c.example_id).limit(limit + 1)).mappings().all()
        total = c.execute(total_q).scalar_one()
    items = [dict(r) for r in rows[:limit]]
    nxt = enc_cursor({"id": items[-1]["example_id"]}) if len(rows) > limit else None
    return {"items": items, "next_cursor": nxt, "total": total}


def _example_row(c, dv: str, eid: str) -> dict:
    r = c.execute(select(examples).where(and_(examples.c.dataset_version_id == dv, examples.c.example_id == eid))).mappings().first()
    if r is None:
        raise err(404, "not_found", "example not found")
    return dict(r)


@router.get("/datasets/{dv}/examples/{eid}")
def example_detail(dv: str, eid: str, request: Request, p: Principal = Depends(require("catalog.read"))):
    with eng(request).connect() as c:
        ex = _example_row(c, dv, eid)
        ms = c.execute(select(manifests.c.manifest_id, manifests.c.name, manifests.c.partition, manifests.c.official)
                       .select_from(manifest_members.join(manifests))
                       .where(manifest_members.c.example_id == eid)).mappings().all()
        ts = c.execute(select(func.min(steps.c.timestamp_us), func.max(steps.c.timestamp_us))
                       .where(and_(steps.c.dataset_version_id == dv, steps.c.recording_id == ex["recording_id"]))).first()
        synthetic = c.execute(select(dataset_versions.c.synthetic).where(dataset_versions.c.dataset_version_id == dv)).scalar_one()
    ex.pop("search_text", None)
    ex["manifests"] = [dict(m) for m in ms]
    ex["timing"] = {"first_us": ts[0], "last_us": ts[1], "observation_timing": "pre_action",
                    "note": "each screenshot is the screen BEFORE its step's action executes (AgentHorizon release)"}
    ex["synthetic"] = synthetic
    return ex


def _media_urls(dv: str, sha: str | None) -> dict:
    if not sha:
        return {}
    return {"thumb_url": f"/api/media/{dv}/{sha}?variant=thumb", "full_url": f"/api/media/{dv}/{sha}?variant=full"}


@router.get("/datasets/{dv}/examples/{eid}/steps")
def example_steps(dv: str, eid: str, request: Request, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500),
                  p: Principal = Depends(require("catalog.read"))):
    with eng(request).connect() as c:
        ex = _example_row(c, dv, eid)
        q = (select(steps, assets.c.sha256, assets.c.status.label("media_status"), assets.c.width, assets.c.height)
             .select_from(steps.outerjoin(assets, and_(assets.c.dataset_version_id == steps.c.dataset_version_id,
                                                       assets.c.asset_key == steps.c.asset_key)))
             .where(and_(steps.c.dataset_version_id == dv, steps.c.recording_id == ex["recording_id"]))
             .order_by(steps.c.idx).offset(offset).limit(limit))
        rows = c.execute(q).mappings().all()
    out = []
    for r in rows:
        d = {k: r[k] for k in ("idx", "step_id", "action_type", "action_text", "action_text_full", "action", "asset_key",
                               "timestamp_us", "observation_timing", "thought", "action_description")}
        st = r["media_status"] or ("no_screenshot" if not r["asset_key"] else "unknown")
        d["media"] = {"status": st, "width": r["width"], "height": r["height"],
                      **(_media_urls(dv, r["sha256"]) if st == "materialized" else {})}
        out.append(d)
    return {"example_id": eid, "n_steps": ex["n_steps"], "offset": offset, "steps": out}


@router.get("/datasets/{dv}/examples/{eid}/released/{kind}")
def released_file(dv: str, eid: str, kind: str, request: Request, p: Principal = Depends(require("catalog.read"))):
    """The released Markdown/JSON exactly as a judge sees it (served as plain text; never rendered as HTML)."""
    from agenthorizon.data.dataset import DatasetVersion

    if kind not in ("markdown", "json"):
        raise err(404, "not_found", "kind must be markdown or json")
    d = DatasetVersion(request.app.state.settings.datasets_dir / dv)
    text = d.released_markdown(eid) if kind == "markdown" else json.dumps(d.released_json(eid), indent=1)
    if text is None:
        raise err(404, "not_found", f"no released {kind} for this example")
    return PlainTextResponse(text, headers={"Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff"})


@router.get("/media/{dv}/{sha}")
def media(dv: str, sha: str, request: Request, variant: str = Query("thumb", pattern="^(thumb|full)$"),
          p: Principal = Depends(require("catalog.read"))):
    if not SHA_RE.match(sha):
        raise err(400, "bad_digest", "media is addressed by sha256")
    with eng(request).connect() as c:
        ok = c.execute(select(assets.c.asset_key).where(and_(assets.c.dataset_version_id == dv, assets.c.sha256 == sha,
                                                             assets.c.status == "materialized")).limit(1)).first()
    if not ok:
        raise err(404, "media_unavailable", "screenshot not materialized for this dataset version")
    from agenthorizon.data.media import LocalMediaStore

    s = request.app.state.settings
    src = LocalMediaStore(s.media_dir).path(sha)
    if not src.is_file():
        raise err(404, "media_unavailable", "content missing from the media store")
    headers = {"Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}
    if variant == "full":
        return FileResponse(src, media_type="image/png", headers=headers)
    thumb = s.var_dir / "cache" / "thumbs" / f"{sha}-w{THUMB_WIDTH}.jpg"
    if not thumb.is_file():
        import io

        from PIL import Image

        with Image.open(src) as im:
            im = im.convert("RGB")
            im.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 4), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=80, optimize=True)
        atomic_write_bytes(thumb, buf.getvalue())
    return FileResponse(thumb, media_type="image/jpeg", headers=headers)


@router.get("/reference")
def reference(p: Principal = Depends(require("reference.read"))):
    ref = _evidence("REFERENCE_DATA.json") or {}
    inv = _evidence("EXPERIMENT_INVENTORY.json") or {}
    return {"warning": ref.get("warning"), "tables": ref.get("supplementary_tables", []),
            "construction_accounting": ref.get("construction_accounting"),
            "aggregate_mt_definition": ref.get("analysis_aggregate_mt_definition"),
            "legacy_composition": ref.get("analysis_legacy_composition"), "inventory": inv}


@router.get("/judges")
def judges(p: Principal = Depends(require("catalog.read"))):
    from agenthorizon.judging.registry import CONFIGS, INTERFACE_LABELS, MODELS_BY_KEY

    caps = {c["config_id"]: c for c in (_evidence("MODEL_CAPABILITIES.json") or {}).get("configurations", [])}
    out = []
    for cfg in CONFIGS:
        m = MODELS_BY_KEY[cfg.model_key]
        cap = caps.get(cfg.config_id) or {}
        out.append({**cfg.to_dict(), "model_display": m.display_name, "interface_label": INTERFACE_LABELS[cfg.interface],
                    "vision_input": m.vision_input, "model_notes": m.notes,
                    "capability": {"status": cap.get("status", "unverified"), "reasons": cap.get("reasons", []),
                                   "checks": cap.get("checks", {})}})
    rep = _evidence("MODEL_CAPABILITIES.json") or {}
    return {"generated_at": rep.get("generated_at"), "configs": out}
