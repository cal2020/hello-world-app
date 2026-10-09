"""Privileged research and human-review routes.

Research views (gold labels, failure categories, pair/recording groups, per-item score outcomes) require the
``research.labels`` permission and are audited. Judge workers never reach these endpoints: judges have no network
path to the application at all (the sandbox egress allowlist names only provider hosts).

Human review is blind first: a reviewer records a verdict without labels or counterpart instructions; only after
that annotation exists can they reveal the gold label and pair evidence for the item (audited). Proposed corrections
are stored as new annotation rows; official gold labels are never modified.
"""

from __future__ import annotations

import csv
import io
import json

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, insert, select

from agenthorizon.app.api.auth import Principal, audit, require
from agenthorizon.app.api.common import dec_cursor, enc_cursor, eng, err
from agenthorizon.app.schema import (
    annotations,
    examples,
    gold_labels,
    grouping,
    manifest_members,
    reveals,
    score_item_outcomes,
    score_reports,
)
from agenthorizon.scoring.categories import NATIVE_TO_CATEGORY

router = APIRouter(prefix="/api")
NATIVE_MISTAKE_TYPES = tuple(NATIVE_TO_CATEGORY)  # canonical S7 spellings plus the released plural variant


def _group(c, dv: str, eid: str) -> list[dict]:
    """Examples sharing this example's recording or label-pair component (from private grouping)."""
    g = c.execute(select(grouping).where(and_(grouping.c.dataset_version_id == dv, grouping.c.example_id == eid))).mappings().first()
    if g is None:
        return []
    conds = []
    if g["component_id"]:
        conds.append(grouping.c.component_id == g["component_id"])
    if g["recording_id"]:
        conds.append(grouping.c.recording_id == g["recording_id"])
    if not conds:
        return []
    from sqlalchemy import or_

    rows = c.execute(select(grouping.c.example_id, examples.c.instruction, gold_labels.c.label,
                            gold_labels.c.mistake_type_native, grouping.c.recording_id, grouping.c.component_id)
                     .select_from(grouping.join(examples, and_(examples.c.dataset_version_id == grouping.c.dataset_version_id,
                                                               examples.c.example_id == grouping.c.example_id))
                                  .outerjoin(gold_labels, and_(gold_labels.c.dataset_version_id == grouping.c.dataset_version_id,
                                                               gold_labels.c.example_id == grouping.c.example_id)))
                     .where(and_(grouping.c.dataset_version_id == dv, or_(*conds)))).mappings().all()
    return [dict(r) | {"self": r["example_id"] == eid} for r in rows]


@router.get("/research/datasets/{dv}/examples/{eid}")
def research_example(dv: str, eid: str, request: Request, p: Principal = Depends(require("research.labels"))):
    with eng(request).connect() as c:
        g = c.execute(select(gold_labels).where(and_(gold_labels.c.dataset_version_id == dv,
                                                     gold_labels.c.example_id == eid))).mappings().first()
        group = _group(c, dv, eid)
    audit(eng(request), p, "research.view_labels", f"{dv}/{eid}", None, request.state.request_id)
    return {"example_id": eid, "gold": ({k: g[k] for k in ("label", "mistake_type_native", "category")} if g else None),
            "group": group, "group_available": bool(group),
            "note": "pairs come from the release's label grouping and shared recordings; nothing is inferred from text similarity"}


