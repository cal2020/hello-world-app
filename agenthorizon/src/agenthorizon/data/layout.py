"""Explicit adapter between on-disk dataset layouts and the judge workspace layout.

Released dataset (S3 README):          Judge workspace (official prompt, S2):
  sandbox/data/markdowns/<id>.md   ->    agenthorizon_md/<id>.md
  sandbox/data/jsons/<id>.json     ->    agenthorizon_json/<id>.json
  sandbox/data/media/images/...    ->    data/media/images/...   (unchanged relative path)

Markdown image links are *working-directory-relative* (the prompt says so explicitly:
"local relative paths in your working directory"). The workspace root is the judge's CWD, so links resolve
without rewriting. Every staged path, alias, and (in opaque mode) rewritten link is recorded in a staging
manifest and validated: each link must resolve inside the workspace, and staged image bytes must hash
identically to the source.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath

from agenthorizon.data.markdown import image_targets

HARNESS_MD_DIR = "agenthorizon_md"
HARNESS_JSON_DIR = "agenthorizon_json"
HARNESS_IMAGES_DIR = "data/media/images"


@dataclass
class LayoutInfo:
    kind: str  # hf-release | harness-template | standard-jsonl | unknown
    root: Path
    md_dir: Path | None = None
    json_dir: Path | None = None
    images_dir: Path | None = None
    cwd_root: Path | None = None  # directory against which Markdown links resolve
    label_files: list[Path] = field(default_factory=list)
    standard_jsonl: list[Path] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        return {k: (str(v) if isinstance(v, Path) else [str(x) for x in v] if isinstance(v, list) and v and isinstance(v[0], Path) else v)
                for k, v in d.items()}


def detect_layout(root: Path) -> LayoutInfo:
    root = Path(root)
    if (root / "sandbox" / "data" / "markdowns").is_dir() or (root / "sandbox" / "data" / "jsons").is_dir():
        sb = root / "sandbox"
        info = LayoutInfo("hf-release", root, sb / "data" / "markdowns", sb / "data" / "jsons", sb / "data" / "media" / "images", sb)
        info.label_files = sorted(p for p in root.glob("*.jsonl"))
        if not (sb / "data" / "media" / "images").is_dir():
            info.notes.append("media directory absent (lazy media materialization required)")
        return info
    if (root / HARNESS_MD_DIR).is_dir():
        return LayoutInfo("harness-template", root, root / HARNESS_MD_DIR, root / HARNESS_JSON_DIR, root / HARNESS_IMAGES_DIR, root)
    std = sorted((root / "data" / "standard").glob("*.jsonl")) if (root / "data" / "standard").is_dir() else []
    if std:
        trajs = [p for p in std if "label" not in p.name]
        labels = [p for p in std if "label" in p.name]
        return LayoutInfo("standard-jsonl", root, None, None, root / "data" / "media" / "images", root,
                          label_files=labels, standard_jsonl=trajs)
    return LayoutInfo("unknown", root, notes=["no recognised layout"])


_SAFE = re.compile(r"^[A-Za-z0-9._\-/]+$")


def safe_relative(target: str) -> PurePosixPath | None:
    """Normalise a CWD-relative link; None if absolute, URL, or escaping the root."""
    if not target or target.startswith(("http://", "https://", "/", "file:")):
        return None
    p = PurePosixPath(target)
    parts = [x for x in p.parts if x not in (".",)]
    if any(x == ".." for x in parts) or not parts:
        return None
    if not _SAFE.match("/".join(parts)):
        return None
    return PurePosixPath(*parts)


@dataclass
class StagedFile:
    workspace_path: str
    source_path: str | None  # released relative path (or media-store key)
    kind: str  # markdown | json | image | prompt | instructions
    sha256: str | None = None
    rewritten: bool = False


@dataclass
class StagingPlan:
    example_id: str
    mode: str  # paper-paths | opaque-paths
    files: list[StagedFile] = field(default_factory=list)
    aliases: list[dict] = field(default_factory=list)
    link_rewrites: list[dict] = field(default_factory=list)
    unresolved_links: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def opaque_token(secret: bytes, example_id: str, media_dir: str) -> str:
    """Per-task opaque directory name; stable within a run, unlinkable across tasks without the secret."""
    return "rec-" + hmac.new(secret, f"{example_id}\0{media_dir}".encode(), hashlib.sha256).hexdigest()[:16]


def rewrite_media_links(text: str, mapping: dict[str, str]) -> tuple[str, list[dict]]:
    """Replace ``data/media/images/<dir>/`` prefixes per mapping (exact path-segment match only)."""
    rewrites: list[dict] = []

    def sub(m: re.Match) -> str:
        old = m.group(0)
        d = m.group("dir")
        if d not in mapping:
            return old
        new = old.replace(f"/images/{d}/", f"/images/{mapping[d]}/", 1)
        rewrites.append({"from": old, "to": new})
        return new

    out = re.sub(r"(?:\./)?data/media/images/(?P<dir>[^/\s)\"']+)/", sub, text)
    return out, rewrites


def media_dirs_referenced(md_text: str | None, json_obj: dict | None) -> list[str]:
    dirs: list[str] = []
    targets = image_targets(md_text or "")
    if json_obj:
        targets += [s.get("screenshot") or "" for s in json_obj.get("steps", []) if isinstance(s, dict)]
    for t in targets:
        p = safe_relative(t or "")
        if p and len(p.parts) >= 5 and p.parts[:3] == ("data", "media", "images"):
            if p.parts[3] not in dirs:
                dirs.append(p.parts[3])
    return dirs


def build_staging_plan(
    example_id: str,
    md_text: str | None,
    json_obj: dict | None,
    *,
    mode: str = "paper-paths",
    secret: bytes = b"",
) -> tuple[StagingPlan, str | None, dict | None]:
    """Return the plan plus the (possibly rewritten) Markdown text and JSON object to stage."""
    plan = StagingPlan(example_id=example_id, mode=mode)
    mapping: dict[str, str] = {}
    if mode == "opaque-paths":
        if not secret:
            raise ValueError("opaque-paths staging requires a per-run secret")
        mapping = {d: opaque_token(secret, example_id, d) for d in media_dirs_referenced(md_text, json_obj)}
    elif mode != "paper-paths":
        raise ValueError(f"unknown staging mode {mode!r}")

    out_md = md_text
    out_json = json_obj
    if md_text is not None:
        if mapping:
            out_md, rw = rewrite_media_links(md_text, mapping)
            plan.link_rewrites += [{"file": "markdown", **r} for r in rw]
        plan.files.append(StagedFile(f"{HARNESS_MD_DIR}/{example_id}.md", f"markdowns/{example_id}.md", "markdown",
                                     rewritten=bool(mapping)))
    if json_obj is not None:
        if mapping:
            text, rw = rewrite_media_links(json.dumps(json_obj, ensure_ascii=False), mapping)
            out_json = json.loads(text)
            plan.link_rewrites += [{"file": "json", **r} for r in rw]
        plan.files.append(StagedFile(f"{HARNESS_JSON_DIR}/{example_id}.json", f"jsons/{example_id}.json", "json",
                                     rewritten=bool(mapping)))

    seen: set[str] = set()
    targets = image_targets(out_md or "")
    if out_json:
        targets += [s.get("screenshot") or "" for s in out_json.get("steps", []) if isinstance(s, dict)]
    inverse = {v: k for k, v in mapping.items()}
    for t in targets:
        p = safe_relative(t or "")
        if p is None:
            if t:
                plan.unresolved_links.append(t)
            continue
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        if p.parts[:3] != ("data", "media", "images"):
            plan.unresolved_links.append(t)
            continue
        src_parts = list(p.parts)
        if src_parts[3] in inverse:
            src_parts[3] = inverse[src_parts[3]]
        plan.files.append(StagedFile(key, "/".join(src_parts[3:]), "image"))
    return plan, out_md, out_json
