"""Host-side allowlisting egress proxy exposed to a sandbox only through a Unix socket.

The sandbox has its own network namespace with nothing but loopback; the only way out is this proxy. It accepts
``CONNECT host:443`` for allowlisted hosts and nothing else (no plain HTTP, no other ports), optionally chaining
through an upstream HTTPS proxy, and records every decision for the run's audit trail.
"""

from __future__ import annotations

import os
import socket
import threading
import time
from dataclasses import asdict, dataclass, field
from urllib.parse import urlparse


@dataclass
class EgressDecision:
    at: float
    host: str
    port: int
    allowed: bool
    reason: str
    bytes_up: int = 0
    bytes_down: int = 0


@dataclass
class EgressPolicy:
    allowed_hosts: set[str]
    allowed_ports: set[int] = field(default_factory=lambda: {443})
    upstream_proxy: str | None = None  # http://host:port of an outer HTTPS proxy, if the host requires one

    def allows(self, host: str, port: int) -> tuple[bool, str]:
        h = host.lower().rstrip(".")
        if port not in self.allowed_ports:
            return False, f"port {port} not allowed"
        if h in self.allowed_hosts:
            return True, "allowlisted"
        return False, "host not in allowlist"


def _pump(a: socket.socket, b: socket.socket, counter: list[int], idx: int) -> None:
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
            counter[idx] += len(data)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def _read_head(conn: socket.socket, limit: int = 16384) -> bytes:
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
        if len(buf) > limit:
            break
    return buf


def _connect_upstream(host: str, port: int, upstream: str | None, timeout: float = 20.0) -> socket.socket:
    if not upstream:
        return socket.create_connection((host, port), timeout=timeout)
    u = urlparse(upstream)
    s = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
    s.sendall(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
    head = _read_head(s)
    status = head.split(b"\r\n", 1)[0]
    if b" 200 " not in status + b" ":
        s.close()
        raise OSError(f"upstream proxy refused CONNECT {host}:{port}: {status.decode(errors='replace')}")
    s.settimeout(None)
    return s


class EgressProxy:
    """Serve one sandbox on ``socket_path``. Thread-based; stop() closes the listener and active tunnels."""

    def __init__(self, socket_path: str, policy: EgressPolicy):
        self.socket_path = socket_path
        self.policy = policy
        self.decisions: list[EgressDecision] = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._sock: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._conns: list[socket.socket] = []

    def start(self) -> EgressProxy:
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(self.socket_path)
        os.chmod(self.socket_path, 0o666)
        s.listen(64)
        s.settimeout(0.2)
        self._sock = s
        self._thread = threading.Thread(target=self._serve, name="egress-proxy", daemon=True)
        self._thread.start()
        return self

    def _serve(self) -> None:
        assert self._sock is not None
        while not self._stop.is_set():
            try:
                conn, _ = self._sock.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _record(self, d: EgressDecision) -> None:
        with self._lock:
            self.decisions.append(d)

    def _handle(self, conn: socket.socket) -> None:
        conn.settimeout(30)
        with self._lock:
            self._conns.append(conn)
        try:
            head = _read_head(conn)
            line = head.split(b"\r\n", 1)[0].decode("latin-1", errors="replace")
            parts = line.split()
            if len(parts) < 2 or parts[0].upper() != "CONNECT":
                self._record(EgressDecision(time.time(), parts[1] if len(parts) > 1 else "?", 0, False,
                                            f"method {parts[0] if parts else '?'} refused (CONNECT only)"))
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            host, _, port_s = parts[1].rpartition(":")
            port = int(port_s) if port_s.isdigit() else 0
            ok, reason = self.policy.allows(host, port)
            dec = EgressDecision(time.time(), host, port, ok, reason)
            if not ok:
                self._record(dec)
                conn.sendall(b"HTTP/1.1 403 Forbidden\r\nX-AH-Egress: denied\r\nContent-Length: 0\r\n\r\n")
                return
            try:
                up = _connect_upstream(host, port, self.policy.upstream_proxy)
            except OSError as exc:
                dec.allowed, dec.reason = False, f"upstream connect failed: {exc}"[:200]
                self._record(dec)
                conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                return
            conn.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            conn.settimeout(None)
            counter = [0, 0]
            t1 = threading.Thread(target=_pump, args=(conn, up, counter, 0), daemon=True)
            t2 = threading.Thread(target=_pump, args=(up, conn, counter, 1), daemon=True)
            t1.start()
            t2.start()
            t1.join()
            t2.join()
            dec.bytes_up, dec.bytes_down = counter
            self._record(dec)
        except OSError:
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def stop(self) -> None:
        self._stop.set()
        if self._sock:
            self._sock.close()
        with self._lock:
            for c in self._conns:
                try:
                    c.close()
                except OSError:
                    pass
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)

    def audit(self) -> list[dict]:
        with self._lock:
            return [asdict(d) for d in self.decisions]


def default_upstream_proxy() -> str | None:
    return os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
