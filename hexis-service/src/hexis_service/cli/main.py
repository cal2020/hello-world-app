"""hexisctl - extension CLI (a proposed wrapper, not an upstream command).

Exit codes: 0 success · 2 invalid input · 3 validation/gate rejection · 4 runtime failure ·
5 expected waiting state (approval/input/reconciliation). ``--json`` prints structured output.

Runs use the offline procurement connectors (fixture mode) and simulated identities (``--as``).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

EXIT_OK, EXIT_INVALID, EXIT_REJECTED, EXIT_RUNTIME, EXIT_WAITING = 0, 2, 3, 4, 5
WAITING = ("WAITING_FOR_APPROVAL", "WAITING_FOR_INPUT", "RECONCILING")


def _emit(args: argparse.Namespace, human: str, data: Any) -> None:
    if args.json:
        print(json.dumps(data, indent=2, sort_keys=True, default=str))
    else:
        print(human)


def _load(path: str) -> Any:
    from ..canonical import strict_loads
    return strict_loads(Path(path).read_bytes())


def _pkg(path: str):
    from ..artifacts.package import MachinePackage
    return MachinePackage.from_json(_load(path))


def _traces(path: str | None) -> list:
    from ..traces.model import Trace
    if not path:
        return []
    p = Path(path)
    files = sorted(p.glob("*.jsonl")) if p.is_dir() else [p]
    out = []
    for f in files:
        t, errs = Trace.from_jsonl(f.read_text())
        if errs:
            print(f"warning: {f}: {errs}", file=sys.stderr)
        out.append(t)
    return out


def _model(spec: str):
    if spec == "fixture":
        from ..demo.fakes import FixtureExtractionModel
        return FixtureExtractionModel()
    if spec.startswith("anthropic:"):
        from ..models.anthropic_adapter import AnthropicModelAdapter
        return AnthropicModelAdapter(spec.split(":", 1)[1])
    raise SystemExit(f"unknown model spec {spec!r} (use 'fixture' or 'anthropic:<model-id>')")


def _env(args: argparse.Namespace):
    from ..demo.env import build_env
    return build_env(args.state, model=_model(getattr(args, "model", "fixture")))


def cmd_compile(args: argparse.Namespace) -> int:
    from ..compiler.compile import SkillSource, compile_skill, coverage_markdown
    from ..demo.env import load_catalog
    from ..demo.procurement_fixture import FixtureCompilerModel, deployment_policy
    if args.compiler != "fixture":
        _emit(args, "only the fixture compiler model is wired in this build (see docs/LIMITATIONS.md)",
              {"error": "compiler model not implemented", "compiler": args.compiler})
        return EXIT_INVALID
    src = SkillSource(path=args.skill, text=Path(args.skill).read_text())
    res = compile_skill(src, load_catalog(), deployment_policy(args.profile), FixtureCompilerModel())
    if res.package is not None:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(res.package.to_json(), indent=2) + "\n")
    _emit(args, f"{res.status}: {res.package.artifact_hash if res.package else '-'} -> {args.out}\n"
                + coverage_markdown(res.coverage), res.to_json())
    return EXIT_OK if res.status == "validated" else EXIT_REJECTED


def cmd_validate(args: argparse.Namespace) -> int:
    from ..artifacts.validate import validate_package
    from ..demo.env import load_catalog
    rep = validate_package(_pkg(args.package), load_catalog(), args.profile,
                           skill_text=Path(args.skill).read_text() if args.skill else None)
    lines = [f"{'PASS' if rep.passed else 'REJECTED'} ({len(rep.errors)} errors)"] + \
            [f"  {f.severity} {f.code} {f.state or ''} {f.message}" for f in rep.findings]
    _emit(args, "\n".join(lines), rep.to_json())
    return EXIT_OK if rep.passed else EXIT_REJECTED


def cmd_replay(args: argparse.Namespace) -> int:
    from ..replay.replay import replay
    pkg = _pkg(args.package)
    reps = [replay(pkg, t, args.mode) for t in _traces(args.archive)]
    _emit(args, "\n".join(f"{r.status:10} {r.mode} {r.trace_id} {r.detail}" for r in reps),
          [r.to_json() for r in reps])
    return EXIT_OK if reps and all(r.status == "PASS" for r in reps) else EXIT_REJECTED


def cmd_update(args: argparse.Namespace) -> int:
    from ..demo import reference as R
    from ..demo.env import load_catalog, skill_source
    from ..traces.update import propose_update
    aligner = {"fixture": R.FixtureAligner(), "shortcut": R.ShortcutAligner()}[args.aligner]
    trace = _traces(args.trace)[0]
    prop = propose_update(_pkg(args.parent), trace, _traces(args.archive), _traces(args.negative), load_catalog(),
                          aligner, skill_source().text)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "proposal.json").write_text(json.dumps(prop.to_json(), indent=2, default=str) + "\n")
    if prop.candidate is not None:
        (out / "candidate_package.json").write_text(json.dumps(prop.candidate.to_json(), indent=2) + "\n")
    _emit(args, f"{prop.status} (proposal only; not deployed) -> {out}\n" + "\n".join(prop.diagnostics),
          prop.to_json())
    return EXIT_OK if prop.status in ("CANDIDATE", "NO_CHANGE") else EXIT_REJECTED


def cmd_admit(args: argparse.Namespace) -> int:
    from ..artifacts.registry import admit
    from ..demo.env import skill_source
    from ..traces.update import archive_manifest
    env = _env(args)
    pkg = _pkg(args.package)
    res = admit(env.store, pkg, env.catalog, expected_parent_hash=args.expected_parent or None,
                approver=env.principal(args.as_), environment="sandbox",
                archive_manifest=archive_manifest(_traces(args.archive), _traces(args.negative)), now=env.clock(),
                skill_text=skill_source().text)
    _emit(args, f"{res.status} {res.artifact_hash} {res.reasons}", res.__dict__)
    return EXIT_OK if res.status == "ADMITTED" else EXIT_REJECTED


def _step_out(args: argparse.Namespace, res) -> int:
    data = {"status": res.status, "detail": res.detail, "revision": res.checkpoint.revision,
            "state": res.checkpoint.state_id, "outcome": res.checkpoint.outcome, "run_id": res.checkpoint.run_id,
            "interaction": res.interaction}
    _emit(args, f"{res.checkpoint.run_id}: {res.status} at {res.checkpoint.state_id} {res.detail}"
                + (f"\n  interaction {res.interaction['interaction_id']} scope {res.interaction['scope_digest']}"
                   if res.interaction else ""), data)
    if res.status in WAITING:
        return EXIT_WAITING
    return EXIT_OK if res.status == "COMPLETED" else EXIT_RUNTIME


def cmd_run(args: argparse.Namespace) -> int:
    from ..runtime.service import RunError
    env = _env(args)
    who = env.principal(args.as_)
    pkg_ref = args.package
    h = pkg_ref if pkg_ref.startswith("sha256:") else _pkg(pkg_ref).artifact_hash
    try:
        handle = env.service.start_run(h, _load(args.input), who, request_id=args.request_id or "")
        return _step_out(args, env.service.run_until_blocked(handle.run_id, who))
    except RunError as exc:
        _emit(args, f"error {exc.code}: {exc.message}", {"error": exc.code, "message": exc.message})
        return EXIT_INVALID if exc.code in ("TASK_INPUT_INVALID", "ARTIFACT_NOT_ADMITTED", "ARTIFACT_REVOKED",
                                            "UNKNOWN_ARTIFACT") else EXIT_RUNTIME


def cmd_resume(args: argparse.Namespace) -> int:
    from ..runtime.service import RunError
    env = _env(args)
    try:
        env.service.resume_interaction(args.run, args.interaction, _load(args.response), env.principal(args.as_),
                                       request_id=args.request_id or "")
        run = env.store.get_run(env.principal(args.as_).tenant_id, args.run)
        return _step_out(args, env.service.run_until_blocked(args.run, env.principal(run["principal"])))
    except RunError as exc:
        _emit(args, f"error {exc.code}: {exc.message}", {"error": exc.code, "message": exc.message})
        return EXIT_INVALID


def cmd_inspect(args: argparse.Namespace) -> int:
    env = _env(args)
    rep = env.service.inspect_run(args.run, env.principal(args.as_))
    _emit(args, f"{rep['run']['run_id']} {rep['run']['status']}\n  path: {' -> '.join(rep['path'])}\n"
                f"  outcome: {rep['outcome']}\n  assurance: {rep['assurance']}", rep)
    return EXIT_OK


def cmd_demo(args: argparse.Namespace) -> int:
    from ..demo.procurement_demo import run_demo
    summary = run_demo(args.out, args.scenario, say=(lambda s: None) if args.json else print)
    if args.json:
        print(json.dumps(summary, indent=2, default=str))
    ok = summary["steps"]["run"]["erp_drafts"] == 1 and summary["steps"]["shortcut"]["active_unchanged"]
    return EXIT_OK if ok else EXIT_RUNTIME


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="hexisctl")
    p.add_argument("--json", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name: str, fn, *opts: tuple) -> argparse.ArgumentParser:
        sp = sub.add_parser(name)
        sp.set_defaults(fn=fn)
        for flag, kw in opts:
            sp.add_argument(*flag if isinstance(flag, tuple) else (flag,), **kw)
        sp.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        return sp

    state = ("--state", {"default": "build/state"})
    who = (("--as",), {"dest": "as_", "default": "user:alice"})
    model = ("--model", {"default": "fixture"})
    add("compile", cmd_compile, ("--skill", {"required": True}), ("--profile", {"default": "sandbox"}),
        ("--out", {"default": "build/package.json"}), ("--compiler", {"default": "fixture"}))
    add("validate", cmd_validate, ("--package", {"required": True}), ("--profile", {"default": "production"}),
        ("--skill", {"default": None}))
    add("replay", cmd_replay, ("--package", {"required": True}), ("--archive", {"required": True}),
        ("--mode", {"choices": ["structural", "recorded"], "default": "structural"}))
    add("update", cmd_update, ("--parent", {"required": True}), ("--trace", {"required": True}),
        ("--archive", {"default": None}), ("--negative", {"default": None}), ("--out", {"default": "proposals"}),
        ("--aligner", {"choices": ["fixture", "shortcut"], "default": "fixture"}))
    add("admit", cmd_admit, ("--package", {"required": True}), ("--expected-parent", {"default": ""}),
        ("--archive", {"default": None}), ("--negative", {"default": None}), state,
        (("--as",), {"dest": "as_", "default": "user:dana"}))
    add("run", cmd_run, ("--package", {"required": True}), ("--input", {"required": True}),
        ("--request-id", {"default": ""}), state, who, model)
    add("resume", cmd_resume, ("--run", {"required": True}), ("--interaction", {"required": True}),
        ("--response", {"required": True}), ("--request-id", {"default": ""}), state,
        (("--as",), {"dest": "as_", "default": "user:bob"}), model)
    add("inspect", cmd_inspect, ("--run", {"required": True}), state, who)
    add("demo", cmd_demo, ("scenario_name", {"nargs": "?", "default": "procurement-onboarding"}),
        ("--scenario", {"choices": ["full", "timeout-after-commit"], "default": "full"}),
        ("--out", {"default": "build/demo"}))
    args = p.parse_args(argv)
    try:
        return args.fn(args)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