@router.get("/research/datasets/{dv}/labelled")
def research_filter(dv: str, request: Request, label: str | None = Query(None, pattern="^(positive|negative)$"),
                    category: str | None = None, manifest: str | None = None, cursor: str | None = None,
                    limit: int = Query(100, ge=1, le=500), p: Principal = Depends(require("research.labels"))):
    conds = [gold_labels.c.dataset_version_id == dv]
    if label:
        conds.append(gold_labels.c.label == label)
    if category:
        conds.append(gold_labels.c.category == category if category != "untyped"
                     else and_(gold_labels.c.label == "negative", gold_labels.c.category.is_(None)))
    if manifest:
        conds.append(gold_labels.c.example_id.in_(select(manifest_members.c.example_id)
                                                  .where(manifest_members.c.manifest_id == manifest)))
    after = dec_cursor(cursor)
    if after:
        conds.append(gold_labels.c.example_id > after["id"])
    with eng(request).connect() as c:
        rows = c.execute(select(gold_labels.c.example_id, gold_labels.c.label, gold_labels.c.category,
                                gold_labels.c.mistake_type_native, examples.c.instruction, examples.c.n_steps)
                         .select_from(gold_labels.join(examples, and_(examples.c.dataset_version_id == gold_labels.c.dataset_version_id,
                                                                      examples.c.example_id == gold_labels.c.example_id)))
                         .where(and_(*conds)).order_by(gold_labels.c.example_id).limit(limit + 1)).mappings().all()
    audit(eng(request), p, "research.filter_labels", dv, {"label": label, "category": category}, request.state.request_id)
    items = [dict(r) for r in rows[:limit]]
    return {"items": items, "next_cursor": enc_cursor({"id": items[-1]["example_id"]}) if len(rows) > limit else None}


@router.get("/research/scores/{score_id}/items")
def score_items(score_id: int, request: Request, outcome: str | None = None, p: Principal = Depends(require("research.labels"))):
    with eng(request).connect() as c:
        rep = c.execute(select(score_reports.c.dataset_version_id).where(score_reports.c.score_id == score_id)).first()
        if rep is None:
            raise err(404, "not_found", "score report not found")
        q = (select(score_item_outcomes.c.example_id, score_item_outcomes.c.outcome, gold_labels.c.label,
                    gold_labels.c.mistake_type_native, examples.c.instruction, examples.c.n_steps)
             .select_from(score_item_outcomes
                          .outerjoin(gold_labels, and_(gold_labels.c.dataset_version_id == rep[0],
                                                       gold_labels.c.example_id == score_item_outcomes.c.example_id))
                          .outerjoin(examples, and_(examples.c.dataset_version_id == rep[0],
                                                    examples.c.example_id == score_item_outcomes.c.example_id)))
             .where(score_item_outcomes.c.score_id == score_id).order_by(score_item_outcomes.c.example_id))
        if outcome:
            q = q.where(score_item_outcomes.c.outcome == outcome)
        rows = c.execute(q).mappings().all()
    audit(eng(request), p, "research.score_items", str(score_id), None, request.state.request_id)
    return {"score_id": score_id, "items": [dict(r) for r in rows]}


# ---- human review ----------------------------------------------------------------------------------------------
class AnnotationIn(BaseModel):
    success: bool | None = None
    mistake_type_native: str | None = None
    rationale: str = Field(min_length=3, max_length=8000)
    evidence_steps: list[int] = Field(default_factory=list, max_length=200)
    rubric_revision: str = Field(min_length=3)
    proposed_correction: dict | None = None


def rubric() -> dict:
    from agenthorizon.judging.prompts import rubric_extension_instructions

    r = rubric_extension_instructions()
    return {"rubric_revision": f"ah-rubric@{r.source['revision'][:8]}:{r.sha256[:8]}", "text": r.text, "source": r.source}


@router.get("/reviews/rubric")
def get_rubric(p: Principal = Depends(require("catalog.read"))):
    return rubric()


@router.get("/reviews/queue")
def review_queue(request: Request, dv: str, manifest: str | None = None, limit: int = Query(20, ge=1, le=200),
                 p: Principal = Depends(require("review.write"))):
    mine = select(annotations.c.example_id).where(and_(annotations.c.dataset_version_id == dv, annotations.c.reviewer == p.user_id))
    conds = [examples.c.dataset_version_id == dv, examples.c.example_id.not_in(mine)]
    if manifest:
        conds.append(examples.c.example_id.in_(select(manifest_members.c.example_id).where(manifest_members.c.manifest_id == manifest)))
    with eng(request).connect() as c:
        rows = c.execute(select(examples.c.example_id, examples.c.instruction, examples.c.n_steps)
                         .where(and_(*conds)).order_by(examples.c.example_id).limit(limit)).mappings().all()
    return {"items": [dict(r) for r in rows], "blind": True}


