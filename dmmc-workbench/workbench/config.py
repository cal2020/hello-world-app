"""Paths and pinned versions. Everything the manifests record comes from here."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"
CATALOG_PATH = FIXTURES / "catalog" / "nist-sp800-53r5-excerpt.json"
MAPPINGS_PATH = FIXTURES / "mappings" / "demo-mappings.json"
POLICY_DIR = FIXTURES / "target-policy"
OSCAL_SCHEMA_PATH = ROOT / "schemas" / "oscal_component_schema_v1.2.3.json"
OSCAL_VERSION = "1.2.3"

ADAPTER_VERSION = "synthetic-json-adapter/0.1"
MODEL_CONTRACT = "dmmc-workbench/model-export"
MODEL_CONTRACT_VERSIONS = {"0.1"}
REVIEW_PROTOCOL = "demo-review-v1"
PROMPT_VERSION = "draft-prompt-v1"
DEMO_ENVIRONMENT = "demo-synthetic"

OPA_VERSION = "1.20.0"
OPA_SHA256 = "4e4c65be08ed27e7375d816d446a444e65ba101806014c7a51b2a7652c2a942a"


def data_dir() -> Path:
    return Path(os.environ.get("DMMC_DATA_DIR", ROOT / "var"))


def db_path() -> Path:
    return data_dir() / "workbench.db"


def exports_dir() -> Path:
    return data_dir() / "exports"


def opa_bin() -> str | None:
    """Locate the pinned OPA binary. None means policy checks report ERROR, never PASS."""
    cand = os.environ.get("OPA_BIN")
    if cand and Path(cand).exists():
        return cand
    local = ROOT / ".tools" / "opa"
    if local.exists():
        return str(local)
    return shutil.which("opa")


def code_digest() -> str:
    """Digest of the workbench source, recorded in every run manifest."""
    from .util import sha256
    h = []
    for p in sorted((ROOT / "workbench").glob("*.py")):
        h.append(p.name + ":" + sha256(p.read_bytes()))
    return sha256("\n".join(h))


def git_revision() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True,
                              text=True, timeout=5).stdout.strip() or "unknown"
    except Exception:
        return "unknown"
