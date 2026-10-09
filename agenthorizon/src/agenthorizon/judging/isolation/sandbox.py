"""Launch a command inside a per-task namespace sandbox (see ``sandbox_init.py`` for what happens inside).

Only these host paths are visible inside: read-only system directories, read-only tool installations, the
task's own workspace (staged inputs read-only), and a private HOME and /tmp. Labels, other tasks, the dataset
store, the application database, and host secrets are simply not mounted. Network access exists only through
the per-task egress proxy, which enforces a host allowlist.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from agenthorizon.judging.isolation.egress import EgressPolicy, EgressProxy

INIT_PATH = Path(__file__).with_name("sandbox_init.py")
PROXY_PORT = 3128
SANDBOX_HOME = "/home/judge"
SANDBOX_WORKSPACE = "/workspace"

ETC_FILES = ["passwd", "group", "hosts", "nsswitch.conf", "ld.so.cache", "localtime", "os-release", "host.conf"]
ETC_DIRS = ["ssl", "ca-certificates", "alternatives", "fonts"]


SECRET_ENV_MARKERS = ("KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH")


def redacted_env(env: dict[str, str]) -> dict[str, str]:
    return {k: ("[REDACTED]" if any(m in k.upper() for m in SECRET_ENV_MARKERS) and v else v) for k, v in env.items()}


@dataclass
class SandboxSpec:
    task_dir: Path
    argv: list[str]
    env: dict[str, str]
    allowed_hosts: set[str] = field(default_factory=set)
    allowed_ports: set[int] = field(default_factory=lambda: {443})
    readonly_inputs: list[str] = field(default_factory=list)  # paths relative to <task_dir>/workspace
    tool_dirs: list[str] = field(default_factory=list)  # host dirs bound read-only at the same path
    timeout_s: int = 1800
    stdin: bytes | None = None
    upstream_proxy: str | None = None
    ca_bundle: str | None = None


@dataclass
class SandboxResult:
    exit_code: int | None
    timed_out: bool
    cancelled: bool
    setup_failed: bool
    wall_time_s: float
    stdout_path: Path
    stderr_path: Path
    egress_audit: list[dict]
    init_log: str
    backend: str

    def stdout(self) -> str:
        return self.stdout_path.read_text(errors="replace") if self.stdout_path.exists() else ""

    def stderr(self) -> str:
        return self.stderr_path.read_text(errors="replace") if self.stderr_path.exists() else ""


def task_layout(task_dir: Path) -> dict[str, Path]:
    d = {k: task_dir / k for k in ("workspace", "home", "tmp", "out", "root")}
    for p in d.values():
        p.mkdir(parents=True, exist_ok=True)
    os.chmod(d["tmp"], 0o1777)
    return d


def _system_binds(spec: SandboxSpec) -> tuple[list[dict], list[dict]]:
    binds: list[dict] = [{"src": "/usr", "dst": "/usr", "ro": True}]
    symlinks: list[dict] = []
    for top in ("bin", "lib", "lib64", "sbin", "lib32", "libx32"):
        p = Path("/") / top
        if p.is_symlink():
            symlinks.append({"dst": f"/{top}", "target": os.readlink(p)})
        elif p.is_dir():
            binds.append({"src": str(p), "dst": f"/{top}", "ro": True})
    for f in ETC_FILES:
        binds.append({"src": f"/etc/{f}", "dst": f"/etc/{f}", "ro": True, "optional": True})
    for d in ETC_DIRS:
        binds.append({"src": f"/etc/{d}", "dst": f"/etc/{d}", "ro": True, "optional": True})
    for t in spec.tool_dirs:
        binds.append({"src": t, "dst": t, "ro": True})
    if spec.ca_bundle:
        binds.append({"src": spec.ca_bundle, "dst": "/etc/ah/ca-bundle.pem", "ro": True})
    return binds, symlinks


def run_in_sandbox(spec: SandboxSpec, cancel: threading.Event | None = None) -> SandboxResult:
    lay = task_layout(spec.task_dir)
    binds, symlinks = _system_binds(spec)
    binds += [
        {"src": str(lay["workspace"]), "dst": SANDBOX_WORKSPACE, "ro": False},
        {"src": str(lay["home"]), "dst": SANDBOX_HOME, "ro": False},
        {"src": str(lay["tmp"]), "dst": "/tmp", "ro": False},
        {"src": str(lay["out"]), "dst": "/out", "ro": False},
    ]
    for rel in spec.readonly_inputs:
        src = lay["workspace"] / rel
        if src.exists():
            binds.append({"src": str(src), "dst": f"{SANDBOX_WORKSPACE}/{rel}", "ro": True})
    sock_dir = Path(tempfile.mkdtemp(prefix="ahe-"))  # AF_UNIX paths are limited to 108 bytes; run dirs can be deep
    os.chmod(sock_dir, 0o700)
    sock = sock_dir / "egress.sock"
    proxy = EgressProxy(str(sock), EgressPolicy(set(spec.allowed_hosts), set(spec.allowed_ports), spec.upstream_proxy)).start()
    init_log = spec.task_dir / "sandbox-init.log"
    sb_spec = {
        "new_root": str(lay["root"]),
        "binds": binds,
        "symlinks": symlinks,
        "devices": ["null", "zero", "random", "urandom", "full"],
        "egress_socket": str(sock),
        "proxy_port": PROXY_PORT,
        "cwd": SANDBOX_WORKSPACE,
        "argv": spec.argv,
        "env": spec.env,
        "log_path": str(init_log),
    }
    audit_spec = dict(sb_spec, env=redacted_env(spec.env))
    (spec.task_dir / "sandbox-spec.json").write_text(json.dumps(audit_spec, indent=1))  # audit copy, secrets masked
    rfd, wfd = os.pipe()
    cmd = ["unshare", "--user", "--map-root-user", "--mount", "--net", "--pid", "--ipc", "--uts", "--fork", "--",
           sys.executable, "-I", "-S", str(INIT_PATH), f"fd:{rfd}"]
    out_p, err_p = spec.task_dir / "stdout.log", spec.task_dir / "stderr.log"
    t0 = time.monotonic()
    timed_out = cancelled = False
    with open(out_p, "wb") as fo, open(err_p, "wb") as fe:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE if spec.stdin is not None else subprocess.DEVNULL,
                                stdout=fo, stderr=fe, start_new_session=True, env={"PATH": "/usr/bin:/bin"},
                                pass_fds=(rfd,))
        os.close(rfd)
        with os.fdopen(wfd, "w") as wf:
            wf.write(json.dumps(sb_spec))
        if spec.stdin is not None:
            try:
                proc.stdin.write(spec.stdin)
                proc.stdin.close()
            except BrokenPipeError:
                pass
        while True:
            try:
                proc.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                pass
            if cancel is not None and cancel.is_set():
                cancelled = True
            elif time.monotonic() - t0 > spec.timeout_s:
                timed_out = True
            if cancelled or timed_out:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)  # PID-namespace init dies -> every sandbox process dies
                except ProcessLookupError:
                    pass
                proc.wait()
                break
    wall = time.monotonic() - t0
    proxy.stop()
    shutil.rmtree(sock_dir, ignore_errors=True)
    log_text = init_log.read_text() if init_log.exists() else ""
    try:  # the tmpfs root is gone with the namespace; remove the empty mountpoint
        lay["root"].rmdir()
    except OSError:
        pass
    return SandboxResult(
        exit_code=None if (timed_out or cancelled) else proc.returncode,
        timed_out=timed_out,
        cancelled=cancelled,
        setup_failed="SANDBOX_SETUP_FAILED" in log_text or proc.returncode == 125,
        wall_time_s=wall,
        stdout_path=out_p,
        stderr_path=err_p,
        egress_audit=proxy.audit(),
        init_log=log_text,
        backend="unshare",
    )


def run_unisolated(spec: SandboxSpec, cancel: threading.Event | None = None) -> SandboxResult:
    """Development-only backend: no enforceable boundary. Runs are marked ``isolation=none``."""
    lay = task_layout(spec.task_dir)
    out_p, err_p = spec.task_dir / "stdout.log", spec.task_dir / "stderr.log"
    env = dict(spec.env)
    env["HOME"] = str(lay["home"])
    env["TMPDIR"] = str(lay["tmp"])
    t0 = time.monotonic()
    timed_out = cancelled = False
    with open(out_p, "wb") as fo, open(err_p, "wb") as fe:
        proc = subprocess.Popen(spec.argv, cwd=lay["workspace"], env=env, stdout=fo, stderr=fe, start_new_session=True,
                                stdin=subprocess.PIPE if spec.stdin is not None else subprocess.DEVNULL)
        if spec.stdin is not None:
            proc.stdin.write(spec.stdin)
            proc.stdin.close()
        while True:
            try:
                proc.wait(timeout=0.25)
                break
            except subprocess.TimeoutExpired:
                pass
            if cancel is not None and cancel.is_set():
                cancelled = True
            elif time.monotonic() - t0 > spec.timeout_s:
                timed_out = True
            if cancelled or timed_out:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                break
    return SandboxResult(None if (timed_out or cancelled) else proc.returncode, timed_out, cancelled, False,
                         time.monotonic() - t0, out_p, err_p, [], "", "none")


@lru_cache(maxsize=1)
def isolation_available() -> tuple[bool, str]:
    """Probe once: can this host create the namespaces and mounts the sandbox needs?"""
    import tempfile

    if shutil.which("unshare") is None:
        return False, "util-linux unshare not found"
    d = Path(tempfile.mkdtemp(prefix="ah-sbprobe-"))
    try:
        r = run_in_sandbox(SandboxSpec(task_dir=d, argv=["/usr/bin/true"], env={"PATH": "/usr/bin"}, timeout_s=30))
        if r.exit_code == 0:
            return True, "user+mount+net+pid namespaces, pivot_root, capability drop"
        return False, f"probe exit {r.exit_code}; init log: {r.init_log.strip()[-300:]}; stderr: {r.stderr()[-300:]}"
    finally:
        shutil.rmtree(d, ignore_errors=True)
