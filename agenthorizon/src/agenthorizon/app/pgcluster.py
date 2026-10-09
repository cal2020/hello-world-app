"""Project-local PostgreSQL cluster for single-host development (``agenthorizon bootstrap`` / ``dev``).

The cluster listens only on a Unix socket inside ``var/pg/socket`` (no TCP), uses local trust authentication for
that socket, and creates one owner role plus the three service roles described in :mod:`agenthorizon.app.schema`.
When run as root, the server runs as the ``postgres`` system account (PostgreSQL refuses to run as root).
Hosted deployments use a managed server and password authentication instead (see OPERATIONS.md).
"""

from __future__ import annotations

import os
import pwd
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

OWNER = "agenthorizon"
DBNAME = "agenthorizon"
SERVICE_ROLES = ("ah_api", "ah_worker", "ah_scorer")


def pg_bindir() -> Path | None:
    for v in ("17", "16", "15", "14"):
        p = Path(f"/usr/lib/postgresql/{v}/bin")
        if (p / "initdb").is_file():
            return p
    exe = shutil.which("pg_config")
    if exe:
        out = subprocess.run([exe, "--bindir"], capture_output=True, text=True, check=False).stdout.strip()
        if out and (Path(out) / "initdb").is_file():
            return Path(out)
    return None


@dataclass
class LocalCluster:
    root: Path
    port: int = 5433

    @property
    def data(self) -> Path:
        return self.root / "data"

    @property
    def socket(self) -> Path:
        return self.root / "socket"

    @property
    def log(self) -> Path:
        return self.root / "postgres.log"

    def _as_server_user(self, argv: list[str], **kw) -> subprocess.CompletedProcess:
        if os.geteuid() == 0:
            argv = ["runuser", "-u", "postgres", "--", *argv]
        return subprocess.run(argv, capture_output=True, text=True, check=False, **kw)

    def url(self, role: str = OWNER, db: str = DBNAME) -> str:
        return f"postgresql+psycopg://{role}@/{db}?host={self.socket}&port={self.port}"

    def initialized(self) -> bool:
        return (self.data / "PG_VERSION").is_file()

    def init(self) -> None:
        b = pg_bindir()
        if b is None:
            raise RuntimeError("PostgreSQL server binaries not found (install postgresql or set AH_DATABASE_URL)")
        self.root.mkdir(parents=True, exist_ok=True)
        self.socket.mkdir(parents=True, exist_ok=True)
        if os.geteuid() == 0:
            pw = pwd.getpwnam("postgres")
            for p in (self.root, self.socket):
                os.chown(p, pw.pw_uid, pw.pw_gid)
            os.chmod(self.root, 0o755)
            os.chmod(self.socket, 0o775)
        if self.initialized():
            return
        r = self._as_server_user([str(b / "initdb"), "-D", str(self.data), "-U", OWNER, "--auth-local=trust",
                                  "--auth-host=reject", "-E", "UTF8", "--locale=C.UTF-8"])
        if r.returncode != 0:
            raise RuntimeError(f"initdb failed: {r.stderr[-2000:]}")

    def running(self) -> bool:
        b = pg_bindir()
        r = subprocess.run([str(b / "pg_isready"), "-h", str(self.socket), "-p", str(self.port)],
                           capture_output=True, text=True, check=False)
        return r.returncode == 0

    def start(self) -> None:
        if self.running():
            return
        b = pg_bindir()
        opts = f"-k {self.socket} -p {self.port} -c listen_addresses='' -c max_connections=200"
        if os.geteuid() == 0:
            pw = pwd.getpwnam("postgres")
            if not self.log.exists():
                self.log.touch()
            os.chown(self.log, pw.pw_uid, pw.pw_gid)
        r = self._as_server_user([str(b / "pg_ctl"), "-D", str(self.data), "-o", opts, "-l", str(self.log), "-w", "-t", "60",
                                  "start"])
        if r.returncode != 0:
            tail = self.log.read_text()[-2000:] if self.log.exists() else ""
            raise RuntimeError(f"postgres failed to start: {r.stderr[-1000:]} {tail}")

    def stop(self) -> None:
        b = pg_bindir()
        if self.initialized():
            self._as_server_user([str(b / "pg_ctl"), "-D", str(self.data), "-m", "fast", "-w", "stop"])

    def psql(self, sql: str, db: str = "postgres") -> str:
        b = pg_bindir()
        r = subprocess.run([str(b / "psql"), "-h", str(self.socket), "-p", str(self.port), "-U", OWNER, "-d", db,
                            "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], capture_output=True, text=True, check=False)
        if r.returncode != 0:
            raise RuntimeError(f"psql failed: {r.stderr[-1500:]}")
        return r.stdout

    def ensure_database(self) -> None:
        for role in SERVICE_ROLES:
            self.psql(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') "
                      f"THEN CREATE ROLE {role} LOGIN; END IF; END $$;")
        if self.psql(f"SELECT 1 FROM pg_database WHERE datname = '{DBNAME}'").strip() != "1":
            self.psql(f"CREATE DATABASE {DBNAME} OWNER {OWNER}")
        self.psql("CREATE EXTENSION IF NOT EXISTS pg_trgm", db=DBNAME)

    def ensure(self) -> LocalCluster:
        self.init()
        self.start()
        self.ensure_database()
        return self
