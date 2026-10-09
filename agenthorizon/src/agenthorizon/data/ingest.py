"""Idempotent ingestion of an AgentHorizon release into an immutable dataset version.

Stages: discover → lock → inventory → estimate → transfer → parse → normalize → index → private labels and
grouping → manifests → validate → reconcile → report. Re-running with identical inputs is a no-op; different
inputs under an existing version id are refused (never silently replaced). Label files are written only to the
private store. Invalid records are quarantined with diagnostics, never silently dropped.

Sources: the Hugging Face dataset at a pinned revision (``source="hf"``) or a local directory that mirrors
the released layout (``source="local"``, e.g. a manual download, or a synthetic test fixture).
"""

from __future__ import annotations

import json
import os
import shutil
from collections import Counter, defaultdict
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from agenthorizon.config import Settings
from agenthorizon.data.grouping import content_components, label_components, size_distribution
from agenthorizon.data.markdown import parse_markdown, render_markdown
from agenthorizon.data.media import LocalMediaStore, inspect_image
from agenthorizon.data.normalize import NORMALIZER_VERSION, normalize_example
from agenthorizon.data.splits import LEGACY_LABEL_FILES, Manifest
from agenthorizon.data.standard import SchemaError, parse_label, parse_trajectory
from agenthorizon.scoring.categories import CATEGORY_MAP_VERSION, normalize_native
from agenthorizon.sources.hf import HFDatasetClient, HFError, TreeEntry
from agenthorizon.util.hashing import sha256_file, tree_digest
from agenthorizon.util.io import atomic_write_json, utcnow_iso, write_jsonl

SYNTHETIC_MARKER = "SYNTHETIC_FIXTURE.txt"
MEDIA_PREFIX = "sandbox/data/media/images/"


class IngestError(RuntimeError):
    pass


@dataclass
class IngestOptions:
    source: str = "hf"  # hf | local
    benchmark: str = "agenthorizon"
    repo_id: str = "ServiceNow/AgentHorizon"
    revision: str = "main"
    local_dir: Path | None = None
    media: str = "none"  # none | all
    max_media_files: int | None = None


@dataclass
class FileRec:
    path: str
    size: int
    kind: str
    expected: tuple[str, str] | None = None  # (algo, digest)
    sha256: str | None = None


@dataclass
class IngestResult:
    dataset_version_id: str
    status: str
    root: str
    stages: list[dict] = field(default_factory=list)
    summary: dict = field(default_factory=dict)


def classify_path(path: str) -> str:
    p = PurePosixPath(path)
    if path.startswith(MEDIA_PREFIX):
        return "media"
    if path.startswith("sandbox/data/markdowns/") and p.suffix == ".md":
        return "markdown"
    if path.startswith("sandbox/data/jsons/") and p.suffix == ".json":
        return "json"
    if len(p.parts) == 1 and p.suffix == ".jsonl":
        return "label_file"  # scorer-only: written to the private store only
    if len(p.parts) == 1 and p.name in (SYNTHETIC_MARKER,):
        return "marker"
    if len(p.parts) == 1 and p.suffix in (".md", ".json", ".cff", ".txt"):
        return "card"
    if path.startswith("sandbox/") and p.name in ("AGENTS.md", "CLAUDE.md", "GEMINI.md", "prompt.md"):
        return "harness_instructions"
    return "other"


class Stages:
    def __init__(self, log: Callable[[str], None] | None):
        self.records: list[dict] = []
        self.log = log or (lambda m: None)

    def run(self, name: str, fn: Callable[[], dict | None]) -> dict:
        rec = {"stage": name, "started_at": utcnow_iso()}
        self.log(f"[{name}] start")
        try:
            details = fn() or {}
            rec.update(status="ok", details=details)
            return details
        except Exception as exc:
            rec.update(status="failed", error=f"{type(exc).__name__}: {exc}")
            raise
        finally:
            rec["finished_at"] = utcnow_iso()
            self.records.append(rec)
            self.log(f"[{name}] {rec.get('status')}")


