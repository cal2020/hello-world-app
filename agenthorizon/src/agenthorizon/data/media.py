"""Content-addressed media storage with an object-storage-style interface.

Objects are keyed by SHA-256 and written atomically; the same bytes are stored once no matter how many
examples reference them (shared recordings). The local filesystem backend is the development default; a
remote backend only needs to implement ``MediaBackend``.
"""

from __future__ import annotations

import io
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from PIL import Image

from agenthorizon.util.hashing import sha256_file

MAX_IMAGE_PIXELS = 64_000_000  # refuse decompression bombs; real screenshots are far smaller


class MediaBackend(Protocol):
    def has(self, digest: str) -> bool: ...
    def path(self, digest: str) -> Path: ...
    def put_file(self, src: Path) -> str: ...
    def open(self, digest: str) -> io.BufferedReader: ...


@dataclass
class ImageFacts:
    sha256: str
    bytes: int
    format: str | None
    width: int | None
    height: int | None
    mode: str | None
    error: str | None = None


class LocalMediaStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, digest: str) -> Path:
        if len(digest) != 64 or not all(c in "0123456789abcdef" for c in digest):
            raise ValueError("invalid media digest")
        return self.root / "sha256" / digest[:2] / digest[2:4] / digest

    def has(self, digest: str) -> bool:
        return self.path(digest).is_file()

    def put_file(self, src: Path, *, link: bool = True) -> str:
        digest = sha256_file(src)
        dst = self.path(digest)
        if dst.is_file():
            return digest
        dst.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=dst.parent, prefix=".put.")
        os.close(fd)
        os.unlink(tmp)
        try:
            if link:
                try:
                    os.link(src, tmp)
                except OSError:
                    shutil.copyfile(src, tmp)
            else:
                shutil.copyfile(src, tmp)
            os.chmod(tmp, 0o444)
            os.replace(tmp, dst)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        return digest

    def open(self, digest: str) -> io.BufferedReader:
        return open(self.path(digest), "rb")

    def stage(self, digest: str, dst: Path) -> None:
        """Place a read-only copy at dst (hardlink when possible) and verify the bytes are unchanged."""
        dst.parent.mkdir(parents=True, exist_ok=True)
        src = self.path(digest)
        try:
            os.link(src, dst)
        except OSError:
            shutil.copyfile(src, dst)
            os.chmod(dst, 0o444)
        if sha256_file(dst) != digest:  # pragma: no cover - would indicate storage corruption
            raise RuntimeError(f"staged media {dst} does not match {digest}")


def inspect_image(path: Path) -> ImageFacts:
    digest = sha256_file(path)
    size = path.stat().st_size
    try:
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        with Image.open(path) as im:
            im.verify()
        with Image.open(path) as im:
            return ImageFacts(digest, size, im.format, im.width, im.height, im.mode)
    except Exception as exc:
        return ImageFacts(digest, size, None, None, None, None, f"{type(exc).__name__}: {exc}"[:200])
