"""In-process fake of the Hugging Face Hub HTTP API over a local directory, with fault injection.

Used only by tests to exercise the real HF client code paths (revision resolution, paginated tree listing,
LFS sha256 vs git-blob checksums, Range resume, retries) without network access. Serves whatever directory it
is given — in tests, the synthetic fixture.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import httpx

FAKE_SHA = "f" * 8 + "0123456789abcdef0123456789abcdef"


def git_blob_sha1(data: bytes) -> str:
    h = hashlib.sha1(usedforsecurity=False)
    h.update(f"blob {len(data)}\0".encode())
    h.update(data)
    return h.hexdigest()


class _FailingStream(httpx.SyncByteStream):
    def __init__(self, data: bytes, fail_after: int):
        self.data, self.fail_after = data, fail_after

    def __iter__(self):
        yield self.data[: self.fail_after]
        raise httpx.ReadError("simulated connection drop")


class FakeHub:
    def __init__(self, root: Path, repo_id: str = "ServiceNow/AgentHorizon", page_size: int = 50,
                 lfs_suffixes: tuple[str, ...] = (".png",), deny_all: bool = False):
        self.root = Path(root)
        self.repo_id = repo_id
        self.page_size = page_size
        self.lfs_suffixes = lfs_suffixes
        self.deny_all = deny_all
        self.faults: dict[str, list[str]] = defaultdict(list)  # path -> queue of "503" | "drop" | "corrupt" | "404"
        self.requests: list[tuple[str, str, dict]] = []

    def files(self) -> list[Path]:
        return sorted(p for p in self.root.rglob("*") if p.is_file())

    def _entry(self, p: Path) -> dict:
        data = p.read_bytes()
        rel = p.relative_to(self.root).as_posix()
        e = {"type": "file", "path": rel, "size": len(data), "oid": git_blob_sha1(data)}
        if p.suffix in self.lfs_suffixes:
            e["lfs"] = {"oid": hashlib.sha256(data).hexdigest(), "size": len(data), "pointerSize": 132}
            e["oid"] = git_blob_sha1(f"version https://git-lfs.github.com/spec/v1\noid sha256:{e['lfs']['oid']}\n".encode())
        return e

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = urlparse(str(request.url))
        path = unquote(url.path)
        self.requests.append((request.method, path, dict(request.headers)))
        if self.deny_all:
            raise httpx.ProxyError("403 Forbidden (simulated egress policy denial)")
        api = f"/api/datasets/{self.repo_id}"
        if path in (f"{api}/revision/main", f"{api}/revision/{FAKE_SHA}", api):
            return httpx.Response(200, json={"id": self.repo_id, "sha": FAKE_SHA, "lastModified": "2026-10-08T00:00:00.000Z",
                                             "cardData": {"license": "test-fixture-only"}, "tags": ["synthetic"]})
        if path == f"{api}/refs":
            return httpx.Response(200, json={"branches": [{"name": "main", "ref": "refs/heads/main", "targetCommit": FAKE_SHA}],
                                             "tags": [], "converts": []})
        if path.startswith(f"{api}/commits/"):
            return httpx.Response(200, json=[{"id": FAKE_SHA, "title": "synthetic fixture", "date": "2026-10-08T00:00:00Z"}])
        m = re.match(rf"^{re.escape(api)}/tree/([^/]+)/?(.*)$", path)
        if m:
            if m.group(1) not in ("main", FAKE_SHA):
                return httpx.Response(404, json={"error": "revision not found"})
            qs = parse_qs(url.query)
            start = int(qs.get("cursor", ["0"])[0])
            entries = [self._entry(p) for p in self.files()]
            page = entries[start : start + self.page_size]
            headers = {}
            if start + self.page_size < len(entries):
                nxt = f"https://huggingface.co{api}/tree/{m.group(1)}?recursive=true&expand=true&cursor={start + self.page_size}"
                headers["Link"] = f'<{nxt}>; rel="next"'
            return httpx.Response(200, json=page, headers=headers)
        m = re.match(rf"^/datasets/{re.escape(self.repo_id)}/resolve/([^/]+)/(.+)$", path)
        if m:
            rel = m.group(2)
            p = self.root / rel
            if not p.is_file():
                return httpx.Response(404, text="Entry not found")
            data = p.read_bytes()
            fault = self.faults[rel].pop(0) if self.faults.get(rel) else None
            if fault == "503":
                return httpx.Response(503, text="temporarily unavailable")
            if fault == "404":
                return httpx.Response(404, text="gone")
            if fault == "corrupt":
                return httpx.Response(200, content=b"\x00" * len(data))
            rng = request.headers.get("range")
            status, body = 200, data
            if rng:
                start = int(rng.split("=")[1].split("-")[0])
                status, body = 206, data[start:]
            if fault == "drop":
                return httpx.Response(status, stream=_FailingStream(body, max(1, len(body) // 2)))
            return httpx.Response(status, content=body, headers={"X-Repo-Commit": FAKE_SHA})
        return httpx.Response(404, json={"error": f"unhandled {path}"})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


def write_tree_snapshot(hub: FakeHub, out: Path) -> None:
    out.write_text(json.dumps([hub._entry(p) for p in hub.files()], indent=1))