def _discover_local(root: Path) -> list[FileRec]:
    out = []
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            full = Path(dirpath) / f
            rel = full.relative_to(root).as_posix()
            if f.endswith(".partial") or "/." in "/" + rel:
                continue
            out.append(FileRec(rel, full.stat().st_size, classify_path(rel)))
    out.sort(key=lambda r: r.path)
    return out


def _discover_hf(client: HFDatasetClient, revision: str) -> tuple[str, list[FileRec]]:
    sha = client.resolve_revision(revision)
    tree = client.list_tree(sha)
    recs = [FileRec(e.path, e.size, classify_path(e.path), e.expected_digest) for e in tree]
    return sha, recs


def ingest(settings: Settings, opts: IngestOptions, log: Callable[[str], None] | None = None,
           client: HFDatasetClient | None = None) -> IngestResult:
    st = Stages(log)
    ctx: dict = {}

    # ---- discover + lock ---------------------------------------------------------------------------
    def discover() -> dict:
        if opts.source == "local":
            if not opts.local_dir or not Path(opts.local_dir).is_dir():
                raise IngestError(f"local source directory not found: {opts.local_dir}")
            files = _discover_local(Path(opts.local_dir))
            for f in files:
                if f.kind != "media" or opts.media == "all":
                    f.sha256 = sha256_file(Path(opts.local_dir) / f.path)
            ctx["files"] = files
            ctx["revision"] = None
        elif opts.source == "hf":
            c = client or HFDatasetClient(opts.repo_id, endpoint=settings.hf_endpoint,
                                          token=settings.hf_token.get_secret_value() if settings.hf_token else None)
            ctx["client"] = c
            sha, files = _discover_hf(c, opts.revision)
            ctx["files"] = files
            ctx["revision"] = sha
        else:
            raise IngestError(f"unknown source {opts.source!r}")
        kinds = Counter(f.kind for f in ctx["files"])
        return {"files": len(ctx["files"]), "by_kind": dict(kinds), "revision": ctx["revision"]}

    st.run("discover", discover)

    def lock() -> dict:
        files: list[FileRec] = ctx["files"]
        entries = []
        for f in files:
            d = f.sha256 or (f.expected[1] if f.expected else f"size:{f.size}")
            entries.append((f.path, d))
        ctx["input_digest"] = tree_digest(entries)
        synthetic = any(f.kind == "marker" for f in files)
        bench = "fixture-synthetic" if synthetic else opts.benchmark
        rev = ctx["revision"][:12] if ctx["revision"] else f"local-{ctx['input_digest'][:12]}"
        ctx["synthetic"] = synthetic
        ctx["dv_id"] = f"{bench}@{rev}+n{NORMALIZER_VERSION.split('/')[-1]}"
        return {"dataset_version_id": ctx["dv_id"], "input_digest": ctx["input_digest"], "synthetic": synthetic}

    st.run("lock", lock)
    dv_id = ctx["dv_id"]
    root = settings.datasets_dir / dv_id
    private_root = settings.private_dir / dv_id
    existing = root / "version.json"
    if existing.is_file():
        info = json.loads(existing.read_text())
        if info.get("input_digest") != ctx["input_digest"]:
            raise IngestError(f"{dv_id} already exists with different inputs; refusing to replace it")
        return IngestResult(dv_id, "already_ingested", str(root), st.records, info.get("summary", {}))
    if root.exists():
        shutil.rmtree(root)  # an earlier attempt died before writing version.json: rebuild from scratch
    if private_root.exists():
        shutil.rmtree(private_root)
    (root / "raw").mkdir(parents=True)
    private_root.mkdir(parents=True, mode=0o700)

    # ---- inventory + estimate ------------------------------------------------------------------------
    def inventory() -> dict:
        by: dict[str, dict] = defaultdict(lambda: {"files": 0, "bytes": 0})
        for f in ctx["files"]:
            by[f.kind]["files"] += 1
            by[f.kind]["bytes"] += f.size
        media_dirs = {PurePosixPath(f.path).parts[4] for f in ctx["files"] if f.kind == "media" and len(PurePosixPath(f.path).parts) > 5}
        inv = {"by_kind": dict(by), "total_bytes": sum(f.size for f in ctx["files"]), "media_dirs": len(media_dirs)}
        atomic_write_json(root / "reports" / "inventory.json", inv)
        return inv

    inv = st.run("inventory", inventory)

    def estimate() -> dict:
        meta = sum(v["bytes"] for k, v in inv["by_kind"].items() if k != "media")
        media = inv["by_kind"].get("media", {}).get("bytes", 0)
        want_media = media if opts.media == "all" else 0
        if settings.storage_limit_bytes is not None and meta + want_media > settings.storage_limit_bytes:
            raise IngestError(f"planned transfer {meta + want_media} B exceeds storage limit {settings.storage_limit_bytes} B")
        free = shutil.disk_usage(settings.var_dir if settings.var_dir.exists() else settings.var_dir.parent).free
        if meta + want_media > free:
            raise IngestError(f"planned transfer {meta + want_media} B exceeds free disk {free} B")
        return {"metadata_bytes": meta, "media_bytes_available": media, "media_bytes_planned": want_media,
                "media_mode": opts.media, "free_disk_bytes": free}

    st.run("estimate", estimate)

    # ---- transfer ------------------------------------------------------------------------------------
    store = LocalMediaStore(settings.media_dir)

    def place(f: FileRec, src: Path) -> None:
        if f.kind == "label_file":
            dst = private_root / "labels" / f.path
        elif f.kind == "media":
            return
        elif f.kind == "marker":
            dst = root / "raw" / f.path
        else:
            dst = root / "raw" / f.path
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copyfile(src, dst)
        if f.kind == "label_file":
            os.chmod(dst, 0o600)

    def transfer() -> dict:
        files: list[FileRec] = ctx["files"]
        meta_files = [f for f in files if f.kind != "media"]
        media_files = [f for f in files if f.kind == "media"]
        if opts.max_media_files is not None:
            media_files = media_files[: opts.max_media_files]
        materialized: dict[str, str] = {}
        failures: list[dict] = []
        if opts.source == "local":
            base = Path(opts.local_dir)
            for f in meta_files:
                place(f, base / f.path)
            if opts.media == "all":
                for f in media_files:
                    materialized[f.path] = store.put_file(base / f.path)
        else:
            c: HFDatasetClient = ctx["client"]
            dl_root = settings.private_dir / "downloads" / f"{opts.repo_id.replace('/', '__')}@{ctx['revision']}"
            entries = [TreeEntry(f.path, f.size, f.expected[1] if f.expected and f.expected[0] == "git-blob-sha1" else None,
                                 f.expected[1] if f.expected and f.expected[0] == "sha256" else None) for f in meta_files]
            plan = c.plan(ctx["revision"], entries, dl_root)
            outcomes = c.download(plan, dl_root, concurrency=settings.download_concurrency,
                                  storage_limit_bytes=settings.storage_limit_bytes)
            failures += [asdict(o) for o in outcomes if o.status == "failed"]
            if failures:
                raise IngestError(f"{len(failures)} metadata files failed to download: {failures[:3]}")
            for f in meta_files:
                place(f, dl_root / f.path)
            if opts.media == "all":
                m_entries = [TreeEntry(f.path, f.size, f.expected[1] if f.expected and f.expected[0] == "git-blob-sha1" else None,
                                       f.expected[1] if f.expected and f.expected[0] == "sha256" else None) for f in media_files]
                plan = c.plan(ctx["revision"], m_entries, dl_root)
                for o in c.download(plan, dl_root, concurrency=settings.download_concurrency,
                                    storage_limit_bytes=settings.storage_limit_bytes):
                    if o.status == "failed":
                        failures.append(asdict(o))
                for f in media_files:
                    p = dl_root / f.path
                    if p.is_file():
                        materialized[f.path] = store.put_file(p)
        ctx["materialized"] = materialized
        ctx["media_failures"] = failures
        return {"metadata_files": len(meta_files), "media_materialized": len(materialized), "media_failures": len(failures)}

    st.run("transfer", transfer)

    # ---- parse, quarantine, normalize ----------------------------------------------------------------
    def normalize() -> dict:
        raw = root / "raw"
        md_dir, js_dir = raw / "sandbox" / "data" / "markdowns", raw / "sandbox" / "data" / "jsons"
        md_ids = {p.stem for p in md_dir.glob("*.md")} if md_dir.is_dir() else set()
        js_ids = {p.stem for p in js_dir.glob("*.json")} if js_dir.is_dir() else set()
        quarantine = root / "quarantine"
        examples, recordings, steps_by_rec = [], {}, {}
        qcount: Counter = Counter()
        md_checks: Counter = Counter()
        for tid in sorted(md_ids | js_ids):
            jp, mp = js_dir / f"{tid}.json", md_dir / f"{tid}.md"
            src = {}
            if jp.is_file():
                src["json"] = {"path": jp.relative_to(raw).as_posix(), "sha256": sha256_file(jp)}
            if mp.is_file():
                src["markdown"] = {"path": mp.relative_to(raw).as_posix(), "sha256": sha256_file(mp)}
            if not jp.is_file():
                qcount["json_missing"] += 1
                atomic_write_json(quarantine / f"{tid}.json", {"trajectory_id": tid, "code": "json_missing",
                                                               "detail": "Markdown present without structured JSON", "source_files": src})
                continue
            try:
                obj = json.loads(jp.read_text(encoding="utf-8"))
                t = parse_trajectory(obj)
                if t.trajectory_id != tid:
                    raise SchemaError("id_filename_mismatch", f"file {tid}.json declares {t.trajectory_id}")
            except (json.JSONDecodeError, SchemaError, UnicodeDecodeError) as exc:
                code = getattr(exc, "code", "invalid_json")
                qcount[code] += 1
                atomic_write_json(quarantine / f"{tid}.json", {"trajectory_id": tid, "code": code, "detail": str(exc)[:500],
                                                               "source_files": src})
                continue
            ex, rec, steps = normalize_example(t, dv_id, src)
            if mp.is_file():
                md_text = mp.read_text(encoding="utf-8")
                regenerated = render_markdown(obj)
                parsed = parse_markdown(md_text)
                check = {"regenerated_byte_identical": regenerated == md_text,
                         "goal_matches_instruction": (parsed.goal or "") == t.instruction.strip(),
                         "step_count_matches": len(parsed.steps) == len(t.steps),
                         "problems": parsed.problems}
                if len(parsed.steps) == len(t.steps):
                    check["action_text_mismatches"] = sum(1 for a, b in zip(parsed.steps, steps, strict=True) if a.action_text != b.action_text)
                    check["image_link_mismatches"] = sum(1 for a, b in zip(parsed.steps, steps, strict=True)
                                                         if (a.image_targets[:1] or [None])[0] != b.screenshot_ref)
                ex.source_files["markdown_check"] = check
                md_checks["identical" if check["regenerated_byte_identical"] else "differs"] += 1
            else:
                ex.issues.append("markdown_missing")
                md_checks["markdown_missing"] += 1
            examples.append(ex)
            if rec.recording_id not in recordings:
                recordings[rec.recording_id] = rec
                steps_by_rec[rec.recording_id] = steps
        write_jsonl(root / "normalized" / "examples.jsonl", [e.to_dict() for e in examples])
        write_jsonl(root / "normalized" / "recordings.jsonl", [asdict(r) for r in recordings.values()])
        for rid, steps in steps_by_rec.items():
            atomic_write_json(root / "normalized" / "steps" / f"{rid}.json", [asdict(s) for s in steps], indent=None)
        ctx["examples"] = examples
        ctx["steps_by_rec"] = steps_by_rec
        return {"examples": len(examples), "recordings": len(recordings), "quarantined": dict(qcount),
                "markdown_regeneration": dict(md_checks)}

    st.run("normalize", normalize)

    # ---- assets ---------------------------------------------------------------------------------------
    def index_assets() -> dict:
        expected = {f.path[len(MEDIA_PREFIX):]: f for f in ctx["files"] if f.kind == "media"}
        refs: dict[str, int] = Counter()
        for steps in ctx["steps_by_rec"].values():
            for s in steps:
                if s.asset_key:
                    refs[s.asset_key] += 1
        rows = []
        status_count: Counter = Counter()
        for key in sorted(set(refs) | set(expected)):
            f = expected.get(key)
            digest = ctx["materialized"].get(MEDIA_PREFIX + key)
            row = {"asset_key": key, "released_path": MEDIA_PREFIX + key, "referenced_by_steps": refs.get(key, 0),
                   "expected_bytes": f.size if f else None,
                   "expected_digest": list(f.expected) if f and f.expected else None,
                   "sha256": digest, "status": "materialized" if digest else ("missing_from_release" if f is None else "not_materialized")}
            if digest:
                facts = inspect_image(store.path(digest))
                row.update(width=facts.width, height=facts.height, format=facts.format, bytes=facts.bytes)
                if facts.error:
                    row["status"] = "corrupt"
                    row["error"] = facts.error
            status_count[row["status"]] += 1
            rows.append(row)
        write_jsonl(root / "normalized" / "assets.jsonl", rows)
        unreferenced = sum(1 for k in expected if k not in refs)
        return {"assets": len(rows), "by_status": dict(status_count), "unreferenced_release_files": unreferenced}

    assets_summary = st.run("index_assets", index_assets)

    # ---- private labels + grouping -------------------------------------------------------------------
    def labels() -> dict:
        label_dir = private_root / "labels"
        files = sorted(label_dir.glob("*.jsonl")) if label_dir.is_dir() else []
        gold: dict[str, dict] = {}
        membership: dict[str, list[str]] = defaultdict(list)
        problems: Counter = Counter()
        conflicts = []
        for lf in files:
            with open(lf, encoding="utf-8") as fh:
                for n, line in enumerate(fh, 1):
                    if not line.strip():
                        continue
                    try:
                        lab = parse_label(json.loads(line))
                    except (json.JSONDecodeError, SchemaError) as exc:
                        problems[getattr(exc, "code", "invalid_json")] += 1
                        continue
                    membership[lf.name].append(lab.trajectory_id)
                    cat, cat_status = normalize_native(lab.mistake_type_native) if lab.label == "negative" else (None, "n/a")
                    row = {"example_id": lab.trajectory_id, "label": lab.label, "mistake_type_native": lab.mistake_type_native,
                           "category": cat.value if cat else None, "category_status": cat_status,
                           "original_id": lab.original_id, "paired_id": lab.paired_id, "negative_source": lab.negative_source,
                           "trajectory_scenario": lab.trajectory_scenario, "trajectory_type": lab.trajectory_type,
                           "label_file": lf.name, "line": n, "unknown_fields": lab.unknown_fields, "issues": lab.issues}
                    if cat_status == "unrecognized":
                        problems["unrecognized_mistake_type"] += 1
                    prev = gold.get(lab.trajectory_id)
                    if prev is not None:
                        conflicts.append({"example_id": lab.trajectory_id, "files": [prev["label_file"], lf.name],
                                          "same_label": prev["label"] == lab.label})
                        continue
                    gold[lab.trajectory_id] = row
        write_jsonl(private_root / "gold_labels.jsonl", sorted(gold.values(), key=lambda r: r["example_id"]))
        os.chmod(private_root / "gold_labels.jsonl", 0o600)
        label_files = [{"name": lf.name, "sha256": sha256_file(lf), "rows": len(membership[lf.name])} for lf in files]
        atomic_write_json(private_root / "label_files.json", label_files)
        lc = label_components([{"example_id": k, "label": v["label"], "original_id": v["original_id"],
                                "paired_id": v["paired_id"]} for k, v in gold.items()])
        ex_rows = [{"example_id": e.example_id, "recording_id": e.recording_id, "instruction_id": e.instruction_id}
                   for e in ctx["examples"]]
        cc = content_components(ex_rows)
        by_ex = {e["example_id"]: e for e in ex_rows}
        grouping_rows = []
        for eid in sorted(set(by_ex) | set(gold)):
            g = {"example_id": eid, **lc.get(eid, {}), "content_component_id": cc.get(eid)}
            if eid in by_ex:
                g.update(recording_id=by_ex[eid]["recording_id"], instruction_id=by_ex[eid]["instruction_id"])
            grouping_rows.append(g)
        write_jsonl(private_root / "grouping.jsonl", grouping_rows)
        ctx["gold"] = gold
        ctx["membership"] = membership
        ctx["label_conflicts"] = conflicts
        ids_with_label_ids = sum(1 for v in gold.values() if v["original_id"])
        return {"label_files": label_files, "gold_rows": len(gold), "conflicts": len(conflicts), "problems": dict(problems),
                "label_grouping_available": ids_with_label_ids > 0,
                "component_sizes": size_distribution({k: v.get("component_id") for k, v in lc.items()}),
                "content_component_sizes": size_distribution(cc)}

    lab_summary = st.run("labels", labels)

    # ---- manifests -----------------------------------------------------------------------------------
    def manifests() -> dict:
        out = []
        all_ids = sorted(e.example_id for e in ctx["examples"])
        out.append(Manifest(f"{dv_id}:full-release", "Full release (all normalized examples)", dv_id, "full-release",
                            "evaluation", not ctx["synthetic"], all_ids,
                            {"procedure": "all examples with valid structured trajectories"},
                            ["Quarantined records are excluded and listed in reports/validation.json."]))
        for fname, ids in sorted(ctx["membership"].items()):
            if fname in LEGACY_LABEL_FILES:
                mid, name = LEGACY_LABEL_FILES[fname]
                out.append(Manifest(f"{dv_id}:{mid}", name, dv_id, "legacy-submitted", "evaluation", not ctx["synthetic"],
                                    sorted(ids), {"procedure": "membership of released label file", "label_file": fname},
                                    ["LEGACY partition (605/768 in the release). Not the revised paper partition."]))
            else:
                out.append(Manifest(f"{dv_id}:labelfile:{fname}", f"Label file {fname} (unclassified)", dv_id,
                                    "unclassified-label-file", "subset", False, sorted(ids),
                                    {"procedure": "membership of an unrecognized label file", "label_file": fname},
                                    ["Requires operator classification; never auto-declared official."]))
        for m in out:
            atomic_write_json(root / "manifests" / f"{m.manifest_id.replace(':', '__').replace('/', '_')}.json", m.to_dict())
        return {"manifests": [{"id": m.manifest_id, "n": len(m.example_ids), "partition": m.partition} for m in out]}

    man_summary = st.run("manifests", manifests)

    # ---- validate + reconcile + report ---------------------------------------------------------------
    from agenthorizon.data.validate import reconcile, validate_version

    val = st.run("validate", lambda: validate_version(root, private_root, ctx))
    rec = st.run("reconcile", lambda: reconcile(root, private_root, ctx))

    media_total = assets_summary["by_status"]
    summary = {
        "examples": len(ctx["examples"]),
        "recordings": len(ctx["steps_by_rec"]),
        "gold_labels": lab_summary["gold_rows"],
        "manifests": man_summary["manifests"],
        "media": media_total,
        "validation_errors": val.get("error_count"),
        "validation_warnings": val.get("warning_count"),
        "reconciliation_failures": rec.get("failures"),
    }
    n_assets = sum(media_total.values()) or 0
    mat = media_total.get("materialized", 0)
    status = "complete" if n_assets and mat == n_assets else ("metadata_complete_media_partial" if mat else "metadata_complete_media_none")
    version = {
        "dataset_version_id": dv_id,
        "benchmark": "fixture-synthetic" if ctx["synthetic"] else opts.benchmark,
        "synthetic": ctx["synthetic"],
        "source": {"kind": opts.source, "repo_id": opts.repo_id if opts.source == "hf" else None,
                   "revision": ctx["revision"], "local_dir": str(opts.local_dir) if opts.local_dir else None},
        "input_digest": ctx["input_digest"],
        "normalizer_version": NORMALIZER_VERSION,
        "category_map": CATEGORY_MAP_VERSION,
        "created_at": utcnow_iso(),
        "status_at_creation": status,
        "summary": summary,
    }
    atomic_write_json(root / "reports" / "ingest.json", {"stages": st.records, "summary": summary})
    atomic_write_json(root / "version.json", version)  # written last: marks the version complete
    return IngestResult(dv_id, "ingested", str(root), st.records, summary)
