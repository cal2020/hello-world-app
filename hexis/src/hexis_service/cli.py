"""hexisctl - extension CLI (brief section 15). Not an upstream command.

Exit codes: 0 success, 2 invalid input, 3 validation/admission rejected,
4 runtime failure, 10 waiting for input or approval (an expected state, not
an error). ``--json`` prints structured output; otherwise a short summary.

Identities are simulated host principals selected with ``--as`` (demo only).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import app, canonical
from .compiler import FixtureCompilerModel, compile_skill
from .package import PackageError, load_package
from .registry import AdmissionRejected
from .runtime import RunError
from .traces import loads_jsonl, recorded_replay, structural_replay
from .update import DeterministicAligner, propose_update
from .validator import validate_package

EXIT_OK, EXIT_INVALID, EXIT_REJECTED, EXIT_RUNTIME, EXIT_WAITING = 0, 2, 3, 4, 10
PRINCIPALS = {"u-requester": app.REQUESTER, "u-approver": app.APPROVER, "u-other": app.OTHER_TENANT_APPROVER}


def _out(args, obj: dict, summary: str, code: int) -> int:
    if args.json:
        print(json.dumps({"exit_code": code, **obj}, indent=2, sort_keys=True, default=str))
    else:
        print(summary)
    return code


def _load(path: str):
    return canonical.load_file(path)


def cmd_compile(args) -> int:
    d = os.path.dirname(os.path.abspath(args.skill))
    fixture = args.fixture or os.path.join(d, "compiler_fixture.json")
    res = compile_skill(args.skill, _load(os.path.join(d, "tool_catalog.json")), _load(os.path.join(d, "contracts.json")),
                        _load(os.path.join(d, "execution_policy.json")), FixtureCompilerModel(fixture),
                        profile="production" if args.profile == "production" else "sandbox")
    if res.package:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w") as fh:
            fh.write(canonical.dumps_pretty(res.package))
    lines = [f"attempt {a['attempt']}: {'valid' if a['ok'] else 'rejected'} "
             f"{[f['code'] for f in a['findings']]}" for a in res.report["attempt_log"]]
    lines += [f"  {c['clause']:<34} {c['classification']:<22} {','.join(c['states']) or '-'}"
              for c in res.report["coverage"]]
    lines.append(f"package: {args.out if res.package else '(none)'} status={res.report['status']}")
    return _out(args, {"report": res.report, "package": args.out if res.package else None}, "\n".join(lines),
                EXIT_OK if res.ok else EXIT_REJECTED)


def cmd_validate(args) -> int:
    try:
        pkg = load_package(_load(args.package))
    except (PackageError, ValueError) as exc:
        return _out(args, {"error": str(exc)}, f"invalid package: {exc}", EXIT_INVALID)
    vr = validate_package(pkg, args.profile)
    summary = "\n".join([f"{f.severity.upper()} {f.code} {f.location}: {f.message}" for f in vr.findings] or ["ok"])
    return _out(args, vr.to_dict(), summary, EXIT_OK if vr.ok else EXIT_REJECTED)


def _trace_files(path: str) -> list[str]:
    if os.path.isdir(path):
        return sorted(os.path.join(path, f) for f in os.listdir(path) if f.endswith(".jsonl"))
    return [path]


def cmd_replay(args) -> int:
    pkg = load_package(_load(args.package))
    reports = []
    for f in _trace_files(args.archive):
        if args.mode == "structural":
            with open(f) as fh:
                reports.append(structural_replay(pkg, loads_jsonl(fh.read())).to_dict())
        elif args.mode == "recorded":
            reports.append(recorded_replay(pkg, _load(f)).to_dict())
        else:
            return _out(args, {"error": "sandbox_live replay runs through `hexisctl run` against a fresh data dir"},
                        "sandbox_live: use `hexisctl run` with a fresh --data directory", EXIT_INVALID)
    ok = all(r["result"] == "PASS" for r in reports)
    summary = "\n".join(f"{r['mode']} {r['trace_id']}: {r['result']} {r['detail']}" for r in reports)
    return _out(args, {"mode": args.mode, "reports": reports, "ok": ok}, summary, EXIT_OK if ok else EXIT_REJECTED)


def cmd_update(args) -> int:
    parent = _load(args.parent)
    with open(args.trace) as fh:
        trace = loads_jsonl(fh.read())
    protected = []
    if args.archive:
        for f in _trace_files(args.archive):
            with open(f) as fh:
                protected.append(loads_jsonl(fh.read()))
    prop = propose_update(parent, trace, protected, [], [DeterministicAligner()])
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"proposal-{trace['header']['trace_id']}.json")
    with open(path, "w") as fh:
        fh.write(canonical.dumps_pretty({"proposal": prop.to_dict(), "candidate": prop.candidate}))
    summary = "\n".join([f"attempt {a['attempt']}: {a['result']}" for a in prop.attempts] +
                        [f"status: {prop.status} (proposal only; nothing deployed) -> {path}"])
    return _out(args, {"proposal": prop.to_dict(), "path": path}, summary,
                EXIT_OK if prop.status in ("candidate_ready", "no_change") else EXIT_REJECTED)


def cmd_admit(args) -> int:
    svc = app.build_services(args.data)
    pkg = _load(args.package)
    try:
        svc.registry.register_draft(pkg)
        rec = svc.registry.admit(pkg, approver=args.approver, environment="local-offline")
        current = svc.registry.active(app.TENANT, pkg["machine"]["skill_id"])
        gen = svc.registry.promote(app.TENANT, pkg["artifact_hash"], args.expected_parent if args.expected_parent
                                   else (current[0] if current else None))
    except (AdmissionRejected, PackageError) as exc:
        return _out(args, {"error": str(exc), "report": getattr(exc, "report", None)}, f"rejected: {exc}", EXIT_REJECTED)
    return _out(args, {"admission": rec, "generation": gen}, f"active {pkg['artifact_hash']} generation {gen}", EXIT_OK)


def _status_code(cp: dict) -> int:
    if cp["status"].startswith("WAITING"):
        return EXIT_WAITING
    if cp["status"] == "COMPLETED":
        return EXIT_OK
    return EXIT_RUNTIME


def _cp_summary(cp: dict) -> str:
    s = f"run {cp['run_id']} r{cp['revision']} status={cp['status']} state={cp['state_id']}"
    if cp["pending"]:
        s += f" waiting on {cp['pending']['type']} interaction {cp['pending']['interaction_id']}"
    if cp["outcome"]:
        s += f" outcome={cp['outcome']['terminal']} ({cp['outcome']['kind']})"
    if cp["diagnostic"]:
        s += f" diagnostic={cp['diagnostic']['code']}: {cp['diagnostic']['message']}"
    return s


def cmd_run(args) -> int:
    svc = app.build_services(args.data)
    rt = app.runtime(svc)
    pkg = _load(args.package)
    who = PRINCIPALS[args.as_]
    try:
        handle = rt.start_run(pkg["artifact_hash"], _load(args.input), who, args.request_id or os.urandom(6).hex())
        cp = rt.run(handle["run_id"], who)
    except RunError as exc:
        code = EXIT_INVALID if exc.code == "INVALID_INPUT" else EXIT_REJECTED if exc.code == "NOT_ACTIVE" else EXIT_RUNTIME
        return _out(args, {"error": str(exc)}, str(exc), code)
    return _out(args, {"checkpoint": cp}, _cp_summary(cp), _status_code(cp))


def cmd_resume(args) -> int:
    svc = app.build_services(args.data)
    rt = app.runtime(svc)
    who = PRINCIPALS[args.as_]
    try:
        rt.resume_interaction(args.run, args.interaction, _load(args.response), who,
                              args.request_id or f"{args.run}:{args.interaction}")
        cp = rt.run(args.run, app.REQUESTER)
    except (RunError, PermissionError) as exc:
        return _out(args, {"error": str(exc)}, f"refused: {exc}", EXIT_REJECTED)
    return _out(args, {"checkpoint": cp}, _cp_summary(cp), _status_code(cp))


def cmd_continue(args) -> int:
    """Advance an existing run (after a crash, or to retry reconciliation)."""
    svc = app.build_services(args.data)
    try:
        cp = app.runtime(svc).run(args.run, PRINCIPALS[args.as_], worker_id=f"cli-{os.getpid()}")
    except RunError as exc:
        return _out(args, {"error": str(exc)}, str(exc), EXIT_REJECTED)
    return _out(args, {"checkpoint": cp}, _cp_summary(cp), _status_code(cp))


def cmd_inspect(args) -> int:
    svc = app.build_services(args.data)
    rep = app.runtime(svc).inspect_run(args.run, PRINCIPALS[args.as_])
    lines = [f"run {rep['run_id']} status={rep['status']} outcome={rep['outcome']}"]
    lines += [f"  #{e['sequence']} {e['type']} {e.get('from', '')} -> {e.get('to', '')}".rstrip(" ->")
              for e in rep["events"]]
    lines += [f"  action {a['tool']} {a['status']} attempts={a['attempts']} ref={a['external_ref']}"
              for a in rep["actions"]]
    lines += [f"  evidence {e['receipt_id']} {e['verifier']} {e['subject']} invalidated={e['invalidated_reason']}"
              for e in rep["evidence"]]
    return _out(args, rep, "\n".join(lines), EXIT_OK)


def cmd_demo(args) -> int:
    from .demo import run_demo
    rep = run_demo(args.data, scenario=args.scenario, quiet=args.json)
    return _out(args, rep, "", EXIT_OK) if args.json else EXIT_OK


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="hexisctl", description=__doc__.split("\n")[0])
    ap.add_argument("--json", action="store_true", help="structured JSON output")
    ap.add_argument("--data", default=os.environ.get("HEXIS_DATA", ".hexis-data"), help="state directory")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("compile"); p.add_argument("--skill", required=True)
    p.add_argument("--profile", default="production", choices=["production", "sandbox"])
    p.add_argument("--fixture"); p.add_argument("--out", default="build/package.json"); p.set_defaults(fn=cmd_compile)
    p = sub.add_parser("validate"); p.add_argument("--package", required=True)
    p.add_argument("--profile", default="production"); p.set_defaults(fn=cmd_validate)
    p = sub.add_parser("replay"); p.add_argument("--package", required=True); p.add_argument("--archive", required=True)
    p.add_argument("--mode", default="structural", choices=["structural", "recorded", "sandbox_live"])
    p.set_defaults(fn=cmd_replay)
    p = sub.add_parser("update"); p.add_argument("--parent", required=True); p.add_argument("--trace", required=True)
    p.add_argument("--archive"); p.add_argument("--out", default="proposals"); p.set_defaults(fn=cmd_update)
    p = sub.add_parser("admit"); p.add_argument("--package", required=True)
    p.add_argument("--approver", default="u-reviewer"); p.add_argument("--expected-parent")
    p.set_defaults(fn=cmd_admit)
    p = sub.add_parser("run"); p.add_argument("--package", required=True); p.add_argument("--input", required=True)
    p.add_argument("--as", dest="as_", default="u-requester", choices=sorted(PRINCIPALS))
    p.add_argument("--request-id"); p.set_defaults(fn=cmd_run)
    p = sub.add_parser("resume"); p.add_argument("--run", required=True); p.add_argument("--interaction", required=True)
    p.add_argument("--response", required=True); p.add_argument("--request-id")
    p.add_argument("--as", dest="as_", default="u-approver", choices=sorted(PRINCIPALS)); p.set_defaults(fn=cmd_resume)
    p = sub.add_parser("continue"); p.add_argument("--run", required=True)
    p.add_argument("--as", dest="as_", default="u-requester", choices=sorted(PRINCIPALS)); p.set_defaults(fn=cmd_continue)
    p = sub.add_parser("inspect"); p.add_argument("--run", required=True)
    p.add_argument("--as", dest="as_", default="u-requester", choices=sorted(PRINCIPALS)); p.set_defaults(fn=cmd_inspect)
    p = sub.add_parser("demo"); p.add_argument("name", choices=["procurement-onboarding"])
    p.add_argument("--scenario", default="full", choices=["full", "timeout-after-commit", "shortcut-rejection",
                                                          "refinement"])
    p.set_defaults(fn=cmd_demo)
    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except (canonical.StrictJSONError, FileNotFoundError) as exc:
        return _out(args, {"error": str(exc)}, f"invalid input: {exc}", EXIT_INVALID)


if __name__ == "__main__":
    sys.exit(main())
