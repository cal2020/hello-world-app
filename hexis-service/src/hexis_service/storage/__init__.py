"""Durable stores. :func:`open_store` selects the backend from a URL (brief §11.3).

* ``sqlite:///relative/path.db``, ``sqlite:////abs/path.db``, a bare filesystem path, or ``:memory:``
  -> :class:`storage.sqlite.Store` (single-process development);
* ``postgresql://...`` / ``postgres://...`` (any libpq URL) -> :class:`storage.postgres.PostgresStore`
  (multi-worker deployment; requires the ``postgres`` extra, i.e. ``psycopg``).
"""

from __future__ import annotations

from typing import Any


def open_store(url_or_path: str) -> Any:
    s = str(url_or_path)
    if s.startswith(("postgresql://", "postgres://")):
        from .postgres import PostgresStore
        return PostgresStore(s)
    from .sqlite import Store
    if s.startswith("sqlite:"):
        rest = s[len("sqlite:"):]
        if rest in ("", "//", "///", "///:memory:", "//:memory:"):
            return Store(":memory:")
        if not rest.startswith("///"):
            raise ValueError(f"unsupported sqlite URL {s!r} (use sqlite:///relative.db or sqlite:////abs.db)")
        return Store(rest[3:])
    if "://" in s:
        raise ValueError(f"unsupported store URL scheme in {s!r} (use sqlite:/// or postgresql://)")
    return Store(s)
