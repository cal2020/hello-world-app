"""Local, embedded-style OPA runner (subprocess, no server, no network).

Two policy domains are kept apart:
  * the reviewed target-application bundle (fixtures/target-policy), analysed by checks;
  * quarantined candidates (e.g. model-generated Rego), only ever evaluated in a
    temporary directory against the independent tests with restricted capabilities.
Neither touches the workbench's own authorization (identity.py).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import config

# Built-ins a candidate policy must not reach: network, runtime environment, time-dependent
# randomness. The OS/process boundary (temp dir, empty env, timeout) is the outer control.
FORBIDDEN_BUILTIN_PREFIXES = ("http.", "net.", "opa.runtime", "rand.", "time.now_ns", "crypto.x509.parse_and_verify",
                              "io.jwt.decode_verify", "providers.")


class OpaUnavailable(RuntimeError):
    pass


def _bin() -> str:
    b = config.opa_bin()
    if not b:
        raise OpaUnavailable("OPA binary not found (set OPA_BIN or run scripts/fetch_opa.sh)")
    return b


def _run(args, *, cwd=None, stdin=None, timeout=30):
    env = {"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir()}  # no inherited secrets
    return subprocess.run([_bin(), *args], cwd=cwd, input=stdin, capture_output=True, text=True,
                          timeout=timeout, env=env)


def version() -> str:
    try:
        out = _run(["version"]).stdout
        return next((l.split(":", 1)[1].strip() for l in out.splitlines() if l.startswith("Version")), "unknown")
    except (OpaUnavailable, OSError) as e:
        return f"unavailable ({e})"


def check(bundle_dir: str, capabilities: str | None = None) -> dict:
    args = ["check", "--strict", bundle_dir]
    if capabilities:
        args[1:1] = ["--capabilities", capabilities]
    p = _run(args)
    return {"ok": p.returncode == 0, "stderr": p.stderr.strip()[:4000]}


def test(bundle_dir: str, capabilities: str | None = None) -> dict:
    """Run `opa test --fail-on-empty` and count pass/fail/error/skip. Empty suite is an error."""
    args = ["test", bundle_dir, "--fail-on-empty", "--format", "json"]
    if capabilities:
        args += ["--capabilities", capabilities]
    p = _run(args)
    out = {"exit_code": p.returncode, "passed": 0, "failed": 0, "errored": 0, "skipped": 0,
           "failed_names": [], "errored_names": [], "stderr": p.stderr.strip()[:2000]}
    try:
        results = json.loads(p.stdout or "[]")
    except json.JSONDecodeError:
        out["errored"] = 1
        out["stderr"] = (out["stderr"] + " | unparseable test output").strip()
        return out
    if not results:
        out["empty"] = True
    for r in results:
        name = r.get("name")
        if r.get("error"):
            out["errored"] += 1
            out["errored_names"].append(name)
        elif r.get("fail"):
            out["failed"] += 1
            out["failed_names"].append(name)
        elif r.get("skip"):
            out["skipped"] += 1
        else:
            out["passed"] += 1
    return out


def eval_decisions(policy_files: list[str], query_pkg: str, inputs: list[dict]) -> list[dict]:
    """Evaluate the decision for many inputs in one process."""
    q = f"[d | some c in input.cases; d := {query_pkg}.decision with input as c]"
    args = ["eval", "--format", "json", "--stdin-input"]
    for f in policy_files:
        args += ["-d", f]
    args.append(q)
    p = _run(args, stdin=json.dumps({"cases": inputs}))
    if p.returncode != 0:
        raise RuntimeError(f"opa eval failed: {p.stderr.strip()[:500]}")
    res = json.loads(p.stdout)
    return res["result"][0]["expressions"][0]["value"]


def restricted_capabilities(dest: Path) -> Path:
    caps = json.loads(_run(["capabilities", "--current"]).stdout)
    caps["builtins"] = [b for b in caps["builtins"]
                        if not any(b["name"].startswith(px) for px in FORBIDDEN_BUILTIN_PREFIXES)]
    caps["allow_net"] = []
    dest.write_text(json.dumps(caps))
    return dest


def evaluate_candidate(candidate_rego: str, tests_dir: Path = None) -> dict:
    """Quarantine: copy ONLY the candidate + the independent tests into a temp dir.

    The reviewed bundle is never modified; the result reports its digest before/after.
    """
    from .reference import policy_bundle
    tests_dir = tests_dir or config.POLICY_DIR
    before = policy_bundle()["policy_digest"]
    # Two temp dirs: the capabilities JSON must not sit in the policy dir, or OPA loads it as data.
    with tempfile.TemporaryDirectory(prefix="dmmc-candidate-") as td, \
            tempfile.TemporaryDirectory(prefix="dmmc-caps-") as cd:
        td = Path(td)
        (td / "candidate.rego").write_text(candidate_rego)
        for t in tests_dir.glob("*_test.rego"):
            shutil.copy(t, td / t.name)
        caps = str(restricted_capabilities(Path(cd) / "caps.json"))
        compiled = check(str(td / "candidate.rego"), capabilities=caps)
        if not compiled["ok"]:
            result = {"verdict": "REJECTED_AT_COMPILE", "compile": compiled}
        else:
            t = test(str(td), capabilities=caps)
            ok = t["failed"] == 0 and t["errored"] == 0 and t["passed"] > 0 and t["exit_code"] == 0
            result = {"verdict": "MATCHES_INDEPENDENT_TESTS" if ok else "FAILS_INDEPENDENT_TESTS", "tests": t}
    after = policy_bundle()["policy_digest"]
    result["enforcement_policy_digest_before"] = before
    result["enforcement_policy_digest_after"] = after
    result["enforcement_policy_unchanged"] = before == after
    result["note"] = "Candidate is advisory. Passing these tests would still not promote it; promotion is out of scope."
    return result
