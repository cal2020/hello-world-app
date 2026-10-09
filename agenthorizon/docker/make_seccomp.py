"""Build docker/seccomp-judge.json from Docker's default seccomp profile.

The judge worker creates a fresh user, mount, network, PID, IPC and UTS namespace per attempt (``unshare``), mounts a
private root inside it and ``pivot_root``s into it (src/agenthorizon/judging/isolation/). Docker's default profile only
allows ``unshare``/``mount``/``umount2``/``sethostname`` to containers holding CAP_SYS_ADMIN and never allows
``pivot_root``. The judge container holds no capabilities at all (``cap_drop: [ALL]``), so instead of granting
CAP_SYS_ADMIN or disabling seccomp, this profile adds exactly those five syscalls back. The kernel still confines them:
without capabilities in the container's own namespaces they only succeed inside the new user namespace the sandbox
creates, so they cannot change the container's mounts or hostname.

    python3 -I docker/make_seccomp.py <default.json> > docker/seccomp-judge.json

Base used for the committed profile: github.com/moby/profiles tag seccomp/v0.1.0, seccomp/default.json
(file sha256 01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28; canonical-JSON digest below, which
tests/test_packaging.py checks against the committed profile minus the one added rule).
"""

from __future__ import annotations

import json
import sys

NESTED_SANDBOX_SYSCALLS = ["mount", "pivot_root", "sethostname", "umount2", "unshare"]
BASE_CANONICAL_SHA256 = "7ce699efbba58df5691185a87189ecc0a47ff01c48ec8fc5708465954b672979"


def canonical_sha256(obj: dict) -> str:
    import hashlib

    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def build(default: dict) -> dict:
    profile = json.loads(json.dumps(default))
    profile["syscalls"].append({
        "names": NESTED_SANDBOX_SYSCALLS,
        "action": "SCMP_ACT_ALLOW",
        "comment": "AgentHorizon judge sandbox: per-attempt user/mount namespaces and pivot_root without CAP_SYS_ADMIN "
                   "(docker/make_seccomp.py)",
    })
    return profile


if __name__ == "__main__":
    with open(sys.argv[1]) as f:
        json.dump(build(json.load(f)), sys.stdout, indent=1)
    sys.stdout.write("\n")
