"""OPA runner with two backends. No server, no network in either.

Two policy domains are kept apart:
  * the reviewed target-application bundle (fixtures/target-policy), analysed by checks;
  * quarantined candidates (e.g. model-generated Rego), only ever evaluated in a
    temporary directory against the independent tests with restricted capabilities.
Neither touches the workbench's own authorization (identity.py).

Backends (DMMC_OPA_BACKEND):
  cli   the pinned OPA binary as a subprocess (default on a normal Python).
  wasm  policies and their test rules pre-compiled to WebAssembly by the pinned OPA at build
        time (scripts/build_web.py), evaluated live here. Used in the browser build (Pyodide),
        and testable on a normal Python through a Node bridge. Rego cannot be compiled in this
        mode: a bundle whose content digest was not compiled at build time is reported as
        unavailable (the check becomes ERROR), never guessed.

Recording (DMMC_OPA_RECORD=<dir>, cli backend only): every bundle the CLI touches is written
to <dir> with its CLI result, so the build can compile exactly those bundles to Wasm and
cross-check Wasm results against the CLI.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from . import config
from .util import digest_obj, sha256

# Built-ins a candidate policy must not reach: network, runtime environment, time-dependent
# randomness. The OS/process boundary (temp dir, empty env, timeout) is the outer control.
FORBIDDEN_BUILTIN_PREFIXES = ("http.", "net.", "opa.runtime", "rand.", "time.now_ns", "crypto.x509.parse_and_verify",
                              "io.jwt.decode_verify", "providers.")
DECISION_ENTRYPOINT = "mtel/authz/decision"
TEST_RULE = re.compile(r"^(test_[A-Za-z0-9_]+)\b", re.M)


class OpaUnavailable(RuntimeError):
    pass


def backend() -> str:
    b = os.environ.get("DMMC_OPA_BACKEND")
    if b:
        return b
    return "wasm" if sys.platform == "emscripten" else "cli"


# --- bundle identity ---------------------------------------------------------------

def rego_files(path: str | Path) -> list[Path]:
    p = Path(path)
    return sorted(p.glob("*.rego")) if p.is_dir() else [p]


def bundle_key(files: list[Path], restricted: bool) -> str:
    """Content-addressed identity of a set of Rego files (names are irrelevant)."""
    return digest_obj({"rego": sorted(sha256(f.read_bytes()) for f in files),
                       "caps": "restricted" if restricted else "default"})


def _record(op: str, files: list[Path], restricted: bool, result, extra: dict | None = None):
    out = os.environ.get("DMMC_OPA_RECORD")
    if not out:
        return
    key = bundle_key(files, restricted)
    rec = {"op": op, "key": key, "restricted": restricted, "result": result,
           "files": {f.name: f.read_text() for f in files}, **(extra or {})}
    d = Path(out)
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{op}-{key[:16]}-{sha256(json.dumps(rec, sort_keys=True))[:10]}.json").write_text(json.dumps(rec))


# --- CLI backend --------------------------------------------------------------------

def _bin() -> str:
    b = config.opa_bin()
    if not b:
        raise OpaUnavailable("OPA binary not found (set OPA_BIN or run scripts/fetch_opa.sh)")
    return b


def _run(args, *, cwd=None, stdin=None, timeout=30):
    env = {"PATH": "/usr/bin:/bin", "HOME": tempfile.gettempdir()}  # no inherited secrets
    return subprocess.run([_bin(), *args], cwd=cwd, input=stdin, capture_output=True, text=True,
                          timeout=timeout, env=env)


def restricted_capabilities(dest: Path) -> Path:
    caps = json.loads(_run(["capabilities", "--current"]).stdout)
    caps["builtins"] = [b for b in caps["builtins"]
                        if not any(b["name"].startswith(px) for px in FORBIDDEN_BUILTIN_PREFIXES)]
    caps["allow_net"] = []
    dest.write_text(json.dumps(caps))
    return dest


class _Caps:
    """Restricted capabilities file, kept OUTSIDE the policy dir (OPA would load it as data)."""

    def __init__(self, restricted: bool):
        self.restricted = restricted
        self._dir = None

    def __enter__(self):
        if not self.restricted:
            return []
        self._dir = tempfile.TemporaryDirectory(prefix="dmmc-caps-")
        return ["--capabilities", str(restricted_capabilities(Path(self._dir.name) / "caps.json"))]

    def __exit__(self, *a):
        if self._dir:
            self._dir.cleanup()


def _cli_check(path, restricted):
    with _Caps(restricted) as caps:
        p = _run(["check", "--strict", *caps, str(path)])
    return {"ok": p.returncode == 0, "stderr": p.stderr.strip()[:4000]}


def _parse_test_output(returncode, stdout, stderr):
    out = {"exit_code": returncode, "passed": 0, "failed": 0, "errored": 0, "skipped": 0,
           "failed_names": [], "errored_names": [], "stderr": stderr.strip()[:2000]}
    try:
        results = json.loads(stdout or "[]")
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


def _cli_test(path, restricted):
    with _Caps(restricted) as caps:
        p = _run(["test", str(path), "--fail-on-empty", "--format", "json", *caps])
    return _parse_test_output(p.returncode, p.stdout, p.stderr)


def _cli_eval_decisions(policy_files, query_pkg, inputs):
    q = f"[d | some c in input.cases; d := {query_pkg}.decision with input as c]"
    args = ["eval", "--format", "json", "--stdin-input"]
    for f in policy_files:
        args += ["-d", str(f)]
    args.append(q)
    p = _run(args, stdin=json.dumps({"cases": inputs}))
    if p.returncode != 0:
        raise RuntimeError(f"opa eval failed: {p.stderr.strip()[:500]}")
    return json.loads(p.stdout)["result"][0]["expressions"][0]["value"]


# --- Wasm backend -------------------------------------------------------------------

_REGISTRY = None
_BRIDGE = None


def _registry() -> dict:
    global _REGISTRY
    if _REGISTRY is None:
        p = config.wasm_registry_path()
        if not p.exists():
            raise OpaUnavailable(f"Wasm policy registry not found at {p} (run scripts/build_web.py)")
        _REGISTRY = json.loads(p.read_text())
    return _REGISTRY


def _entry(files, restricted, what):
    key = bundle_key(files, restricted)
    e = _registry()["bundles"].get(key)
    if e is None:
        raise OpaUnavailable(
            f"no build-time compilation for this {what} (bundle {key[:12]}); the Wasm build can only evaluate "
            "Rego that was compiled when the site was built")
    return key, e


class _JsBridge:
    """Browser: wasm modules are pre-loaded by the page's worker and exposed as globalThis.dmmcOpa."""

    def __init__(self):
        import js  # type: ignore  # only exists under Pyodide
        self._opa = js.dmmcOpa

    def evaluate(self, module: str, entrypoint: str, input_obj) -> list:
        return json.loads(str(self._opa.evaluate(module, entrypoint, json.dumps(input_obj))))


