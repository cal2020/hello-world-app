"""Leakage boundary tests: a probe runs inside the real sandbox and tries to cheat.

Every assertion here is about the runtime boundary (mounts, namespaces, capabilities, egress proxy), not about
what a prompt tells the judge.
"""

from __future__ import annotations

import json
import socket
import threading
from pathlib import Path

import pytest

from agenthorizon.judging.isolation.sandbox import SandboxSpec, isolation_available, run_in_sandbox

pytestmark = pytest.mark.isolation

PROBE = r'''
import json, os, socket, sys
cfg = json.load(open("/workspace/probe/cfg.json"))
out = {}
def attempt(name, fn):
    try:
        out[name] = {"ok": True, "value": fn()}
    except Exception as e:
        out[name] = {"ok": False, "error": type(e).__name__, "msg": str(e)[:120]}
attempt("read_host_labels", lambda: open(cfg["labels_path"]).read())
attempt("read_other_task", lambda: os.listdir(cfg["other_task"]))
attempt("read_host_root_home", lambda: os.listdir("/root"))
attempt("list_root", lambda: sorted(os.listdir("/")))
attempt("write_input", lambda: open("/workspace/agenthorizon_md/evil.md", "w").write("x"))
attempt("modify_input", lambda: open("/workspace/agenthorizon_md/t.md", "a").write("x"))
attempt("write_usr", lambda: open("/usr/evil", "w").write("x"))
attempt("write_workspace_scratch", lambda: open("/workspace/scratch.txt", "w").write("ok"))
attempt("write_home", lambda: open(os.path.expanduser("~/note.txt"), "w").write("ok"))
def tcp(host, port):
    s = socket.create_connection((host, port), timeout=3); s.close(); return "connected"
attempt("host_api_loopback", lambda: tcp("127.0.0.1", cfg["host_api_port"]))
attempt("direct_internet", lambda: tcp("1.1.1.1", 443))
attempt("dns", lambda: socket.gethostbyname("example.com"))
def via_proxy(target):
    s = socket.create_connection(("127.0.0.1", 3128), timeout=5)
    s.sendall(f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n\r\n".encode())
    head = s.recv(4096).decode(errors="replace").split("\r\n")[0]
    if " 200 " in head + " ":
        s.sendall(b"ping"); echo = s.recv(16).decode()
        s.close(); return head + " | " + echo
    s.close(); return head
attempt("proxy_denied_host", lambda: via_proxy("example.com:443"))
attempt("proxy_allowed_host", lambda: via_proxy(f"127.0.0.1:{cfg['echo_port']}"))
def status():
    d = {}
    for line in open("/proc/self/status"):
        k, _, v = line.partition(":")
        if k in ("CapEff", "CapPrm", "CapBnd", "CapInh", "CapAmb", "NoNewPrivs", "Uid"):
            d[k] = v.strip()
    return d
attempt("proc_status", status)
attempt("visible_pids", lambda: sorted(int(p) for p in os.listdir("/proc") if p.isdigit()))
attempt("env_keys", lambda: sorted(os.environ))
attempt("mount_attempt", lambda: os.system("mount --bind /workspace /tmp 2>/dev/null"))
attempt("hostname", lambda: socket.gethostname())
print(json.dumps(out))
'''


@pytest.fixture(scope="module")
def available():
    ok, why = isolation_available()
    if not ok:
        pytest.skip(f"namespace sandbox unavailable: {why}")


def _echo_server() -> tuple[socket.socket, int]:
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)

    def serve():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            data = c.recv(16)
            c.sendall(data)
            c.close()

    threading.Thread(target=serve, daemon=True).start()
    return srv, srv.getsockname()[1]


