"""Build the machine-readable source lock (SOURCE_LOCK.json).

Every entry records what was requested, what was actually resolved and retrieved (with digests), how it was
obtained, and — when retrieval failed — the classified reason. Status vocabulary:

* ``downloaded``      bytes retrieved and digested at a pinned revision
* ``inspected``       metadata read (e.g. tree listing) but content not fully retrieved
* ``inaccessible``    retrieval attempted from this environment and failed (reason recorded)
* ``described_only``  not retrieved; known only through another source (named in ``described_by``)
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from agenthorizon import __version__
from agenthorizon.config import PROJECT_ROOT, Settings
from agenthorizon.sources.gitsource import GitSourceError, ensure_checkout, resolve_revision
from agenthorizon.sources.hf import HFDatasetClient, HFError
from agenthorizon.sources.probe import probe_url
from agenthorizon.sources.registry import SOURCES, SourceSpec
from agenthorizon.util.hashing import sha256_file
from agenthorizon.util.io import utcnow_iso

LOCK_VERSION = 1

# Pinned revisions observed when this lock format was first produced. ``sources lock`` re-resolves the
# requested revision and reports drift instead of silently moving a pin.
KNOWN_PINS = {
    "agenthorizon-repo": "8584a347370ab1d92b908732cfabe72b3a23486d",
    "agentrewardbench-repo": "05899fcfe52c925978944a23920373b7a9c63740",
    "osworld-repo": "b138d348256078fa634fc3b73567a7337c793e6b",
}
SHALLOW_SOURCES = {"osworld-repo"}


def _project_commit() -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(PROJECT_ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except Exception:
        return None


def detect_git_license(root: Path) -> dict:
    files = [p.name for p in root.iterdir() if p.is_file() and re.match(r"(?i)^(license|licence|copying)", p.name)]
    declared: list[str] = []
    for meta in ("setup.py", "setup.cfg", "pyproject.toml", "package.json", "CITATION.cff"):
        p = root / meta
        if not p.is_file():
            continue
        text = p.read_text(errors="replace")
        declared += [f"{meta}: {m.strip()}" for m in re.findall(r"License :: [^\"'\n]+", text)]
        declared += [f"{meta}: license={m}" for m in re.findall(r'(?m)^\s*license\s*[=:]\s*["\']?([^"\'\n,}]+)', text)]
    spdx = None
    for name in files:
        head = (root / name).read_text(errors="replace")[:400]
        if "Apache License" in head and "Version 2.0" in head:
            spdx = "Apache-2.0"
        elif "MIT License" in head:
            spdx = "MIT"
    status = "declared" if (files or declared) else "absent"
    return {"status": status, "license_files": files, "declared_metadata": declared, "detected_spdx": spdx}


def _lock_git(spec: SourceSpec, settings: Settings) -> dict:
    url = spec.urls[0]
    entry: dict = {"requested": {"urls": list(spec.urls), "revision": spec.requested_revision}}
    try:
        commit, refs = resolve_revision(url, spec.requested_revision)
    except GitSourceError as exc:
        entry.update(status="inaccessible", access_attempts=[{"at": utcnow_iso(), "method": "git ls-remote", "result": str(exc)}])
        return entry
    known = KNOWN_PINS.get(spec.source_id)
    entry["drift_from_known_pin"] = None if (known is None or known == commit) else {"known": known, "resolved": commit}
    co = ensure_checkout(url, commit, settings.sources_dir, shallow=spec.source_id in SHALLOW_SOURCES)
    inv = co.inventory()
    entry.update(
        status="downloaded",
        retrieved_via="git clone through the session git proxy (anonymous read)",
        resolved_revision=commit,
        remote_refs={k: v for k, v in sorted(refs.items())},
        commit=co.commit_info(),
        history=co.history(),
        shallow=co.is_shallow(),
        tree_digest=co.tree_digest(),
        file_count=len(inv),
        lfs_pointer_files=[e.path for e in inv if e.lfs_pointer],
        files=[e.to_dict() for e in inv],
        license=detect_git_license(co.path),
        checkout_path=str(co.path.relative_to(settings.var_dir)) if co.path.is_relative_to(settings.var_dir) else str(co.path),
    )
    return entry


def _lock_document(spec: SourceSpec, parent: dict, settings: Settings) -> dict:
    entry: dict = {"requested": {"urls": list(spec.urls), "path": spec.path}, "parent_source_id": spec.parent_source_id}
    if parent.get("status") != "downloaded":
        entry.update(status="inaccessible", reason=f"parent source {spec.parent_source_id} not retrieved")
        return entry
    match = next((f for f in parent["files"] if f["path"] == spec.path), None)
    if match is None:
        entry.update(status="inaccessible", reason=f"{spec.path} absent at {parent['resolved_revision']}")
        return entry
    p = settings.var_dir / parent["checkout_path"] / spec.path
    text = p.read_text(encoding="utf-8")
    title = next((ln.lstrip("# ").strip() for ln in text.splitlines() if ln.startswith("#")), None)
    entry.update(
        status="downloaded",
        resolved_revision=parent["resolved_revision"],
        sha256=match["sha256"],
        bytes=match["size"],
        lines=text.count("\n"),
        first_heading=title,
    )
    if spec.source_id == "agenthorizon-standard":
        m = re.search(r"\(v(\d+\.\d+)\)", title or "")
        entry["document_declared_version"] = m.group(1) if m else None
        entry["record_version_field_documented_as"] = "1.0" if '"version": "1.0"' in text else None
        entry["version_note"] = (
            "Document title says v1.1 while the schema table says the record `version` field is always \"1.0\"; "
            "the released converter (scripts/convert_agenthorizon_trajectories.py) writes \"1.1\". "
            "The actual value must be read from released rows."
        )
    return entry


def _lock_probe_only(spec: SourceSpec) -> dict:
    attempts = [probe_url(u).to_dict() for u in (spec.probe_urls or spec.urls)]
    ok = [a for a in attempts if a["outcome"] == "ok"]
    status = "inspected" if ok else "inaccessible"
    return {"requested": {"urls": list(spec.urls), "revision": spec.requested_revision}, "status": status, "access_attempts": attempts}


def _lock_hf(spec: SourceSpec, settings: Settings) -> dict:
    entry = _lock_probe_only(spec)
    if entry["status"] != "inspected":
        return entry
    repo_id = spec.urls[0].split("/datasets/")[-1]
    client = HFDatasetClient(repo_id, endpoint=settings.hf_endpoint,
                             token=settings.hf_token.get_secret_value() if settings.hf_token else None)
    try:
        sha = client.resolve_revision(spec.requested_revision or "main")
        info = client.info(sha)
        tree = client.list_tree(sha)
        entry.update(
            resolved_revision=sha,
            last_modified=info.get("lastModified"),
            card_license=(info.get("cardData") or {}).get("license"),
            tags=info.get("tags"),
            refs=client.refs(),
            commits=client.commits(sha),
            file_count=len(tree),
            total_bytes=sum(e.size for e in tree),
            files=[e.to_dict() for e in tree],
        )
    except HFError as exc:
        entry.setdefault("access_attempts", []).append({"at": utcnow_iso(), "method": "hf api", "result": str(exc), "kind": exc.kind})
        entry["status"] = "inaccessible"
    finally:
        client.close()
    return entry


def _croissant_declared(settings: Settings, repo_entry: dict) -> dict | None:
    if repo_entry.get("status") != "downloaded":
        return None
    import json

    p = settings.var_dir / repo_entry["checkout_path"] / "paper" / "croissant.json"
    if not p.is_file():
        return None
    data = json.loads(p.read_text())
    return {
        "declared_by": "agenthorizon-repo:paper/croissant.json",
        "identifier": data.get("identifier"),
        "license_field": data.get("license"),
        "version": data.get("version"),
        "date_published": data.get("datePublished"),
        "distribution": [
            {"name": d.get("name"), "sha256": d.get("sha256"), "encoding": d.get("encodingFormat"),
             "description": d.get("description"), "url_has_private_access_key": "key=" in (d.get("contentUrl") or "")}
            for d in data.get("distribution", [])
        ],
        "rai_maintenance_plan": data.get("rai:dataReleaseMaintenancePlan"),
        "partition_statement": [x for x in data.get("rai:dataLimitations", []) if "partition" in x.lower()],
    }


def material_licenses(lock: dict) -> list[dict]:
    """Licenses verified separately per material class (code, labels, screenshots, videos, external)."""
    def lic(sid: str) -> dict:
        return next((s for s in lock["sources"] if s["source_id"] == sid), {}).get("license") or {}

    ah = lic("agenthorizon-repo")
    arb = lic("agentrewardbench-repo")
    osw = lic("osworld-repo")
    ds = next((s for s in lock["sources"] if s["source_id"] == "agenthorizon-dataset"), {})
    ds_status = ds.get("status")
    return [
        {"material": "AgentHorizon paper (S1)", "license": "unverified", "basis": "arXiv page inaccessible from this environment"},
        {"material": "AgentHorizon code/prompts (S2)", "license": "unspecified" if ah.get("status") == "absent" else ah,
         "basis": "No LICENSE file or license metadata at the pinned commit; treated as all-rights-reserved. "
                  "Not vendored: fetched at the pinned commit and referenced by digest."},
        {"material": "AgentHorizon labels and trajectory JSON/Markdown (S3)",
         "license": ds.get("card_license") or "unverified",
         "basis": "dataset card" if ds.get("card_license") else f"dataset card not readable (S3 status: {ds_status})"},
        {"material": "AgentHorizon screenshots (S3 media)", "license": ds.get("card_license") or "unverified",
         "basis": "covered by dataset card only if the card says so; card unreadable" if not ds.get("card_license") else "dataset card"},
        {"material": "AgentHorizon source videos/recordings", "license": "not applicable (not located)",
         "basis": "README/Croissant list no video artifacts; paper mentions recordings, which does not establish a download"},
        {"material": "AgentHorizon Croissant license field", "license": "not a license identifier",
         "basis": "croissant.json `license` points at the Dataverse landing page; RAI plan says an open license is chosen on acceptance"},
        {"material": "AgentRewardBench code + annotations.csv (S9 repo)", "license": "unspecified" if arb.get("status") == "absent" else arb,
         "basis": "No LICENSE file, classifier, or CITATION license at the pinned commit"},
        {"material": "AgentRewardBench trajectories/screenshots (S9 HF)", "license": "unverified", "basis": "dataset card not readable"},
        {"material": "OSWorld code + task definitions (S10)", "license": osw.get("detected_spdx") or osw,
         "basis": "LICENSE file + setup.py classifier at the pinned commit"},
    ]


def build_lock(settings: Settings, master_prompt_path: Path | None = None) -> dict:
    started = utcnow_iso()
    entries: dict[str, dict] = {}
    for spec in SOURCES:
        if spec.kind == "git":
            e = _lock_git(spec, settings)
        elif spec.kind == "hf_dataset":
            e = _lock_hf(spec, settings)
        elif spec.kind in ("paper", "dataverse"):
            e = _lock_probe_only(spec)
        else:
            continue
        entries[spec.source_id] = e
    for spec in SOURCES:
        if spec.kind == "repo_document":
            entries[spec.source_id] = _lock_document(spec, entries[spec.parent_source_id], settings)
    mp: dict = {"requested": {"urls": []}}
    if master_prompt_path and master_prompt_path.is_file():
        mp.update(status="downloaded", sha256=sha256_file(master_prompt_path), bytes=master_prompt_path.stat().st_size,
                  retrieved_via="user upload", note="Content not copied into the repository.")
    else:
        mp.update(status="described_only", described_by=["user conversation"])
    entries["master-prompt"] = mp

    dv = entries.get("agenthorizon-dataverse")
    if dv is not None:
        dv["declared_artifacts"] = _croissant_declared(settings, entries.get("agenthorizon-repo", {}))

    sources = []
    for spec in SOURCES:
        e = entries.get(spec.source_id)
        if e is None:
            continue
        sources.append({"source_id": spec.source_id, "citation": spec.citation, "kind": spec.kind, "role": spec.role,
                        "title": spec.title, **e})
    lock = {
        "lock_version": LOCK_VERSION,
        "generated_at": utcnow_iso(),
        "generation_started_at": started,
        "generator": {"package": "agenthorizon", "version": __version__, "project_commit": _project_commit()},
        "sources": sources,
    }
    lock["material_licenses"] = material_licenses(lock)
    return lock