def _revealed(c, dv: str, eid: str, user: str) -> bool:
    return c.execute(select(reveals.c.reviewer).where(and_(reveals.c.dataset_version_id == dv, reveals.c.example_id == eid,
                                                           reveals.c.reviewer == user))).first() is not None


@router.get("/reviews/{dv}/{eid}")
def review_state(dv: str, eid: str, request: Request, p: Principal = Depends(require("review.write"))):
    with eng(request).connect() as c:
        mine = c.execute(select(annotations).where(and_(annotations.c.dataset_version_id == dv, annotations.c.example_id == eid,
                                                        annotations.c.reviewer == p.user_id))
                         .order_by(annotations.c.annotation_id)).mappings().all()
        revealed = _revealed(c, dv, eid, p.user_id)
        reveal = None
        if revealed:
            g = c.execute(select(gold_labels).where(and_(gold_labels.c.dataset_version_id == dv,
                                                         gold_labels.c.example_id == eid))).mappings().first()
            reveal = {"gold": {k: g[k] for k in ("label", "mistake_type_native", "category")} if g else None,
                      "group": _group(c, dv, eid)}
    return {"example_id": eid, "my_annotations": [{**dict(a), "created_at": a["created_at"].isoformat()} for a in mine],
            "revealed": revealed, "reveal": reveal, "rubric_revision": rubric()["rubric_revision"]}


@router.post("/reviews/{dv}/{eid}", status_code=201)
def annotate(dv: str, eid: str, body: AnnotationIn, request: Request, p: Principal = Depends(require("review.write"))):
    if body.mistake_type_native is not None and body.mistake_type_native not in NATIVE_MISTAKE_TYPES:
        raise err(422, "bad_mistake_type", f"use one of {NATIVE_MISTAKE_TYPES}")
    if body.success is True and body.mistake_type_native:
        raise err(422, "contract", "a successful verdict has no failure category")
    with eng(request).begin() as c:
        if c.execute(select(examples.c.example_id).where(and_(examples.c.dataset_version_id == dv,
                                                              examples.c.example_id == eid))).first() is None:
            raise err(404, "not_found", "example not found")
        revealed = _revealed(c, dv, eid, p.user_id)
        if body.proposed_correction and not revealed:
            raise err(409, "blind_phase", "corrections to the gold label are proposed after reveal")
        prev = c.execute(select(func.max(annotations.c.annotation_id)).where(and_(
            annotations.c.dataset_version_id == dv, annotations.c.example_id == eid, annotations.c.reviewer == p.user_id))).scalar()
        aid = c.execute(insert(annotations).values(
            dataset_version_id=dv, example_id=eid, reviewer=p.user_id, phase="post_reveal" if revealed else "blind",
            success=body.success, mistake_type_native=body.mistake_type_native, rationale=body.rationale,
            evidence_steps=body.evidence_steps, proposed_correction=body.proposed_correction,
            rubric_revision=body.rubric_revision, supersedes=prev).returning(annotations.c.annotation_id)).scalar_one()
    audit(eng(request), p, "review.annotate", f"{dv}/{eid}", {"annotation_id": aid, "phase": "post_reveal" if revealed else "blind"},
          request.state.request_id)
    return {"annotation_id": aid, "phase": "post_reveal" if revealed else "blind"}


