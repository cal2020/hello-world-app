"""Per-task judge workspace staging.

One fresh workspace per attempt, containing only: this example's released Markdown and JSON (under the names the
official prompt uses), the screenshots those files reference, the prompt file, and — when registered — the
harness instruction files. Inputs are byte-identical copies in ``paper-paths`` mode; ``opaque-paths`` mode
renames recording directories with per-task tokens and records every rewritten link. Staged images are
verified by SHA-256 against the media store.

This module deliberately has no access to gold labels or pair mappings (it never imports ``PrivateStore``).
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

from agenthorizon.data.dataset import DatasetVersion
from agenthorizon.data.layout import HARNESS_JSON_DIR, HARNESS_MD_DIR, build_staging_plan, rewrite_media_links
from agenthorizon.data.materialize import current_assets
from agenthorizon.data.media import LocalMediaStore
from agenthorizon.judging.prompts import PromptRevision
from agenthorizon.util.hashing import digest_json, sha256_file
from agenthorizon.util.io import atomic_write_json

READONLY_INPUTS = [HARNESS_MD_DIR, HARNESS_JSON_DIR, "data", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "prompt.md"]


class StagingError(RuntimeError):
    pass


@dataclass
class StagedWorkspace:
    task_dir: Path
    workspace: Path
    example_id: str
    mode: str
    files: list[dict] = field(default_factory=list)
    link_rewrites: list[dict] = field(default_factory=list)
    unresolved_links: list[str] = field(default_factory=list)
    missing_media: list[str] = field(default_factory=list)
    instructions: dict | None = None
    deviations: list[str] = field(default_factory=list)
    manifest_digest: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["task_dir"], d["workspace"] = str(self.task_dir), str(self.workspace)
        return d


def stage_workspace(
    dv: DatasetVersion,
    store: LocalMediaStore,
    example_id: str,
    task_dir: Path,
    *,
    prompt: PromptRevision,
    instructions: PromptRevision | None,
    mode: str = "paper-paths",
    secret: bytes = b"",
) -> StagedWorkspace:
    ws = task_dir / "workspace"
    if ws.exists() and any(ws.iterdir()):
        raise StagingError(f"workspace {ws} is not fresh")
    ws.mkdir(parents=True, exist_ok=True)
    ex = dv.example(example_id)
    md_rel = ex["source_files"].get("markdown")
    js_rel = ex["source_files"].get("json")
    md_text = (dv.root / "raw" / md_rel["path"]).read_text(encoding="utf-8") if md_rel else None
    js_raw = (dv.root / "raw" / js_rel["path"]).read_text(encoding="utf-8") if js_rel else None
    plan, out_md, _ = build_staging_plan(example_id, md_text, json.loads(js_raw) if js_raw else None, mode=mode, secret=secret)
    st = StagedWorkspace(task_dir, ws, example_id, mode, link_rewrites=plan.link_rewrites,
                         unresolved_links=plan.unresolved_links)
    st.deviations.append("one trajectory per workspace (authors' sandbox exposed every trajectory to each judge)")

    mapping = {}
    for r in plan.link_rewrites:
        a, b = r["from"].split("/images/")[1].split("/")[0], r["to"].split("/images/")[1].split("/")[0]
        mapping[a] = b
    if md_text is not None:
        p = ws / HARNESS_MD_DIR / f"{example_id}.md"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(out_md if mapping else md_text, encoding="utf-8")
        st.files.append({"path": f"{HARNESS_MD_DIR}/{example_id}.md", "kind": "markdown", "sha256": sha256_file(p),
                         "source_sha256": md_rel["sha256"], "rewritten": bool(mapping)})
    if js_raw is not None:
        p = ws / HARNESS_JSON_DIR / f"{example_id}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        text = rewrite_media_links(js_raw, mapping)[0] if mapping else js_raw
        p.write_text(text, encoding="utf-8")
        st.files.append({"path": f"{HARNESS_JSON_DIR}/{example_id}.json", "kind": "json", "sha256": sha256_file(p),
                         "source_sha256": js_rel["sha256"], "rewritten": bool(mapping)})

    assets = current_assets(dv)
    for f in plan.files:
        if f.kind != "image":
            continue
        a = assets.get(f.source_path or "")
        if not a or a.get("status") != "materialized" or not a.get("sha256"):
            st.missing_media.append(f.source_path or f.workspace_path)
            continue
        dst = ws / f.workspace_path
        store.stage(a["sha256"], dst)
        st.files.append({"path": f.workspace_path, "kind": "image", "sha256": a["sha256"], "source": f.source_path,
                         "pixels_verified": sha256_file(dst) == a["sha256"]})

    (ws / "prompt.md").write_text(prompt.text)
    st.files.append({"path": "prompt.md", "kind": "prompt", "sha256": sha256_file(ws / "prompt.md"), "prompt_id": prompt.prompt_id})
    if instructions is not None:
        (ws / "AGENTS.md").write_text(instructions.text)
        for alias in ("CLAUDE.md", "GEMINI.md"):
            os.symlink("AGENTS.md", ws / alias)
        st.instructions = {"prompt_id": instructions.prompt_id, "sha256": instructions.sha256,
                           "paper_mode": instructions.paper_mode, "aliases": ["CLAUDE.md -> AGENTS.md", "GEMINI.md -> AGENTS.md"]}
    for root, dirs, files in os.walk(ws):
        for d in dirs:
            os.chmod(Path(root) / d, 0o555)
        for fn in files:
            p = Path(root) / fn
            if not p.is_symlink():
                os.chmod(p, 0o444)
    os.chmod(ws, 0o755)  # the workspace root stays writable for scratch files; inputs are mounted read-only
    st.manifest_digest = digest_json(sorted((f["path"], f["sha256"]) for f in st.files))
    atomic_write_json(task_dir / "staging.json", st.to_dict())
    return st
