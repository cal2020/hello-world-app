import hashlib
import json
import os
import pathlib
import subprocess
import time
import uuid

CODE_ROOT = pathlib.Path(__file__).resolve().parent.parent


def canonical_json(obj) -> bytes:
    """Deterministic JSON bytes used for digests and request fingerprints."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256(data) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def digest(obj) -> str:
    return sha256(canonical_json(obj))


def now() -> str:
    t = time.time()  # one clock read: seconds and milliseconds must come from the same instant
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + f".{int(t * 1000) % 1000:03d}Z"


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def code_version() -> str:
    """Revision of the running code, recorded in release manifests. A deployed image has no git, so the
    revision set at build or deploy time wins: LWB_CODE_VERSION, then Railway's RAILWAY_GIT_COMMIT_SHA.
    Otherwise the git revision of this checkout, with a dirty marker."""
    if os.environ.get("LWB_CODE_VERSION"):
        return os.environ["LWB_CODE_VERSION"]
    if os.environ.get("RAILWAY_GIT_COMMIT_SHA"):
        return os.environ["RAILWAY_GIT_COMMIT_SHA"][:12]
    try:
        rev = subprocess.run(["git", "rev-parse", "--short=12", "HEAD"], capture_output=True, text=True,
                             timeout=5, cwd=CODE_ROOT).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "."], capture_output=True, text=True,
                               timeout=5, cwd=CODE_ROOT).stdout.strip()
        return f"{rev}{'+dirty' if dirty else ''}" if rev else "unknown"
    except Exception:
        return "unknown"


class ApiError(Exception):
    """An error with a stable machine-readable code, mapped to an HTTP status by the server."""

    def __init__(self, status: int, code: str, message: str, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}

    def body(self):
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}