@router.post("/reviews/{dv}/{eid}/reveal")
def reveal(dv: str, eid: str, request: Request, p: Principal = Depends(require("review.reveal_own"))):
    with eng(request).begin() as c:
        blind = c.execute(select(annotations).where(and_(annotations.c.dataset_version_id == dv, annotations.c.example_id == eid,
                                                         annotations.c.reviewer == p.user_id, annotations.c.phase == "blind"))
                          .order_by(annotations.c.annotation_id.desc()).limit(1)).mappings().first()
        if blind is None:
            raise err(409, "blind_first", "record a blind annotation before revealing the gold label")
        from sqlalchemy.dialects.postgresql import insert as pg_insert

        c.execute(pg_insert(reveals).values(dataset_version_id=dv, example_id=eid, reviewer=p.user_id).on_conflict_do_nothing())
        g = c.execute(select(gold_labels).where(and_(gold_labels.c.dataset_version_id == dv,
                                                     gold_labels.c.example_id == eid))).mappings().first()
        group = _group(c, dv, eid)
    audit(eng(request), p, "review.reveal", f"{dv}/{eid}", {"blind_annotation_id": blind["annotation_id"]}, request.state.request_id)
    gold = {k: g[k] for k in ("label", "mistake_type_native", "category")} if g else None
    agrees = None
    if gold and blind["success"] is not None:
        agrees = (blind["success"] is True) == (gold["label"] == "positive")
    return {"gold": gold, "group": group, "blind_verdict_agrees_with_gold": agrees,
            "note": "Gold labels are not edited by review; propose a correction as a new annotation if warranted."}


@router.get("/reviews/export")
def export_reviews(request: Request, dv: str, fmt: str = Query("jsonl", alias="format", pattern="^(jsonl|csv)$"),
                   p: Principal = Depends(require("review.export"))):
    with eng(request).connect() as c:
        rows = c.execute(select(annotations).where(annotations.c.dataset_version_id == dv)
                         .order_by(annotations.c.annotation_id)).mappings().all()
    recs = [{**dict(r), "created_at": r["created_at"].isoformat()} for r in rows]
    audit(eng(request), p, "review.export", dv, {"n": len(recs)}, request.state.request_id)
    if fmt == "jsonl":
        return PlainTextResponse("".join(json.dumps(r, sort_keys=True) + "\n" for r in recs), media_type="application/x-ndjson")
    buf = io.StringIO()
    fields = ["annotation_id", "dataset_version_id", "example_id", "reviewer", "phase", "success", "mistake_type_native",
              "rationale", "evidence_steps", "proposed_correction", "rubric_revision", "supersedes", "created_at"]
    w = csv.DictWriter(buf, fieldnames=fields)
    w.writeheader()
    for r in recs:
        w.writerow({k: (json.dumps(r[k]) if isinstance(r[k], (list, dict)) else r[k]) for k in fields})
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")


@router.get("/reviews/stats")
def review_stats(request: Request, dv: str, p: Principal = Depends(require("review.write"))):
    """Counts only. Agreement is computed solely over items with blind verdicts from >= 2 distinct reviewers."""
    with eng(request).connect() as c:
        rows = c.execute(select(annotations.c.example_id, annotations.c.reviewer, annotations.c.success, annotations.c.annotation_id)
                         .where(and_(annotations.c.dataset_version_id == dv, annotations.c.phase == "blind"))
                         .order_by(annotations.c.annotation_id)).all()
    latest: dict[tuple[str, str], bool | None] = {}
    for eid, rev, succ, _ in rows:
        latest[(eid, rev)] = succ
    by_item: dict[str, list] = {}
    for (eid, _rev), succ in latest.items():
        if succ is not None:
            by_item.setdefault(eid, []).append(succ)
    multi = {e: v for e, v in by_item.items() if len(v) >= 2}
    pairs = agree = 0
    for v in multi.values():
        for i in range(len(v)):
            for j in range(i + 1, len(v)):
                pairs += 1
                agree += v[i] == v[j]
    return {"items_with_blind_verdicts": len(by_item), "items_with_independent_blind_verdicts": len(multi),
            "pairwise_agreement": (agree / pairs) if pairs else None, "pairs": pairs,
            "note": "No agreement statistic is reported unless independent blind annotations exist."}
