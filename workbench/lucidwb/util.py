import hashlib
import json
import subprocess
import time
import uuid


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
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def code_version() -> str:
    """Git revision of the running code, with a dirty marker. Recorded in release manifests."""
    try:
        rev = subprocess.run(["git", "rev-parse", "--short=12", "HEAD"], capture_output=True, text=True,
                             timeout=5).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "."], capture_output=True, text=True,
                               timeout=5).stdout.strip()
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