class _NodeBridge:
    """Normal Python: one long-lived node process running the same opa-wasm library as the browser."""

    def __init__(self):
        script = config.ROOT / "scripts" / "opa_wasm_bridge.cjs"
        self._p = subprocess.Popen(["node", str(script), str(config.wasm_registry_path().parent)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def evaluate(self, module: str, entrypoint: str, input_obj) -> list:
        self._p.stdin.write(json.dumps({"module": module, "entrypoint": entrypoint, "input": input_obj}) + "\n")
        self._p.stdin.flush()
        line = self._p.stdout.readline()
        if not line:
            raise OpaUnavailable("opa-wasm node bridge exited")
        msg = json.loads(line)
        if "error" in msg:
            raise RuntimeError(msg["error"])
        return msg["result"]


def _bridge():
    global _BRIDGE
    if _BRIDGE is None:
        _BRIDGE = _JsBridge() if sys.platform == "emscripten" else _NodeBridge()
    return _BRIDGE


def _wasm_check(path, restricted):
    _, e = _entry(rego_files(path), restricted, "policy")
    # Compilation happened at build time with the pinned CLI; its verdict is part of the build.
    return dict(e["check"], compiled_at_build=True)


def _wasm_test(path, restricted):
    _, e = _entry(rego_files(path), restricted, "policy test bundle")
    out = {"exit_code": 0, "passed": 0, "failed": 0, "errored": 0, "skipped": 0,
           "failed_names": [], "errored_names": [], "stderr": ""}
    if not e.get("tests_module"):
        if not e["check"]["ok"]:
            out.update(exit_code=1, errored=1, stderr=e["check"]["stderr"])
            return out
        out.update(exit_code=1, empty=True, stderr="no tests were run")  # same as `opa test --fail-on-empty`
        return out
    for name in e["test_entrypoints"]:
        short = name.rsplit("/", 1)[1]
        try:
            r = _bridge().evaluate(e["tests_module"], name, {})
            if r and r[0].get("result") is True:
                out["passed"] += 1
            else:
                out["failed"] += 1
                out["failed_names"].append(short)
        except Exception as ex:  # an evaluator error is not a test failure
            out["errored"] += 1
            out["errored_names"].append(short)
            out["stderr"] = f"{type(ex).__name__}: {ex}"[:2000]
    if out["failed"] or out["errored"]:
        out["exit_code"] = 2
    return out


def _wasm_eval_decisions(policy_files, query_pkg, inputs):
    if query_pkg != "data.mtel.authz":
        raise OpaUnavailable(f"only {DECISION_ENTRYPOINT} is compiled to Wasm")
    _, e = _entry([Path(f) for f in policy_files], False, "policy")
    if not e.get("decision_module"):
        raise OpaUnavailable("policy did not compile to a decision module at build time")
    out = []
    for c in inputs:
        r = _bridge().evaluate(e["decision_module"], DECISION_ENTRYPOINT, c)
        if not r:
            raise RuntimeError("decision undefined")
        out.append(r[0]["result"])
    return out


# --- public API (backend-independent) ----------------------------------------------------

def version() -> str:
    if backend() == "wasm":
        try:
            return f"{_registry()['opa_version']} (Wasm; Rego compiled at site build)"
        except OpaUnavailable as e:
            return f"unavailable ({e})"
    try:
        out = _run(["version"]).stdout
        return next((l.split(":", 1)[1].strip() for l in out.splitlines() if l.startswith("Version")), "unknown")
    except (OpaUnavailable, OSError) as e:
        return f"unavailable ({e})"


def check(path: str, restricted: bool = False) -> dict:
    if backend() == "wasm":
        return _wasm_check(path, restricted)
    r = _cli_check(path, restricted)
    _record("check", rego_files(path), restricted, r)
    return r


def test(bundle_dir: str, restricted: bool = False) -> dict:
    """`opa test --fail-on-empty` semantics: counts pass/fail/error/skip; an empty suite is an error."""
    if backend() == "wasm":
        return _wasm_test(bundle_dir, restricted)
    r = _cli_test(bundle_dir, restricted)
    _record("test", rego_files(bundle_dir), restricted, r)
    return r


def eval_decisions(policy_files: list[str], query_pkg: str, inputs: list[dict]) -> list[dict]:
    """Evaluate the decision for many inputs."""
    if backend() == "wasm":
        return _wasm_eval_decisions(policy_files, query_pkg, inputs)
    r = _cli_eval_decisions(policy_files, query_pkg, inputs)
    _record("eval", [Path(f) for f in policy_files], False, r, {"inputs": inputs, "query_pkg": query_pkg})
    return r


def evaluate_candidate(candidate_rego: str, tests_dir: Path = None) -> dict:
    """Quarantine: copy ONLY the candidate + the independent tests into a temp dir.

    The reviewed bundle is never modified; the result reports its digest before/after.
    """
    from .reference import policy_bundle
    tests_dir = tests_dir or config.POLICY_DIR
    before = policy_bundle()["policy_digest"]
    with tempfile.TemporaryDirectory(prefix="dmmc-candidate-") as td:
        td = Path(td)
        (td / "candidate.rego").write_text(candidate_rego)
        for t in tests_dir.glob("*_test.rego"):
            shutil.copy(t, td / t.name)
        compiled = check(str(td / "candidate.rego"), restricted=True)
        if not compiled["ok"]:
            result = {"verdict": "REJECTED_AT_COMPILE", "compile": compiled}
        else:
            t = test(str(td), restricted=True)
            ok = t["failed"] == 0 and t["errored"] == 0 and t["passed"] > 0 and t["exit_code"] == 0
            result = {"verdict": "MATCHES_INDEPENDENT_TESTS" if ok else "FAILS_INDEPENDENT_TESTS", "tests": t}
    after = policy_bundle()["policy_digest"]
    result["enforcement_policy_digest_before"] = before
    result["enforcement_policy_digest_after"] = after
    result["enforcement_policy_unchanged"] = before == after
    result["backend"] = backend()
    result["note"] = "Candidate is advisory. Passing these tests would still not promote it; promotion is out of scope."
    return result


def test_rule_names(files: list[Path]) -> list[str]:
    """Test rules in *_test.rego files, as Wasm entrypoints (package path + rule)."""
    names = []
    for f in files:
        if not f.name.endswith("_test.rego"):
            continue
        text = f.read_text()
        pkg = re.search(r"^package\s+([\w.]+)", text, re.M).group(1).replace(".", "/")
        names += [f"{pkg}/{m}" for m in dict.fromkeys(TEST_RULE.findall(text))]
    return names