def test_probe_cannot_cross_the_boundary(tmp_path, available):
    # host-side secrets/labels the judge must never see
    private = tmp_path / "private"
    private.mkdir()
    labels = private / "gold_labels.jsonl"
    labels.write_text('{"example_id": "x", "label": "negative"}\n')
    other = tmp_path / "other-task" / "workspace"
    other.mkdir(parents=True)
    (other / "secret_pair.md").write_text("paired instruction")
    api = socket.socket()
    api.bind(("127.0.0.1", 0))
    api.listen(1)
    echo, echo_port = _echo_server()

    task = tmp_path / "task"
    ws = task / "workspace"
    (ws / "agenthorizon_md").mkdir(parents=True)
    (ws / "agenthorizon_md" / "t.md").write_text("# Trajectory Report\n")
    (ws / "probe").mkdir()
    (ws / "probe" / "probe.py").write_text(PROBE)
    (ws / "probe" / "cfg.json").write_text(json.dumps({"labels_path": str(labels), "other_task": str(other),
                                                      "host_api_port": api.getsockname()[1], "echo_port": echo_port}))
    spec = SandboxSpec(task_dir=task, argv=["/usr/bin/python3", "-I", "/workspace/probe/probe.py"],
                       env={"PATH": "/usr/bin:/bin", "HOME": "/home/judge", "LANG": "C.UTF-8"},
                       allowed_hosts={"127.0.0.1"}, allowed_ports={443, echo_port},  # echo port: positive control
                       readonly_inputs=["agenthorizon_md", "probe"], timeout_s=60)
    try:
        r = run_in_sandbox(spec)
    finally:
        api.close()
        echo.close()
    assert r.exit_code == 0, (r.init_log, r.stderr())
    out = json.loads(r.stdout())

    # filesystem: no labels, no other tasks, no host home, minimal root
    assert out["read_host_labels"]["ok"] is False and out["read_host_labels"]["error"] == "FileNotFoundError"
    assert out["read_other_task"]["ok"] is False
    assert out["read_host_root_home"]["ok"] is False
    root = set(out["list_root"]["value"])
    assert root <= {"usr", "bin", "lib", "lib64", "sbin", "lib32", "libx32", "etc", "workspace", "home", "tmp", "out",
                    "dev", "proc", "run"}, root
    # staged inputs are read-only; scratch space is writable
    assert out["write_input"]["ok"] is False and out["modify_input"]["ok"] is False
    assert out["write_usr"]["ok"] is False
    assert out["write_workspace_scratch"]["ok"] is True and out["write_home"]["ok"] is True
    # network: no host services, no direct internet, no DNS; proxy enforces the allowlist
    assert out["host_api_loopback"]["ok"] is False
    assert out["direct_internet"]["ok"] is False
    assert out["dns"]["ok"] is False
    assert out["proxy_denied_host"]["value"].startswith("HTTP/1.1 403")
    assert "200" in out["proxy_allowed_host"]["value"] and out["proxy_allowed_host"]["value"].endswith("ping")
    decisions = {(d["host"], d["allowed"]) for d in r.egress_audit}
    assert ("example.com", False) in decisions and ("127.0.0.1", True) in decisions
    # privileges: zero capabilities, no_new_privs, isolated PID space
    st = out["proc_status"]["value"]
    assert int(st["CapEff"], 16) == 0 and int(st["CapPrm"], 16) == 0 and int(st["CapBnd"], 16) == 0
    assert st["NoNewPrivs"] == "1"
    assert max(out["visible_pids"]["value"]) < 50  # only sandbox processes
    assert out["mount_attempt"]["value"] != 0
    # environment: only what the adapter passed in
    assert set(out["env_keys"]["value"]) <= {"PATH", "HOME", "LANG", "PWD", "LC_CTYPE"}


def test_timeout_kills_the_whole_sandbox(tmp_path, available):
    spec = SandboxSpec(task_dir=tmp_path / "t", argv=["/usr/bin/sleep", "60"], env={"PATH": "/usr/bin"}, timeout_s=2)
    r = run_in_sandbox(spec)
    assert r.timed_out and r.exit_code is None and r.wall_time_s < 20


def test_cancellation_stops_execution(tmp_path, available):
    ev = threading.Event()
    threading.Timer(1.0, ev.set).start()
    r = run_in_sandbox(SandboxSpec(task_dir=tmp_path / "c", argv=["/usr/bin/sleep", "60"], env={"PATH": "/usr/bin"},
                                   timeout_s=120), cancel=ev)
    assert r.cancelled and r.exit_code is None


def test_missing_mount_source_never_runs_unconfined(tmp_path, available):
    spec = SandboxSpec(task_dir=tmp_path / "m", argv=["/usr/bin/true"], env={"PATH": "/usr/bin"},
                       tool_dirs=[str(tmp_path / "does-not-exist")], timeout_s=30)
    r = run_in_sandbox(spec)
    assert r.setup_failed and r.exit_code == 125
    assert "SANDBOX_SETUP_FAILED" in r.init_log


def test_tool_dirs_are_visible_read_only(tmp_path, available):
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "hello.sh").write_text("#!/bin/sh\necho hello-from-tool\n")
    (tools / "hello.sh").chmod(0o755)
    r = run_in_sandbox(SandboxSpec(task_dir=tmp_path / "v", argv=[str(tools / "hello.sh")], env={"PATH": "/usr/bin:/bin"},
                                   tool_dirs=[str(tools)], timeout_s=30))
    assert r.exit_code == 0 and r.stdout().strip() == "hello-from-tool"
    assert Path(tools / "hello.sh").read_text().startswith("#!/bin/sh")


