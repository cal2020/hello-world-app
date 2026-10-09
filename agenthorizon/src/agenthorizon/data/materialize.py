"""Explicit, resumable media materialization for an existing dataset version.

Metadata can be fully indexed while screenshots stay remote. This module fetches selected media (all, one
recording, or explicit keys) from the version's pinned source, verifies each file against the release listing,
places it in the content-addressed store, and appends the outcome to ``state/media_state.jsonl`` (append-only;
the version's normalized files are never rewritten).
"""

from __future__ import annotations

import fcntl
import json
from pathlib import Path

from agenthorizon.config import Settings
from agenthorizon.data.dataset import DatasetVersion
from agenthorizon.data.media import LocalMediaStore, inspect_image
from agenthorizon.sources.hf import HFDatasetClient, TreeEntry
from agenthorizon.util.hashing import sha256_file
from agenthorizon.util.io import utcnow_iso

MEDIA_PREFIX = "sandbox/data/media/images/"


def state_path(dv: DatasetVersion) -> Path:
    return dv.root / "state" / "media_state.jsonl"


def load_state(dv: DatasetVersion) -> dict[str, dict]:
    p = state_path(dv)
    out: dict[str, dict] = {}
    if p.is_file():
        for line in p.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                out[r["asset_key"]] = r
    return out


def current_assets(dv: DatasetVersion) -> dict[str, dict]:
    base = {k: dict(v) for k, v in dv.assets.items()}
    for k, st in load_state(dv).items():
        if k in base:
            base[k].update(st)
    return base


def _append(dv: DatasetVersion, rows: list[dict]) -> None:
    p = state_path(dv)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")
        f.flush()
        fcntl.flock(f, fcntl.LOCK_UN)


def keys_for_recording(dv: DatasetVersion, recording_id: str) -> list[str]:
    return [s["asset_key"] for s in dv.steps(recording_id) if s.get("asset_key")]


def materialize_media(settings: Settings, dv: DatasetVersion, *, keys: list[str] | None = None,
                      recording_id: str | None = None, limit: int | None = None,
                      client: HFDatasetClient | None = None) -> dict:
    assets = current_assets(dv)
    if recording_id:
        wanted = keys_for_recording(dv, recording_id)
    elif keys is not None:
        wanted = list(keys)
    else:
        wanted = [k for k, a in assets.items() if a["status"] != "materialized"]
    wanted = [k for k in wanted if k in assets and assets[k]["status"] != "materialized"]
    if limit is not None:
        wanted = wanted[:limit]
    store = LocalMediaStore(settings.media_dir)
    src = dv.info["source"]
    rows: list[dict] = []
    failures: list[dict] = []
    if not wanted:
        return {"requested": 0, "materialized": 0, "failed": 0}
    if src["kind"] == "local":
        base = Path(src["local_dir"])
        for k in wanted:
            p = base / (MEDIA_PREFIX + k)
            if not p.is_file():
                failures.append({"asset_key": k, "error": "missing at local source"})
                continue
            exp = assets[k].get("expected_digest")
            digest = sha256_file(p)
            if exp and exp[0] == "sha256" and exp[1] != digest:
                failures.append({"asset_key": k, "error": "sha256 mismatch with release listing"})
                continue
            store.put_file(p)
            rows.append(k)
    elif src["kind"] == "hf":
        c = client or HFDatasetClient(src["repo_id"], endpoint=settings.hf_endpoint,
                                      token=settings.hf_token.get_secret_value() if settings.hf_token else None)
        dl_root = settings.private_dir / "downloads" / f"{src['repo_id'].replace('/', '__')}@{src['revision']}"
        entries = []
        for k in wanted:
            a = assets[k]
            exp = a.get("expected_digest") or [None, None]
            entries.append(TreeEntry(MEDIA_PREFIX + k, a.get("expected_bytes") or 0,
                                     exp[1] if exp[0] == "git-blob-sha1" else None, exp[1] if exp[0] == "sha256" else None))
        plan = c.plan(src["revision"], entries, dl_root)
        for o in c.download(plan, dl_root, concurrency=settings.download_concurrency,
                            storage_limit_bytes=settings.storage_limit_bytes):
            if o.status == "failed":
                failures.append({"asset_key": o.path[len(MEDIA_PREFIX):], "error": o.error})
        for k in wanted:
            p = dl_root / (MEDIA_PREFIX + k)
            if p.is_file() and not any(f["asset_key"] == k for f in failures):
                store.put_file(p)
                rows.append(k)
    else:
        raise ValueError(f"unsupported source kind {src['kind']!r}")
    out_rows = []
    for k in rows:
        p = base / (MEDIA_PREFIX + k) if src["kind"] == "local" else None
        digest = sha256_file(p) if p else sha256_file(settings.private_dir / "downloads" /
                                                      f"{src['repo_id'].replace('/', '__')}@{src['revision']}" / (MEDIA_PREFIX + k))
        facts = inspect_image(store.path(digest))
        out_rows.append({"asset_key": k, "sha256": digest, "status": "corrupt" if facts.error else "materialized",
                         "width": facts.width, "height": facts.height, "format": facts.format, "bytes": facts.bytes,
                         "materialized_at": utcnow_iso()})
    out_rows += [{"asset_key": f["asset_key"], "status": "fetch_failed", "error": f["error"], "attempted_at": utcnow_iso()}
                 for f in failures]
    _append(dv, out_rows)
    return {"requested": len(wanted), "materialized": len(rows), "failed": len(failures), "failures": failures[:10]}


def media_coverage(dv: DatasetVersion) -> dict:
    assets = current_assets(dv)
    by: dict[str, int] = {}
    for a in assets.values():
        by[a["status"]] = by.get(a["status"], 0) + 1
    total = len(assets)
    mat = by.get("materialized", 0)
    return {"assets": total, "by_status": by, "materialized_fraction": (mat / total) if total else None,
            "expected_bytes_total": sum(a.get("expected_bytes") or 0 for a in assets.values())}
