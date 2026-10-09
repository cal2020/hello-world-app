"""PID 1 of a judge sandbox. Standard library only; executed by path with ``python -I``.

Runs inside fresh user, mount, network, PID, IPC and UTS namespaces (created by ``unshare``):

1. builds a new root on tmpfs containing only explicitly listed bind mounts (system dirs read-only, the task
   workspace read-write with staged inputs read-only on top, a private HOME and /tmp);
2. ``pivot_root``s into it and detaches the old root, so nothing else on the host filesystem is reachable;
3. brings up loopback and forwards 127.0.0.1:<port> to the host egress proxy's Unix socket — the namespace has
   no other network interface, so every connection must pass the proxy's allowlist;
4. forks the harness after emptying the capability bounding, ambient, inheritable, permitted and effective
   sets and setting no_new_privs, so it cannot remount, unshare, or regain privileges;
5. reaps children and exits with the harness's status.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import errno
import fcntl
import json
import os
import signal
import socket
import struct
import sys
import threading

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
libc.umount2.argtypes = [ctypes.c_char_p, ctypes.c_int]
libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]

MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC = 1, 2, 4, 8
MS_REMOUNT, MS_BIND, MS_REC, MS_PRIVATE = 32, 4096, 16384, 1 << 18
MNT_DETACH = 2
PR_CAPBSET_DROP, PR_SET_NO_NEW_PRIVS, PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL = 24, 38, 47, 4
SYS_PIVOT_ROOT = 155  # x86_64
SYS_CAPSET = 126  # x86_64
LINUX_CAPABILITY_VERSION_3 = 0x20080522

LOG = None


def log(msg: str) -> None:
    if LOG:
        LOG.write(msg + "\n")
        LOG.flush()


def _check(rc: int, what: str) -> None:
    if rc != 0:
        e = ctypes.get_errno()
        raise OSError(e, f"{what}: {os.strerror(e)}")


def mount(src, dst, fstype, flags, data=None) -> None:
    _check(libc.mount(src.encode() if src else None, dst.encode(), fstype.encode() if fstype else None, flags,
                      ctypes.c_char_p(data.encode()) if data else None), f"mount {src} -> {dst}")


def locked_flags(path: str) -> int:
    st = os.statvfs(path)
    out = 0
    for st_flag, ms in ((os.ST_NOSUID, MS_NOSUID), (os.ST_NODEV, MS_NODEV), (os.ST_NOEXEC, MS_NOEXEC), (os.ST_RDONLY, MS_RDONLY)):
        if st.f_flag & st_flag:
            out |= ms
    return out


def bind(src: str, dst: str, ro: bool, is_file: bool = False) -> None:
    if is_file:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst):
            open(dst, "a").close()
    else:
        os.makedirs(dst, exist_ok=True)
    mount(src, dst, None, MS_BIND | MS_REC)
    flags = MS_REMOUNT | MS_BIND | MS_NOSUID | MS_NODEV | locked_flags(src)
    if ro:
        flags |= MS_RDONLY
    mount(None, dst, None, flags)


def lo_up() -> None:
    SIOCGIFFLAGS, SIOCSIFFLAGS, IFF_UP = 0x8913, 0x8914, 0x1
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        ifr = struct.pack("16sh", b"lo", 0)
        flags = struct.unpack("16sh", fcntl.ioctl(s, SIOCGIFFLAGS, ifr))[1]
        fcntl.ioctl(s, SIOCSIFFLAGS, struct.pack("16sh", b"lo", flags | IFF_UP))
    finally:
        s.close()


def forwarder(port: int, unix_path: str) -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(64)

    def pump(a, b):
        try:
            while True:
                d = a.recv(65536)
                if not d:
                    break
                b.sendall(d)
        except OSError:
            pass
        finally:
            for x in (a, b):
                try:
                    x.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def serve():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                u.connect(unix_path)
            except OSError:
                c.close()
                continue
            threading.Thread(target=pump, args=(c, u), daemon=True).start()
            threading.Thread(target=pump, args=(u, c), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()


def drop_all_privileges() -> None:
    for cap in range(0, 64):
        if libc.prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0 and ctypes.get_errno() == errno.EINVAL:
            break
    libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)
    header = struct.pack("Ii", LINUX_CAPABILITY_VERSION_3, 0)
    data = struct.pack("IIIIII", 0, 0, 0, 0, 0, 0)
    hb, db = ctypes.create_string_buffer(header), ctypes.create_string_buffer(data)
    _check(libc.syscall(SYS_CAPSET, hb, db), "capset")
    _check(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs")


def build_root(spec: dict) -> None:
    root = spec["new_root"]
    mount(None, "/", None, MS_REC | MS_PRIVATE)
    mount("tmpfs", root, "tmpfs", MS_NOSUID | MS_NODEV, "size=16m,mode=755")
    for b in sorted(spec["binds"], key=lambda b: b["dst"].count("/")):
        src = b["src"]
        if not os.path.exists(src):
            if b.get("optional"):
                continue
            raise FileNotFoundError(src)
        bind(src, root + b["dst"], b.get("ro", True), is_file=os.path.isfile(src))
    for d in spec.get("devices", []):
        bind(f"/dev/{d}", f"{root}/dev/{d}", ro=False, is_file=True)
    os.makedirs(f"{root}/dev/shm", exist_ok=True)
    mount("tmpfs", f"{root}/dev/shm", "tmpfs", MS_NOSUID | MS_NODEV, "size=64m,mode=1777")
    os.makedirs(f"{root}/proc", exist_ok=True)
    mount("proc", f"{root}/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC)
    for s in spec.get("symlinks", []):
        os.makedirs(os.path.dirname(root + s["dst"]), exist_ok=True)
        if not os.path.lexists(root + s["dst"]):
            os.symlink(s["target"], root + s["dst"])
    sock_dst = f"{root}/run/ah/egress.sock"
    os.makedirs(os.path.dirname(sock_dst), exist_ok=True)
    open(sock_dst, "a").close()
    mount(spec["egress_socket"], sock_dst, None, MS_BIND)
    old = f"{root}/.oldroot"
    os.makedirs(old, exist_ok=True)
    if libc.syscall(SYS_PIVOT_ROOT, root.encode(), old.encode()) != 0:
        raise OSError(ctypes.get_errno(), "pivot_root failed")
    os.chdir("/")
    _check(libc.umount2(b"/.oldroot", MNT_DETACH), "umount old root")
    os.rmdir("/.oldroot")
    mount(None, "/", None, MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV)


def main() -> int:
    global LOG
    arg = sys.argv[1]
    if arg.startswith("fd:"):  # spec (incl. credentials) arrives on an inherited pipe, never on disk
        with os.fdopen(int(arg[3:]), "r") as fh:
            spec = json.loads(fh.read())
    else:
        spec = json.loads(open(arg).read())
    LOG = open(spec["log_path"], "a", buffering=1)
    try:
        build_root(spec)
        lo_up()
        forwarder(int(spec["proxy_port"]), "/run/ah/egress.sock")
    except Exception as exc:  # setup failure: never run the harness unconfined
        log(f"SANDBOX_SETUP_FAILED {type(exc).__name__}: {exc}")
        return 125
    log("sandbox ready")
    pid = os.fork()
    if pid == 0:
        try:
            os.chdir(spec["cwd"])
            os.setsid()
            drop_all_privileges()
            os.execvpe(spec["argv"][0], spec["argv"], spec["env"])
        except Exception as exc:
            log(f"EXEC_FAILED {type(exc).__name__}: {exc}")
            os._exit(126)

    def forward(signum, _frame):
        try:
            os.killpg(pid, signum)
        except ProcessLookupError:
            pass

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward)
    status = 0
    while True:
        try:
            p, st = os.waitpid(-1, 0)
        except ChildProcessError:
            break
        except InterruptedError:
            continue
        if p == pid:
            status = os.waitstatus_to_exitcode(st)
            break
    log(f"harness exited {status}")
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    sys.exit(main())