ENDPOINT_PROBE = r'''
import json, socket, sys, urllib.error, urllib.request
cfg = json.load(open("/workspace/probe/cfg.json"))
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": "http://127.0.0.1:3128"}))
out = {}
def get(url, data=None):
    try:
        r = opener.open(urllib.request.Request(url, data=data), timeout=10)
        return {"status": r.status, "body": r.read().decode()}
    except urllib.error.HTTPError as e:
        return {"status": e.code}
    except Exception as e:
        return {"error": type(e).__name__}
ep = f"http://127.0.0.1:{cfg['port']}"
out["plain_get"] = get(ep + "/v1/models?x=1")
out["plain_post"] = get(ep + "/v1/chat/completions", data=b"x" * 70000)  # body larger than the proxy's head read
out["other_port"] = get(f"http://127.0.0.1:{cfg['other_port']}/v1/models")
out["other_host"] = get("http://example.com/")
s = socket.create_connection(("127.0.0.1", 3128), timeout=10)
s.sendall(f"CONNECT 127.0.0.1:{cfg['port']} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode())
head = s.recv(4096).decode()
s.sendall(b"GET /v1/models HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
buf = b""
while True:
    c = s.recv(4096)
    if not c:
        break
    buf += c
out["connect_tunnel"] = {"head": head.split("\r\n")[0], "body": buf.decode(errors="replace").split("\r\n\r\n", 1)[-1]}
s2 = socket.create_connection(("127.0.0.1", 3128), timeout=10)
s2.sendall(f"CONNECT 127.0.0.1:{cfg['other_port']} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".encode())
out["connect_other_port"] = s2.recv(4096).decode().split("\r\n")[0]
print(json.dumps(out))
'''


def test_self_hosted_endpoint_reachable_only_at_its_host_and_port(tmp_path, available):
    """A vLLM-style base_url (plain HTTP, non-443 port) is reachable from the sandbox; nothing else on that host is."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from agenthorizon.judging.isolation.egress import endpoint_of

    seen: list[tuple[str, str, int]] = []

    class H(BaseHTTPRequestHandler):
        def _reply(self, body: bytes):
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            seen.append(("GET", self.path, 0))
            self._reply(b"ok-models")

        def do_POST(self):  # noqa: N802
            n = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(n)
            seen.append(("POST", self.path, len(data)))
            self._reply(f"got {len(data)}".encode())

        def log_message(self, *a):
            pass

    servers = [ThreadingHTTPServer(("127.0.0.1", 0), H) for _ in range(2)]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    port, other = (s.server_address[1] for s in servers)
    task = tmp_path / "ep"
    (task / "workspace" / "probe").mkdir(parents=True)
    (task / "workspace" / "probe" / "probe.py").write_text(ENDPOINT_PROBE)
    (task / "workspace" / "probe" / "cfg.json").write_text(json.dumps({"port": port, "other_port": other}))
    spec = SandboxSpec(task_dir=task, argv=["/usr/bin/python3", "-I", "/workspace/probe/probe.py"],
                       env={"PATH": "/usr/bin:/bin", "HOME": "/home/judge", "LANG": "C.UTF-8"},
                       allowed_hosts=set(), direct_endpoints=endpoint_of(f"http://127.0.0.1:{port}/v1"),
                       readonly_inputs=["probe"], timeout_s=60)
    try:
        r = run_in_sandbox(spec)
    finally:
        for s in servers:
            s.shutdown()
    assert r.exit_code == 0, (r.init_log, r.stderr())
    out = json.loads(r.stdout())
    assert out["plain_get"] == {"status": 200, "body": "ok-models"}
    assert out["plain_post"] == {"status": 200, "body": "got 70000"}
    assert out["connect_tunnel"]["head"].startswith("HTTP/1.1 200") and out["connect_tunnel"]["body"] == "ok-models"
    assert out["other_port"] == {"status": 403} and out["other_host"] == {"status": 403}
    assert out["connect_other_port"].startswith("HTTP/1.1 403")
    assert ("GET", "/v1/models?x=1", 0) in seen and ("POST", "/v1/chat/completions", 70000) in seen
    audit = {(d["host"], d["port"], d["allowed"]) for d in r.egress_audit}
    assert {("127.0.0.1", port, True), ("127.0.0.1", other, False), ("example.com", 80, False)} <= audit
    assert endpoint_of("https://gpu-host.internal/v1") == {("gpu-host.internal", 443)}
    assert endpoint_of(None) == set() and endpoint_of("ftp://x/") == set()
