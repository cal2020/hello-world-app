"""Minimal, auditable Hugging Face Hub client for dataset repositories.

Implements exactly what ingestion needs: revision resolution, refs/commit history, recursive tree listing
with sizes and checksums, and resumable, checksum-verified downloads at a pinned revision. The dataset
viewer / auto-generated image-folder configs are deliberately never used as task manifests.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import quote

import httpx

from agenthorizon.util.io import utcnow_iso


class HFError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, url: str | None = None, kind: str = "error"):
        super().__init__(message)
        self.status = status
        self.url = url
        self.kind = kind  # "egress_denied" | "not_found" | "unauthorized" | "http" | "checksum" | "storage"


@dataclass
class TreeEntry:
    path: str
    size: int
    git_oid: str | None  # git blob SHA-1 for regular files
    lfs_sha256: str | None  # sha256 of content for LFS/Xet-backed files
    xet_hash: str | None = None

    @property
    def expected_digest(self) -> tuple[str, str] | None:
        if self.lfs_sha256:
            return ("sha256", self.lfs_sha256)
        if self.git_oid:
            return ("git-blob-sha1", self.git_oid)
        return None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class DownloadOutcome:
    path: str
    status: str  # "downloaded" | "present" | "failed"
    bytes: int = 0
    verified: str | None = None
    error: str | None = None
    attempts: int = 0


@dataclass
class TransferPlan:
    revision: str
    entries: list[TreeEntry]
    missing: list[TreeEntry] = field(default_factory=list)
    present: list[TreeEntry] = field(default_factory=list)

    @property
    def total_bytes(self) -> int:
        return sum(e.size for e in self.entries)

    @property
    def missing_bytes(self) -> int:
        return sum(e.size for e in self.missing)


def git_blob_sha1_file(path: Path) -> str:
    size = path.stat().st_size
    h = hashlib.sha1(usedforsecurity=False)
    h.update(f"blob {size}\0".encode())
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def verify_file(path: Path, entry: TreeEntry) -> str:
    """Return the verification method used, or raise HFError(kind='checksum')."""
    if path.stat().st_size != entry.size:
        raise HFError(f"size mismatch for {entry.path}: {path.stat().st_size} != {entry.size}", kind="checksum")
    exp = entry.expected_digest
    if exp is None:
        return "size-only"
    algo, want = exp
    if algo == "sha256":
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(1 << 20):
                h.update(chunk)
        got = h.hexdigest()
    else:
        got = git_blob_sha1_file(path)
    if got != want:
        raise HFError(f"{algo} mismatch for {entry.path}: {got} != {want}", kind="checksum")
    return algo


class HFDatasetClient:
    def __init__(
        self,
        repo_id: str,
        *,
        endpoint: str = "https://huggingface.co",
        token: str | None = None,
        timeout: float = 120.0,
        transport: httpx.BaseTransport | None = None,
        max_retries: int = 5,
        backoff_base: float = 2.0,
    ):
        self.repo_id = repo_id
        self.endpoint = endpoint.rstrip("/")
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        headers = {"User-Agent": "agenthorizon-ingest/0.1"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client_kwargs = dict(
            headers=headers, timeout=timeout, follow_redirects=True, transport=transport
        )
        self._client = httpx.Client(**self._client_kwargs)

    def close(self) -> None:
        self._client.close()

    # ---- metadata ------------------------------------------------------------------------------
    def _api(self, path: str) -> str:
        return f"{self.endpoint}/api/datasets/{self.repo_id}{path}"

    def _get_json(self, url: str, params: dict | None = None) -> tuple[object, httpx.Response]:
        try:
            r = self._client.get(url, params=params)
        except httpx.ProxyError as exc:
            raise HFError(f"egress proxy refused {url}: {exc}", url=url, kind="egress_denied") from exc
        except httpx.HTTPError as exc:
            raise HFError(f"{type(exc).__name__} for {url}: {exc}", url=url, kind="http") from exc
        if r.status_code == 404:
            raise HFError(f"not found: {url}", status=404, url=url, kind="not_found")
        if r.status_code in (401, 403):
            raise HFError(f"unauthorized ({r.status_code}): {url}", status=r.status_code, url=url, kind="unauthorized")
        if r.status_code >= 400:
            raise HFError(f"HTTP {r.status_code} for {url}: {r.text[:200]}", status=r.status_code, url=url, kind="http")
        return r.json(), r

    def info(self, revision: str | None = None) -> dict:
        path = f"/revision/{quote(revision, safe='')}" if revision else ""
        data, _ = self._get_json(self._api(path))
        assert isinstance(data, dict)
        return data

    def resolve_revision(self, revision: str = "main") -> str:
        sha = self.info(revision).get("sha")
        if not sha:
            raise HFError(f"no sha returned for revision {revision}", kind="http")
        return str(sha)

    def refs(self) -> dict:
        data, _ = self._get_json(self._api("/refs"))
        assert isinstance(data, dict)
        return data

    def commits(self, revision: str = "main") -> list[dict]:
        data, _ = self._get_json(self._api(f"/commits/{quote(revision, safe='')}"))
        return list(data) if isinstance(data, list) else []

    def list_tree(self, revision: str, path: str = "") -> list[TreeEntry]:
        """Recursive listing at a pinned revision, following pagination links."""
        url: str | None = self._api(f"/tree/{quote(revision, safe='')}/{quote(path)}".rstrip("/"))
        params: dict | None = {"recursive": "true", "expand": "true"}
        out: list[TreeEntry] = []
        while url:
            data, resp = self._get_json(url, params=params)
            params = None  # the next link already carries the query
            for item in data if isinstance(data, list) else []:
                if item.get("type") != "file":
                    continue
                lfs = item.get("lfs") or {}
                lfs_oid = lfs.get("oid") or lfs.get("sha256")
                if isinstance(lfs_oid, str) and lfs_oid.startswith("sha256:"):
                    lfs_oid = lfs_oid.split(":", 1)[1]
                out.append(
                    TreeEntry(
                        path=item["path"],
                        size=int(lfs.get("size", item.get("size", 0))),
                        git_oid=None if lfs_oid else item.get("oid"),
                        lfs_sha256=lfs_oid,
                        xet_hash=item.get("xetHash"),
                    )
                )
            url = resp.links.get("next", {}).get("url")
        out.sort(key=lambda e: e.path)
        return out

    def resolve_url(self, revision: str, path: str) -> str:
        return f"{self.endpoint}/datasets/{self.repo_id}/resolve/{quote(revision, safe='')}/{quote(path)}"

    # ---- transfers -----------------------------------------------------------------------------
    def plan(self, revision: str, entries: Iterable[TreeEntry], dest_root: Path) -> TransferPlan:
        plan = TransferPlan(revision=revision, entries=list(entries))
        for e in plan.entries:
            p = dest_root / e.path
            if p.is_file() and p.stat().st_size == e.size:
                plan.present.append(e)
            else:
                plan.missing.append(e)
        return plan

    def download_one(self, revision: str, entry: TreeEntry, dest_root: Path) -> DownloadOutcome:
        dest = dest_root / entry.path
        if dest.is_file():
            try:
                method = verify_file(dest, entry)
                return DownloadOutcome(entry.path, "present", 0, method)
            except HFError:
                dest.unlink()  # corrupt or truncated final file: re-fetch
        dest.parent.mkdir(parents=True, exist_ok=True)
        partial = dest.with_name(dest.name + ".partial")
        url = self.resolve_url(revision, entry.path)
        attempts = 0
        last_error = ""
        client = httpx.Client(**self._client_kwargs)
        try:
            while attempts < self.max_retries:
                attempts += 1
                have = partial.stat().st_size if partial.exists() else 0
                if have > entry.size:
                    partial.unlink()
                    have = 0
                headers = {"Range": f"bytes={have}-"} if have else {}
                try:
                    with client.stream("GET", url, headers=headers) as r:
                        if r.status_code in (401, 403, 404):
                            return DownloadOutcome(entry.path, "failed", 0, None, f"HTTP {r.status_code}", attempts)
                        if r.status_code == 416 and have == entry.size:
                            pass  # already complete
                        elif r.status_code == 429 or r.status_code >= 500:
                            raise httpx.HTTPStatusError("retryable", request=r.request, response=r)
                        elif r.status_code not in (200, 206):
                            return DownloadOutcome(entry.path, "failed", 0, None, f"HTTP {r.status_code}", attempts)
                        else:
                            mode = "ab" if (have and r.status_code == 206) else "wb"
                            with open(partial, mode) as f:
                                for chunk in r.iter_bytes():  # unbuffered: partial bytes reach disk before a drop
                                    f.write(chunk)
                    method = verify_file(partial, entry)
                    os.replace(partial, dest)
                    return DownloadOutcome(entry.path, "downloaded", entry.size - have, method, None, attempts)
                except HFError as exc:  # checksum: discard and restart from zero
                    last_error = str(exc)
                    partial.unlink(missing_ok=True)
                except httpx.ProxyError as exc:
                    return DownloadOutcome(entry.path, "failed", 0, None, f"egress denied: {exc}", attempts)
                except (httpx.HTTPError, OSError) as exc:
                    last_error = f"{type(exc).__name__}: {exc}"
                time.sleep(min(self.backoff_base ** attempts, 30))
        finally:
            client.close()
        return DownloadOutcome(entry.path, "failed", 0, None, last_error or "retries exhausted", attempts)

    def download(
        self,
        plan: TransferPlan,
        dest_root: Path,
        *,
        concurrency: int = 4,
        storage_limit_bytes: int | None = None,
        progress: Callable[[DownloadOutcome], None] | None = None,
    ) -> list[DownloadOutcome]:
        dest_root.mkdir(parents=True, exist_ok=True)
        free = shutil.disk_usage(dest_root).free
        need = plan.missing_bytes
        if need > free:
            raise HFError(f"transfer needs {need} bytes but only {free} free at {dest_root}", kind="storage")
        if storage_limit_bytes is not None and need > storage_limit_bytes:
            raise HFError(f"transfer needs {need} bytes, above the configured limit {storage_limit_bytes}", kind="storage")
        outcomes: list[DownloadOutcome] = []
        with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
            futures = [pool.submit(self.download_one, plan.revision, e, dest_root) for e in plan.missing]
            for fut in as_completed(futures):
                o = fut.result()
                outcomes.append(o)
                if progress:
                    progress(o)
        outcomes.sort(key=lambda o: o.path)
        return outcomes


def describe_failure(exc: Exception) -> dict:
    kind = getattr(exc, "kind", "error")
    return {"at": utcnow_iso(), "kind": kind, "detail": str(exc)[:500]}
