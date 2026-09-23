"""CLI: python -m workbench <command>"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import db, demo, export, importer, impact, opa, packages, review


def main(argv=None):
    ap = argparse.ArgumentParser(prog="workbench", description="DMMC model-to-evidence workbench (synthetic demo)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("reset", help="wipe local state; seed users and pinned reference data")
    d = sub.add_parser("demo", help="reset and run the five-step demonstration")
    d.add_argument("--mode", default="fixture", choices=["fixture", "fixture-seeded", "live"])
    s = sub.add_parser("serve", help="run the local web UI")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    i = sub.add_parser("import-model")
    i.add_argument("path")
    i.add_argument("--actor", default="bob")
    e = sub.add_parser("import-evidence")
    e.add_argument("dir")
    e.add_argument("--actor", default="bob")
    b = sub.add_parser("build")
    b.add_argument("--actor", default="bob")
    b.add_argument("--mode", default="fixture", choices=["fixture", "fixture-seeded", "live"])
    st = sub.add_parser("status")
    st.add_argument("package_id")
    rv = sub.add_parser("review")
    rv.add_argument("package_id")
    rv.add_argument("decision", choices=review.DECISIONS)
    rv.add_argument("reason")
    rv.add_argument("--actor", default="alice")
    ex = sub.add_parser("export")
    ex.add_argument("package_id")
    ex.add_argument("--mode", default="current", choices=["current", "historical"])
    ex.add_argument("--actor", default="alice")
    im = sub.add_parser("impact")
    im.add_argument("from_snapshot")
    im.add_argument("to_snapshot")
    cand = sub.add_parser("candidate", help="evaluate a quarantined candidate Rego file against independent tests")
    cand.add_argument("path")
    sub.add_parser("verify-audit")
    sub.add_parser("eval", help="run the evaluation suite and write reports/")
    a = ap.parse_args(argv)

    if a.cmd == "reset":
        _, dg = demo.reset()
        print(json.dumps(dg, indent=2))
        return 0
    if a.cmd == "demo":
        demo.run_demo(mode=a.mode)
        return 0
    if a.cmd == "serve":
        from .server import serve
        serve(a.host, a.port)
        return 0
    if a.cmd == "eval":
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from eval.run_eval import main as run_eval
        return run_eval()
    if a.cmd == "candidate":
        print(json.dumps(opa.evaluate_candidate(Path(a.path).read_text()), indent=2))
        return 0
    conn = db.connect()
    if a.cmd == "import-model":
        r = importer.import_model(conn, a.actor, Path(a.path).read_bytes())
    elif a.cmd == "import-evidence":
        r = importer.import_evidence_dir(conn, a.actor, Path(a.dir))
    elif a.cmd == "build":
        r = packages.build_package(conn, a.actor, demo.PROJECT, mode=a.mode)
    elif a.cmd == "status":
        r = packages.status(conn, a.package_id)
    elif a.cmd == "review":
        p = packages.get(conn, a.package_id)
        st = packages.status(conn, a.package_id)
        r = review.decide(conn, a.actor, a.package_id, a.decision, a.reason,
                          seen_package_digest=p["package_digest"], seen_head_decision_id=st["head_decision"])
    elif a.cmd == "export":
        r = export.export_package(conn, a.actor, a.package_id, mode=a.mode)
    elif a.cmd == "impact":
        r = impact.impact_report(conn, demo.PROJECT, a.from_snapshot, a.to_snapshot)
    elif a.cmd == "verify-audit":
        r = db.verify_audit_chain(conn)
    print(json.dumps(r, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
