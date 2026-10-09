"""Pinned retrieval of public git sources into an immutable, content-verified cache.

Checkouts are treated as untrusted data: this module only runs ``git`` and reads bytes. Nothing from a
checkout is imported or executed here.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

from agenthorizon.util.hashing import sha256_file, tree_digest

LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"


class GitSourceError(RuntimeError):
    pass


def _git(args: list[str], cwd: Path | None = None, timeout: int = 900) -> str:
    env = dict(os.environ)
    env["GIT_LFS_SKIP_SMUDGE"] = "1"  # LFS objects are not served anonymously; keep pointers, never abort
    env["GIT_TERMINAL_PROMPT"] = "0"
    proc = subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, check=False
    )
    if proc.returncode != 0:
        raise GitSourceError(f"git {' '.join(args[:3])} failed ({proc.returncode}): {proc.stderr.strip()[:500]}")
    return proc.stdout


def ls_remote(url: str) -> dict[str, str]:
    out = _git(["ls-remote", url], timeout=120)
    refs: dict[str, str] = {}
    for line in out.splitlines():
        sha, _, ref = line.partition("\t")
        if ref:
            refs[ref] = sha
    return refs


def resolve_revision(url: str, revision: str | None) -> tuple[str, dict[str, str]]:
    """Resolve a branch/tag/commit to a commit SHA. Returns (sha, all_refs)."""
    refs = ls_remote(url)
    rev = revision or "HEAD"
    if len(rev) == 40 and all(c in "0123456789abcdef" for c in rev):
        return rev, refs
    for candidate in (rev, f"refs/heads/{rev}", f"refs/tags/{rev}^{{}}", f"refs/tags/{rev}"):
        if candidate in refs:
            return refs[candidate], refs
    raise GitSourceError(f"revision {revision!r} not found among {len(refs)} remote refs of {url}")


@dataclass
class FileEntry:
    path: str
    size: int
    sha256: str
    git_blob: str
    mode: str
    lfs_pointer: bool

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class GitCheckout:
    url: str
    commit: str
    path: Path

    def file(self, rel: str) -> Path:
        p = (self.path / rel).resolve()
        if self.path.resolve() not in p.parents and p != self.path.resolve():
            raise GitSourceError(f"path escapes checkout: {rel}")
        if not p.is_file():
            raise FileNotFoundError(f"{rel} not present at {self.commit[:12]}")
        return p

    def commit_info(self) -> dict:
        fmt = "%H%x00%P%x00%an%x00%aI%x00%cI%x00%s"
        raw = _git(["log", "-1", f"--format={fmt}", self.commit], cwd=self.path).rstrip("\n")
        sha, parents, author, adate, cdate, subject = raw.split("\x00")
        return {
            "sha": sha,
            "parents": parents.split() if parents else [],
            "author": author,
            "author_date": adate,
            "committer_date": cdate,
            "subject": subject,
        }

    def history(self, limit: int = 200) -> list[dict]:
        fmt = "%H%x00%cI%x00%s"
        try:
            out = _git(["log", f"-{limit}", f"--format={fmt}", self.commit], cwd=self.path)
        except GitSourceError:
            return []
        rows = []
        for line in out.splitlines():
            sha, date, subject = line.split("\x00")
            rows.append({"sha": sha, "committer_date": date, "subject": subject})
        return rows

    def is_shallow(self) -> bool:
        return (self.path / ".git" / "shallow").exists()

    def inventory(self) -> list[FileEntry]:
        out = _git(["ls-tree", "-r", "-l", "-z", self.commit], cwd=self.path)
        entries: list[FileEntry] = []
        for rec in out.split("\0"):
            if not rec:
                continue
            meta, _, rel = rec.partition("\t")
            mode, otype, blob, size = meta.split()
            if otype != "blob":
                continue
            p = self.path / rel
            if mode == "120000":  # symlink: hash the link target text, never follow it
                target = os.readlink(p) if p.is_symlink() else ""
                from agenthorizon.util.hashing import sha256_text

                entries.append(FileEntry(rel, len(target), sha256_text(target), blob, mode, False))
                continue
            with open(p, "rb") as f:
                head = f.read(len(LFS_POINTER_PREFIX))
            entries.append(
                FileEntry(rel, int(size), sha256_file(p), blob, mode, head == LFS_POINTER_PREFIX)
            )
        entries.sort(key=lambda e: e.path)
        return entries

    def tree_digest(self) -> str:
        return tree_digest((e.path, e.sha256) for e in self.inventory())


def ensure_checkout(url: str, commit: str, cache_root: Path, *, shallow: bool = False) -> GitCheckout:
    """Return a detached checkout of ``commit`` under ``cache_root``, cloning if needed.

    The final directory name embeds the commit, so a cached checkout is immutable by construction.
    """
    slug = url.rstrip("/").split("github.com/")[-1].replace("/", "__")
    final = cache_root / f"{slug}@{commit}"
    if (final / ".git").exists():
        head = _git(["rev-parse", "HEAD"], cwd=final).strip()
        if head != commit:
            raise GitSourceError(f"cached checkout {final} is at {head}, expected {commit}")
        return GitCheckout(url, commit, final)
    cache_root.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{slug}.", dir=cache_root))
    try:
        clone_args = ["clone", "--no-checkout"]
        if shallow:
            clone_args += ["--depth", "50"]
        _git([*clone_args, url, str(tmp / "repo")], timeout=1200)
        repo = tmp / "repo"
        try:
            _git(["cat-file", "-e", f"{commit}^{{commit}}"], cwd=repo)
        except GitSourceError:
            _git(["fetch", "--depth", "1" if shallow else "1000", "origin", commit], cwd=repo, timeout=1200)
        _git(["checkout", "--detach", "--quiet", commit], cwd=repo)
        os.replace(repo, final)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return GitCheckout(url, commit, final)
