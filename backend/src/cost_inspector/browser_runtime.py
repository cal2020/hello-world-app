"""Runs the API inside the browser, in Pyodide (CPython compiled to WebAssembly).

The browser build loads this module in a Web Worker. The page's API requests are passed
straight to the same FastAPI application the local server runs, as ASGI calls, so routing,
validation, limits, security checks and error handling are the production code paths.
What differs from the server:

* There is no network. The worker hands each request to :func:`handle` and posts the
  response back to the page.
* Pyodide has no threads, so the thread pool FastAPI uses for synchronous endpoints is
  replaced by a direct call. The worker handles one request at a time.
* The database file lives in the worker's in-memory file system; the worker saves it to
  the browser's IndexedDB after every change and restores it on the next visit.
"""

from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from .app import create_app
from .config import Settings

#: The Host header every in-browser request carries (allowed by the app's host check).
HOST = "localhost"

_app: Any = None


def _call_inline() -> None:
    """Pyodide cannot start threads: run "thread pool" work directly on the event loop."""
    import anyio.to_thread

    async def run_sync(func: Callable[..., Any], *args: Any, **_ignored: Any) -> Any:
        return func(*args)

    anyio.to_thread.run_sync = run_sync  # type: ignore[assignment]


def boot(db_path: str) -> None:
    """Create the application on the given database file (created and migrated if new)."""
    global _app
    if sys.platform == "emscripten":
        _call_inline()
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _app = create_app(Settings(db_path=path, static_dir=None))


def _as_bytes(body: Any) -> bytes:
    if body is None:
        return b""
    to_bytes = getattr(body, "to_bytes", None)  # a JavaScript Uint8Array or ArrayBuffer
    return bytes(to_bytes() if callable(to_bytes) else body)


async def handle(
    method: str, target: str, headers_json: str, body: Any = None
) -> tuple[str, bytes]:
    """Serve one request. Returns (JSON metadata with status and headers, response body)."""
    if _app is None:
        raise RuntimeError("boot() has not run")
    path, _, query = target.partition("?")
    payload = _as_bytes(body)
    headers: list[tuple[bytes, bytes]] = [(b"host", HOST.encode())]
    for key, value in json.loads(headers_json or "{}").items():
        if key.lower() not in ("host", "content-length"):
            headers.append((key.lower().encode("latin-1"), str(value).encode("latin-1")))
    headers.append((b"content-length", str(len(payload)).encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method.upper(),
        "scheme": "http",
        "path": unquote(path),
        "raw_path": path.encode("latin-1"),
        "query_string": query.encode("latin-1"),
        "root_path": "",
        "headers": headers,
        "client": ("browser", 0),
        "server": (HOST, 80),
    }
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": payload, "more_body": False}
        # Like a real server: the client stays connected until the response is sent.
        await asyncio.Event().wait()
        return {"type": "http.disconnect"}  # pragma: no cover - waiters are cancelled

    status = 500
    response_headers: list[list[str]] = []
    chunks: list[bytes] = []

    async def send(message: dict[str, Any]) -> None:
        nonlocal status, response_headers
        if message["type"] == "http.response.start":
            status = message["status"]
            response_headers = [
                [key.decode("latin-1"), value.decode("latin-1")]
                for key, value in message.get("headers", [])
            ]
        elif message["type"] == "http.response.body":
            chunks.append(bytes(message.get("body", b"")))

    asgi: Callable[[Any, Any, Any], Awaitable[None]] = _app
    await asgi(scope, receive, send)
    return json.dumps({"status": status, "headers": response_headers}), b"".join(chunks)
